import html
import threading
import time
import traceback
import uuid
from types import SimpleNamespace

import gradio as gr

from modules import errors, script_callbacks, shared
from modules.call_queue import queue_lock


class QueueJob:
    def __init__(self, job_type: str, args: tuple, label: str = ""):
        self.id = uuid.uuid4().hex[:8]
        self.job_type = job_type
        self.args = args
        self.status = "queued"
        self.label = label
        self.task_id = ""
        self.created_at = time.time()
        # Grace window prevents a just-clicked Queue action from racing ahead of
        # a nearly simultaneous manual Generate request.
        self.ready_at = self.created_at + 1.5
        self.finished_at = None
        self.error = None


class JobQueueManager:
    def __init__(self):
        self._jobs: list[QueueJob] = []
        self._lock = threading.Lock()
        self._started = False

    def start(self):
        if self._started:
            return

        self._started = True
        threading.Thread(target=self._dispatch_loop, daemon=True, name="job-queue-dispatcher").start()

    def add_job(self, job_type: str, args: tuple, label: str = "") -> QueueJob:
        job = QueueJob(job_type=job_type, args=args, label=label)
        with self._lock:
            self._jobs.append(job)
        return job

    def get_snapshot(self) -> list[QueueJob]:
        with self._lock:
            return list(self._jobs)

    def remove_job(self, job_id: str):
        with self._lock:
            self._jobs = [
                j for j in self._jobs
                if not (j.id == job_id and j.status in ("queued", "done", "failed"))
            ]

    def clear_completed(self):
        with self._lock:
            self._jobs = [j for j in self._jobs if j.status not in ("done", "failed")]

    def clear_queued(self):
        with self._lock:
            self._jobs = [j for j in self._jobs if j.status != "queued"]

    def has_running_job(self) -> bool:
        with self._lock:
            return any(j.status == "running" for j in self._jobs)

    def _non_queue_generation_active(self) -> bool:
        active_job = getattr(shared.state, "job", "")
        if shared.state.job_count > 0:
            return not is_queue_task_id(active_job)

        return bool(active_job and not is_queue_task_id(active_job))

    def _get_next_queued(self) -> QueueJob | None:
        now = time.time()
        with self._lock:
            for j in self._jobs:
                if j.status == "queued" and now >= j.ready_at:
                    return j
        return None

    def _dispatch_loop(self):
        while True:
            time.sleep(0.5)

            # Never let queued jobs preempt a currently-running manual generate job.
            if self._non_queue_generation_active():
                continue

            job = self._get_next_queued()
            if job is not None:
                self._dispatch_job(job)

    def _dispatch_job(self, job: QueueJob):
        import modules.img2img
        import modules.txt2img
        from modules import progress as progress_module

        task_id = f"task(queue-{job.id})"
        fake_request = SimpleNamespace(
            username="queue",
            client=SimpleNamespace(host="127.0.0.1"),
        )

        with self._lock:
            job.task_id = task_id

        progress_module.add_task_to_queue(task_id)

        with queue_lock:
            if self._non_queue_generation_active():
                return

            with self._lock:
                if job.status != "queued":
                    return
                job.status = "running"

            shared.state.begin(job=task_id)
            progress_module.start_task(task_id)
            try:
                if job.job_type == "txt2img":
                    res = modules.txt2img.txt2img(task_id, fake_request, *job.args)
                elif job.job_type == "img2img":
                    res = modules.img2img.img2img(task_id, fake_request, *job.args)
                else:
                    raise RuntimeError(f"Unknown queue job type: {job.job_type}")

                progress_module.record_results(task_id, res)
                with self._lock:
                    job.status = "done"
                    job.finished_at = time.time()
            except Exception:
                errors.report(f"[Job Queue] Error dispatching job {job.id}", exc_info=True)
                with self._lock:
                    job.status = "failed"
                    job.error = traceback.format_exc().strip().splitlines()[-1]
                    job.finished_at = time.time()
            finally:
                progress_module.finish_task(task_id)
                shared.state.end()


queue_manager = JobQueueManager()


def is_queue_task_id(id_task: str | None) -> bool:
    return bool(id_task and id_task.startswith("task(queue-"))


def ensure_manual_generation_allowed(id_task: str | None):
    if is_queue_task_id(id_task):
        return

    if queue_manager.has_running_job():
        raise gr.Error("A queued job is currently running. Please wait for it to finish before using Generate.")


def add_to_queue_txt2img(*args):
    job_args = args[1:]
    prompt = job_args[0] if job_args else ""
    job = queue_manager.add_job("txt2img", job_args, label=str(prompt)[:80])
    queued = sum(1 for j in queue_manager.get_snapshot() if j.status == "queued")
    return f'<span class="jq-notice">txt2img queued: <code>{job.id}</code> ({queued} waiting)</span>'


def add_to_queue_img2img(*args):
    job_args = args[1:]
    prompt = job_args[1] if len(job_args) > 1 else ""
    job = queue_manager.add_job("img2img", job_args, label=str(prompt)[:80])
    queued = sum(1 for j in queue_manager.get_snapshot() if j.status == "queued")
    return f'<span class="jq-notice">img2img queued: <code>{job.id}</code> ({queued} waiting)</span>'


