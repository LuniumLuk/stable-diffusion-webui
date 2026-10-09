(function () {
  const defaultUrl = "http://127.0.0.1:7864/";

  function setupKrea2ImageTab(root) {
    if (!root || root.dataset.krea2ImageReady === "1") return;

    const urlInput = root.querySelector("#krea2_image_embed_url");
    const reloadBtn = root.querySelector("#krea2_image_embed_reload");
    const openLink = root.querySelector("#krea2_image_embed_open");
    const frame = root.querySelector("#krea2_image_embed_frame");
    const overlay = root.querySelector("#krea2_image_embed_overlay");
    const signalInput = (typeof gradioApp === "function" ? gradioApp() : document).querySelector("#krea2_image_embed_signal textarea");
    if (!urlInput || !reloadBtn || !openLink || !frame || !overlay) return;

    root.dataset.krea2ImageReady = "1";

    function normalizeUrl(url) {
      const raw = String(url || "").trim() || defaultUrl;
      return raw.endsWith("/") ? raw : raw + "/";
    }

    function setReachable(reachable) {
      if (reachable) {
        overlay.classList.remove("show");
      } else {
        overlay.classList.add("show");
      }
    }

    function applyUrl(url) {
      const normalized = normalizeUrl(url);
      urlInput.value = normalized;
      openLink.href = normalized;
      setReachable(false);
      frame.src = normalized;
    }

    function applySignalPayload(payloadText) {
      if (!payloadText) return;
      try {
        const payload = JSON.parse(payloadText);
        const targetUrl = normalizeUrl(payload.url || urlInput.value || defaultUrl);
        urlInput.value = targetUrl;
        openLink.href = targetUrl;

        if (payload.action === "stop") {
          setReachable(false);
          return;
        }

        if (payload.action === "start" || payload.action === "restart") {
          frame.src = targetUrl;
          // Keep overlay visible until iframe confirms load.
          setReachable(false);
          return;
        }

        if (typeof payload.reachable === "boolean") {
          setReachable(payload.reachable);
        }
      } catch (_err) {
        setReachable(false);
      }
    }

    reloadBtn.addEventListener("click", function () {
      applyUrl(urlInput.value);
    });

    urlInput.addEventListener("keydown", function (evt) {
      if (evt.key === "Enter") {
        evt.preventDefault();
        applyUrl(urlInput.value);
      }
    });

    frame.addEventListener("load", function () {
      setReachable(true);
    });

    frame.addEventListener("error", function () {
      setReachable(false);
    });

    if (signalInput) {
      let lastSignal = signalInput.value || "";
      const observer = new MutationObserver(function () {
        const nextValue = signalInput.value || "";
        if (nextValue && nextValue !== lastSignal) {
          lastSignal = nextValue;
          applySignalPayload(nextValue);
        }
      });

      observer.observe(signalInput, {
        attributes: true,
        attributeFilter: ["value"],
      });

      signalInput.addEventListener("input", function () {
        const nextValue = signalInput.value || "";
        if (nextValue && nextValue !== lastSignal) {
          lastSignal = nextValue;
          applySignalPayload(nextValue);
        }
      });
    }

    applySignalPayload(signalInput ? signalInput.value : "");
    applyUrl(urlInput.value || defaultUrl);
  }

  const KREA2_PHASE_LABELS = {
    preparing: "loading the model / waiting for the GPU...",
    queued: "queued...",
    generating: "generating...",
    saving: "saving...",
  };

  function krea2Escape(text) {
    return String(text == null ? "" : text).replace(/[&<>"']/g, function (ch) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch];
    });
  }

  function krea2Elapsed(seconds) {
    const total = Math.max(0, Math.round(Number(seconds) || 0));
    const minutes = Math.floor(total / 60);
    return minutes > 0 ? minutes + "m " + String(total % 60).padStart(2, "0") + "s" : total + "s";
  }

  function krea2EtaLabel(seconds) {
    const total = Math.max(0, Math.round(Number(seconds) || 0));
    if (total < 60) return "~" + total + "s";
    if (total < 3600) return "~" + Math.floor(total / 60) + "m " + String(total % 60).padStart(2, "0") + "s";
    return "~" + Math.floor(total / 3600) + "h " + String(Math.floor((total % 3600) / 60)).padStart(2, "0") + "m";
  }

  // Sampling / decoding sub-phase text: the sd-server has no progress API, so the
  // bridge parses the step bars out of its stdout log and the job endpoint exposes
  // them, plus the bridge's learned ETA (current image and whole batch).
  function krea2PhaseText(data) {
    if (data.phase === "generating") {
      let text = "";
      if (data.vae_step && data.vae_steps) text = "decoding " + data.vae_step + "/" + data.vae_steps;
      else if (data.sampling_step && data.sampling_steps) text = "sampling " + data.sampling_step + "/" + data.sampling_steps;
      if (text) {
        if (data.eta_current != null) text += " - ETA " + krea2EtaLabel(data.eta_current);
        const batch = Number(data.batch_total) || 1;
        if (batch > 1) {
          const image = Math.min(batch, (Number(data.images_done) || 0) + 1);
          text += " - image " + image + "/" + batch;
          if (data.eta_total != null) text += " - total ETA " + krea2EtaLabel(data.eta_total);
        }
        return text;
      }
    }
    return KREA2_PHASE_LABELS[data.phase] || "krea2...";
  }

  // Live phase line for the native panel: the Generate callback blocks until the job is
  // done, so the phase is polled from /mlite/api/krea2/job (only one krea2 job can run).
  function setupKrea2TaskStatus() {
    const app = typeof gradioApp === "function" ? gradioApp() : document;
    const statusEl = app.querySelector("#krea2_task_status");
    const generateBtn = app.querySelector("#krea2_generate_btn");
    if (!statusEl || !generateBtn || generateBtn.dataset.krea2StatusReady === "1") return;
    generateBtn.dataset.krea2StatusReady = "1";

    let timer = 0;
    let hardStop = 0;
    let sawActive = false;
    let polls = 0;

    function render(html, isError) {
      statusEl.innerHTML = html ? '<div class="krea2-task-line' + (isError ? " err" : "") + '">' + html + "</div>" : "";
    }

    function stop() {
      if (timer) clearInterval(timer);
      if (hardStop) clearTimeout(hardStop);
      timer = 0;
      hardStop = 0;
    }

    async function poll() {
      polls += 1;
      try {
        const response = await fetch("./mlite/api/krea2/job", { headers: { Accept: "application/json" }, cache: "no-store" });
        const data = await response.json();
        if (data && data.active) {
          sawActive = true;
          const retry = data.attempt > 1 ? " - retry " + data.attempt : "";
          render(krea2PhaseText(data) + ' <span class="muted">(' + krea2Elapsed(data.elapsed) + retry + ")</span>", false);
          return;
        }
        if (sawActive) {
          stop();
          if (data && data.phase === "failed") {
            render("krea2 failed: " + krea2Escape(data.error || "unknown error"), true);
          } else {
            render("", false);
          }
          return;
        }
        if (polls > 22) {
          // the callback never started a job (invalid input / immediate error) -
          // the result Markdown carries the message
          stop();
          render("", false);
        }
      } catch (_error) {
        if (polls > 22) {
          stop();
          render("", false);
        }
      }
    }

    generateBtn.addEventListener("click", function () {
      stop();
      sawActive = false;
      polls = 0;
      render('<span class="muted">sending...</span>', false);
      timer = setInterval(poll, 900);
      hardStop = setTimeout(function () { stop(); render("", false); }, 45 * 60 * 1000);
      poll();
    });
  }

  function initAllKrea2ImageTabs() {
    document.querySelectorAll("#krea2_image_embed_root").forEach((root) => setupKrea2ImageTab(root));
    setupKrea2TaskStatus();
  }

  const observer = new MutationObserver(function () {
    initAllKrea2ImageTabs();
  });

  observer.observe(document.documentElement, { childList: true, subtree: true });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () {
      setTimeout(initAllKrea2ImageTabs, 250);
    });
  } else {
    setTimeout(initAllKrea2ImageTabs, 250);
  }

  // exposed so a probe / console can rebind after a UI reload
  window.krea2TaskStatus = { setup: setupKrea2TaskStatus };
})();
