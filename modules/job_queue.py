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
        self.image_count = _job_image_count(job_type, args)
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
        self._paused = False

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

    def pause(self):
        with self._lock:
            self._paused = True

    def resume(self):
        with self._lock:
            self._paused = False

    def is_paused(self) -> bool:
        with self._lock:
            return self._paused

    def move_job(self, job_id: str, direction: str) -> bool:
        if direction not in {"up", "down"}:
            return False

        with self._lock:
            idx = next((i for i, job in enumerate(self._jobs) if job.id == job_id), None)
            if idx is None:
                return False

            job = self._jobs[idx]
            if job.status != "queued":
                return False

            step = -1 if direction == "up" else 1
            swap_idx = idx + step
            while 0 <= swap_idx < len(self._jobs):
                if self._jobs[swap_idx].status == "queued":
                    self._jobs[idx], self._jobs[swap_idx] = self._jobs[swap_idx], self._jobs[idx]
                    return True
                swap_idx += step

        return False

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

            if self.is_paused():
                continue

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


def _safe_int(value, default=1):
    try:
        return max(1, int(value or default))
    except Exception:
        return default


def _job_image_count(job_type: str, args: tuple) -> int:
    if job_type == "txt2img":
        if len(args) > 4:
            return _safe_int(args[3]) * _safe_int(args[4])
        return 1

    if job_type == "img2img":
        if len(args) > 15:
            return _safe_int(args[14]) * _safe_int(args[15])
        return 1

    return 1


def is_queue_task_id(id_task: str | None) -> bool:
    return bool(id_task and id_task.startswith("task(queue-"))


def ensure_manual_generation_allowed(id_task: str | None):
    if is_queue_task_id(id_task):
        return

    if queue_manager.has_running_job():
        raise gr.Error("A queued job is currently running. Please wait for it to finish before using Generate.")


def _parse_batch_steps(batch_steps_str):
    """Parse comma-separated step values. Returns list of integers or empty list if invalid."""
    if not batch_steps_str or not isinstance(batch_steps_str, str):
        return []
    
    batch_steps_str = batch_steps_str.strip()
    if not batch_steps_str:
        return []
    
    steps = []
    try:
        # Split by comma and parse each part
        for s in batch_steps_str.split(','):
            s = s.strip()
            if s:
                val = int(s)
                # Validate step range
                if 1 <= val <= 150:
                    steps.append(val)
    except (ValueError, AttributeError) as e:
        # If parsing fails, return empty list
        return []
    
    return steps


def _find_batch_and_steps_indices(job_args):
    """Dynamically find batch_steps and steps indices in job_args.
    Returns (batch_steps_index, steps_index) or (None, None) if not found.
    
    Strategy: Look for a string followed by a number that looks like steps (1-150 range).
    The batch_steps textbox and steps slider should be consecutive in custom_inputs.
    We search from near the end since custom_inputs are appended at the end.
    """
    # Search from the last 50 items (to avoid false positives with hr_prompt etc)
    search_start = max(0, len(job_args) - 50)
    
    for i in range(search_start, len(job_args) - 1):
        arg = job_args[i]
        next_arg = job_args[i + 1]
        
        # batch_steps should be a string (could be empty or contain commas)
        if not isinstance(arg, str):
            continue
        
        # Next should be a step value (int or convertible)
        try:
            step_value = int(next_arg) if next_arg is not None else None
            # Steps typically range from 1-150
            if step_value is not None and 1 <= step_value <= 150:
                # Verify arg looks like batch_steps (empty, all digits with commas/spaces, or numbers)
                arg_stripped = arg.strip()
                if arg_stripped == "" or all(c.isdigit() or c in ", " for c in arg_stripped):
                    # Additional check: make sure we're not picking up some other random string
                    # by verifying it's not too long and doesn't contain weird characters
                    if len(arg_stripped) <= 50:
                        return i, i + 1
        except (ValueError, TypeError):
            pass
    
    return None, None


def _add_batch_jobs(job_type, job_args, batch_steps_list, prompt):
    """Add multiple jobs with different step values.
    
    Args:
        job_type: "txt2img" or "img2img"
        job_args: tuple of all arguments from the UI
        batch_steps_list: list of step values to queue
        prompt: prompt text for labeling
        
    Returns:
        list of QueueJob objects created
    """
    batch_idx, steps_idx = _find_batch_and_steps_indices(job_args)
    
    # If we can't find the indices or no batch steps provided, add single job
    if steps_idx is None or not batch_steps_list or len(batch_steps_list) < 1:
        job = queue_manager.add_job(job_type, job_args, label=str(prompt)[:80])
        return [job]
    
    jobs = []
    for step_value in batch_steps_list:
        try:
            # Create a copy of job_args with the new step value
            modified_args = list(job_args)
            modified_args[steps_idx] = step_value
            
            # Also clear batch_steps field after processing to prevent re-queuing
            if batch_idx is not None and batch_idx < len(modified_args):
                modified_args[batch_idx] = ""
            
            # Create label with prompt and step value
            label = f"{str(prompt)[:50]}...steps={step_value}" if prompt else f"steps={step_value}"
            label = label[:80]  # Truncate to max label length
            
            job = queue_manager.add_job(job_type, tuple(modified_args), label=label)
            jobs.append(job)
        except Exception as e:
            # If something goes wrong with one job, still try the others
            continue
    
    # If all jobs failed, fall back to single job with original args
    if not jobs:
        job = queue_manager.add_job(job_type, job_args, label=str(prompt)[:80])
        jobs.append(job)
    
    return jobs