def _fmt_time(ts):
    if ts is None:
        return ""

    import datetime
    return datetime.datetime.fromtimestamp(ts).strftime("%H:%M:%S")


def render_queue_html() -> str:
    jobs = queue_manager.get_snapshot()
    counts = {"queued": 0, "running": 0, "done": 0, "failed": 0}
    for j in jobs:
        counts[j.status] = counts.get(j.status, 0) + 1

    running_job = next((j for j in jobs if j.status == "running"), None)
    running_task_id = html.escape(running_job.task_id if running_job else "")
    running_type = html.escape(running_job.job_type if running_job else "")

    stats = (
        f'<div id="jq-state" data-running-task-id="{running_task_id}" data-running-job-type="{running_type}"></div>'
        '<div class="jq-stats">'
        f'<span class="jq-stat jq-s-queued">Queued: {counts["queued"]}</span>'
        f'<span class="jq-stat jq-s-running">Running: {counts["running"]}</span>'
        f'<span class="jq-stat jq-s-done">Done: {counts["done"]}</span>'
        f'<span class="jq-stat jq-s-failed">Failed: {counts["failed"]}</span>'
        "</div>"
    )

    if not jobs:
        return stats + '<div class="jq-empty">No jobs in queue.</div>'

    rows = []
    for j in reversed(jobs):
        icon = {"queued": "Q", "running": "R", "done": "D", "failed": "F"}.get(j.status, "?")
        lbl = html.escape(j.label[:70]) if j.label else "<em>(no prompt)</em>"
        err = f'<br><small class="jq-error">{html.escape(str(j.error))}</small>' if j.error else ""
        rows.append(
            f'<tr class="jq-row jq-s-{j.status}" data-task-id="{html.escape(j.task_id)}" data-job-type="{html.escape(j.job_type)}">'
            f'<td><code class="jq-id">{j.id}</code></td>'
            f'<td>{html.escape(j.job_type)}</td>'
            f'<td class="jq-lbl">{lbl}{err}</td>'
            f'<td>{icon} {j.status}</td>'
            f'<td>{_fmt_time(j.created_at)}</td>'
            f'<td>{_fmt_time(j.finished_at) or "-"}</td>'
            "</tr>"
        )

    table = (
        '<table class="jq-table">'
        "<thead><tr>"
        "<th>ID</th><th>Type</th><th>Prompt</th><th>Status</th>"
        "<th>Created</th><th>Finished</th>"
        "</tr></thead>"
        f'<tbody>{"".join(rows)}</tbody>'
        "</table>"
    )
    return stats + table


def on_ui_tabs():
    with gr.Blocks(analytics_enabled=False) as queue_ui:
        gr.HTML(
            '<h2 style="margin:8px 0 4px">Job Queue</h2>'
            '<p style="margin:0 0 12px;color:var(--body-text-color-subdued,#888)">'
            "Queued jobs are dispatched automatically when generation is available."
            "</p>"
        )

        with gr.Row():
            refresh_btn = gr.Button("Refresh", elem_id="jq_refresh_btn", scale=1)
            clear_done_btn = gr.Button("Clear Completed/Failed", scale=1)
            clear_queued_btn = gr.Button("Clear All Queued", scale=1)

        queue_html_out = gr.HTML(value=render_queue_html, elem_id="jq_queue_html")

        with gr.Row():
            remove_id_input = gr.Textbox(
                label="Job ID to remove",
                placeholder="Enter 8-char job ID",
                scale=3,
                elem_id="jq_remove_id",
            )
            remove_btn = gr.Button("Remove Job", scale=1)

        remove_status = gr.HTML("", elem_id="jq_remove_status")

        def do_refresh():
            return render_queue_html()

        def do_clear_done():
            queue_manager.clear_completed()
            return render_queue_html()

        def do_clear_queued():
            queue_manager.clear_queued()
            return render_queue_html()

        def do_remove(job_id: str):
            job_id = job_id.strip()
            if not job_id:
                return render_queue_html(), '<span style="color:var(--error-text-color,red)">Please enter a job ID.</span>'

            queue_manager.remove_job(job_id)
            return render_queue_html(), '<span style="color:var(--success-text-color,green)">Removed (if it existed and was not running).</span>'

        refresh_btn.click(fn=do_refresh, inputs=[], outputs=[queue_html_out])
        clear_done_btn.click(fn=do_clear_done, inputs=[], outputs=[queue_html_out])
        clear_queued_btn.click(fn=do_clear_queued, inputs=[], outputs=[queue_html_out])
        remove_btn.click(fn=do_remove, inputs=[remove_id_input], outputs=[queue_html_out, remove_status])

    return [(queue_ui, "Queue", "job_queue_tab")]


_callbacks_registered = False


def register_callbacks():
    global _callbacks_registered

    if _callbacks_registered:
        return

    script_callbacks.on_ui_tabs(on_ui_tabs, name="job_queue_tab")
    _callbacks_registered = True
