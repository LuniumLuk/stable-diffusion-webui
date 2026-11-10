// Live progress for the Video tab (scripts/video_tab.py).
//
// The Generate callback blocks until the clip is encoded: this fork runs with
// --no-gradio-queue, so gradio cannot stream a generator.  The job phase is
// polled from /mlite/api/video/job instead and drawn into an element of our own
// that lives next to #video_progress, so gradio's final HTML stays authoritative.
(function () {
  const ACTIVE_PHASES = ["loading", "generating", "saving"];
  const PHASE_LABELS = {
    loading: "loading model",
    generating: "generating",
    saving: "encoding GIF/MP4",
  };

  let box = null;
  let timer = 0;
  let hardStop = 0;
  let stopped = false;
  let sawActive = false;
  let polls = 0;
  let baseline = "";

  function app() {
    return typeof gradioApp === "function" ? gradioApp() : document;
  }

  function escapeHtml(text) {
    return String(text == null ? "" : text).replace(/[&<>"']/g, function (ch) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch];
    });
  }

  function progressHtml(job) {
    const step = Math.max(0, Math.round(Number(job.step) || 0));
    const steps = Math.max(0, Math.round(Number(job.steps) || 0));
    const pct = steps ? Math.round((100 * step) / steps) : 0;
    const started = Number(job.started) || 0;
    const elapsed = started ? Math.max(0, Date.now() / 1000 - started) : 0;

    const parts = [PHASE_LABELS[job.phase] || "working"];
    if (job.engine) parts.push(String(job.engine));
    if (job.detail) parts.push(String(job.detail));
    parts.push(elapsed.toFixed(0) + "s");

    return (
      '<div class="video-progress">' +
      '<div class="video-progress-bar"><div style="width:' + Math.max(4, pct) + '%"></div></div>' +
      "<span>" + escapeHtml(parts.join(" \u00b7 ")) + "</span></div>"
    );
  }

  function ensureBox() {
    if (box && box.isConnected) return box;

    const anchor = app().querySelector("#video_progress");
    if (!anchor || !anchor.parentNode) return null;

    box = document.createElement("div");
    box.className = "video-live-progress";
    anchor.parentNode.insertBefore(box, anchor);
    return box;
  }

  function render(html) {
    const target = ensureBox();
    if (target) target.innerHTML = html;
  }

  function stop() {
    stopped = true;
    if (timer) clearInterval(timer);
    if (hardStop) clearTimeout(hardStop);
    timer = 0;
    hardStop = 0;
    // remove every line we may have left behind, including a node whose parent
    // gradio re-rendered away from us
    app().querySelectorAll(".video-live-progress").forEach(function (node) {
      node.remove();
    });
    box = null;
  }

  function resultText() {
    const el = app().querySelector("#video_result_status");
    return el ? el.innerText.trim() : "";
  }

  async function poll() {
    polls += 1;
    try {
      const response = await fetch("./mlite/api/video/job", {
        headers: { Accept: "application/json" },
        cache: "no-store",
      });
      const job = await response.json();
      if (stopped) return;

      if (job && ACTIVE_PHASES.indexOf(job.phase) !== -1) {
        sawActive = true;
        render(progressHtml(job));
        return;
      }

      // The callback answered (the result view changed) or its job ended: drop
      // our line and let the gradio result view show the outcome.
      if (sawActive || resultText() !== baseline) {
        stop();
        return;
      }

      // No job ever started (invalid input rejected before the engine ran).
      if (polls > 15) stop();
    } catch (_error) {
      if (polls > 15) stop();
    }
  }

  function start() {
    stop();
    stopped = false;
    sawActive = false;
    polls = 0;
    baseline = resultText();
    render('<p class="muted">starting the video job\u2026</p>');
    timer = setInterval(poll, 900);
    hardStop = setTimeout(stop, 90 * 60 * 1000);
    poll();
  }

  function bind() {
    const button = app().querySelector("#video_generate_btn");
    if (!button || button.dataset.videoProgressReady === "1") return;
    button.dataset.videoProgressReady = "1";
    button.addEventListener("click", start);
  }

  const observer = new MutationObserver(bind);
  observer.observe(document.documentElement, { childList: true, subtree: true });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () {
      setTimeout(bind, 250);
    });
  } else {
    setTimeout(bind, 250);
  }

  // exposed so a probe / console can rebind after a UI reload
  window.videoTabProgress = { bind: bind };
})();