def add_to_queue_txt2img(*args):
    job_args = args[1:]
    prompt = job_args[0] if job_args else ""
    
    # Find batch_steps position dynamically
    batch_idx, steps_idx = _find_batch_and_steps_indices(job_args)
    batch_steps_str = ""
    if batch_idx is not None and batch_idx < len(job_args):
        batch_steps_str = job_args[batch_idx] if isinstance(job_args[batch_idx], str) else ""
    
    batch_steps_list = _parse_batch_steps(batch_steps_str)
    
    if batch_steps_list and len(batch_steps_list) > 1:
        # Multiple batch steps: add multiple jobs
        jobs = _add_batch_jobs("txt2img", job_args, batch_steps_list, prompt)
        queued = sum(1 for j in queue_manager.get_snapshot() if j.status == "queued")
        return f'<span class="jq-notice">txt2img queued: {len(jobs)} jobs with steps {batch_steps_str} ({queued} total waiting)</span>'
    else:
        # Single or no batch steps: add one job as normal
        job = queue_manager.add_job("txt2img", job_args, label=str(prompt)[:80])
        queued = sum(1 for j in queue_manager.get_snapshot() if j.status == "queued")
        return f'<span class="jq-notice">txt2img queued: <code>{job.id}</code> ({queued} waiting)</span>'


def add_to_queue_img2img(*args):
    job_args = args[1:]
    prompt = job_args[1] if len(job_args) > 1 else ""
    
    # Find batch_steps position dynamically
    batch_idx, steps_idx = _find_batch_and_steps_indices(job_args)
    batch_steps_str = ""
    if batch_idx is not None and batch_idx < len(job_args):
        batch_steps_str = job_args[batch_idx] if isinstance(job_args[batch_idx], str) else ""
    
    batch_steps_list = _parse_batch_steps(batch_steps_str)
    
    if batch_steps_list and len(batch_steps_list) > 1:
        # Multiple batch steps: add multiple jobs
        jobs = _add_batch_jobs("img2img", job_args, batch_steps_list, prompt)
        queued = sum(1 for j in queue_manager.get_snapshot() if j.status == "queued")
        return f'<span class="jq-notice">img2img queued: {len(jobs)} jobs with steps {batch_steps_str} ({queued} total waiting)</span>'
    else:
        # Single or no batch steps: add one job as normal
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
    is_paused = queue_manager.is_paused()
    queue_state_class = "jq-s-paused" if is_paused else "jq-s-done"
    queue_state_label = "Paused" if is_paused else "Active"
    counts = {"queued": 0, "running": 0, "done": 0, "failed": 0}
    for j in jobs:
        counts[j.status] = counts.get(j.status, 0) + 1

    running_job = next((j for j in jobs if j.status == "running"), None)
    running_task_id = html.escape(running_job.task_id if running_job else "")
    running_type = html.escape(running_job.job_type if running_job else "")
    running_image_count = int(running_job.image_count) if running_job else 0

    stats = (
        f'<div id="jq-state" data-running-task-id="{running_task_id}" data-running-job-type="{running_type}" data-running-image-count="{running_image_count}"></div>'
        '<div class="jq-stats">'
        f'<span class="jq-stat {queue_state_class}">Queue: {queue_state_label}</span>'
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
            f'<td data-label="ID"><code class="jq-id">{j.id}</code></td>'
            f'<td data-label="Type">{html.escape(j.job_type)}</td>'
            f'<td class="jq-lbl" data-label="Prompt">{lbl}{err}</td>'
            f'<td data-label="Status">{icon} {j.status}</td>'
            f'<td data-label="Created">{_fmt_time(j.created_at)}</td>'
            f'<td data-label="Finished">{_fmt_time(j.finished_at) or "-"}</td>'
            f'<td class="jq-actions" data-label="Actions">{_row_action_buttons(j)}</td>'
            "</tr>"
        )

    table = (
        '<table class="jq-table">'
        "<thead><tr>"
        "<th>ID</th><th>Type</th><th>Prompt</th><th>Status</th>"
        "<th>Created</th><th>Finished</th><th>Actions</th>"
        "</tr></thead>"
        f'<tbody>{"".join(rows)}</tbody>'
        "</table>"
    )
    return stats + table


def _row_action_buttons(job: QueueJob) -> str:
    job_id = html.escape(job.id)
    if job.status == "queued":
        return (
            f'<button class="jq-row-btn" onclick="queueTabAction(\'move_up\', \'{job_id}\')">Up</button>'
            f'<button class="jq-row-btn" onclick="queueTabAction(\'move_down\', \'{job_id}\')">Down</button>'
            f'<button class="jq-row-btn jq-row-btn-danger" onclick="queueTabAction(\'remove\', \'{job_id}\')">Remove</button>'
        )

    if job.status in {"done", "failed"}:
        return f'<button class="jq-row-btn jq-row-btn-danger" onclick="queueTabAction(\'remove\', \'{job_id}\')">Remove</button>'

    return '<span class="jq-row-muted">Running</span>'


def handle_queue_action(action_json: str):
    import json

    try:
        payload = json.loads(action_json or "{}")
    except Exception:
        payload = {}

    action = (payload.get("action") or "").strip().lower()
    job_id = (payload.get("job_id") or "").strip()

    if action == "remove" and job_id:
        queue_manager.remove_job(job_id)
        message = f"Removed job {job_id} if it was removable."
    elif action == "move_up" and job_id:
        moved = queue_manager.move_job(job_id, "up")
        message = f"Moved job {job_id} up." if moved else f"Could not move job {job_id} up."
    elif action == "move_down" and job_id:
        moved = queue_manager.move_job(job_id, "down")
        message = f"Moved job {job_id} down." if moved else f"Could not move job {job_id} down."
    else:
        message = "No queue action performed."

    return render_queue_html(), f'<span style="color:var(--body-text-color-subdued,#94a3b8)">{html.escape(message)}</span>'


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
            interrupt_current_btn = gr.Button("Interrupt Current Job", elem_id="jq_interrupt_current_btn", scale=1)
            pause_btn = gr.Button("Pause Queue", elem_id="jq_pause_btn", scale=1)
            resume_btn = gr.Button("Resume Queue", elem_id="jq_resume_btn", scale=1)
            clear_done_btn = gr.Button("Clear Completed/Failed", scale=1)
            clear_queued_btn = gr.Button("Clear All Queued", scale=1)

        queue_html_out = gr.HTML(value=render_queue_html, elem_id="jq_queue_html")
        action_input = gr.Textbox(value="", visible=False, elem_id="jq_action_input")
        action_btn = gr.Button("", visible=False, elem_id="jq_action_btn")

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

        def do_pause():
            queue_manager.pause()
            return render_queue_html(), '<span style="color:var(--body-text-color-subdued,#94a3b8)">Queue paused. Current running job continues.</span>'

        def do_resume():
            queue_manager.resume()
            return render_queue_html(), '<span style="color:var(--body-text-color-subdued,#94a3b8)">Queue resumed.</span>'

        def do_interrupt_current():
            active_job = bool(getattr(shared.state, "job", ""))
            active_count = int(getattr(shared.state, "job_count", 0) or 0)
            if not active_job and active_count <= 0:
                return render_queue_html(), '<span style="color:var(--body-text-color-subdued,#94a3b8)">No running job to interrupt.</span>'

            shared.state.interrupt()
            return render_queue_html(), '<span style="color:var(--error-text-color,#ef4444)">Interrupt requested for current running job.</span>'

        def do_remove(job_id: str):
            job_id = job_id.strip()
            if not job_id:
                return render_queue_html(), '<span style="color:var(--error-text-color,red)">Please enter a job ID.</span>'

            queue_manager.remove_job(job_id)
            return render_queue_html(), '<span style="color:var(--success-text-color,green)">Removed (if it existed and was not running).</span>'

        refresh_btn.click(fn=do_refresh, inputs=[], outputs=[queue_html_out], show_progress="hidden")
        interrupt_current_btn.click(fn=do_interrupt_current, inputs=[], outputs=[queue_html_out, remove_status], show_progress="hidden")
        pause_btn.click(fn=do_pause, inputs=[], outputs=[queue_html_out, remove_status])
        resume_btn.click(fn=do_resume, inputs=[], outputs=[queue_html_out, remove_status])
        clear_done_btn.click(fn=do_clear_done, inputs=[], outputs=[queue_html_out])
        clear_queued_btn.click(fn=do_clear_queued, inputs=[], outputs=[queue_html_out])
        remove_btn.click(fn=do_remove, inputs=[remove_id_input], outputs=[queue_html_out, remove_status])
        action_btn.click(fn=handle_queue_action, inputs=[action_input], outputs=[queue_html_out, remove_status], show_progress="hidden")

    return [(queue_ui, "Queue", "job_queue_tab")]


def register_callbacks():
    callbacks = script_callbacks.callback_map.get("callbacks_ui_tabs", [])
    already_registered = any(getattr(cb, "name", "") == "job_queue_tab" for cb in callbacks)
    if already_registered:
        return

    script_callbacks.on_ui_tabs(on_ui_tabs, name="job_queue_tab")
