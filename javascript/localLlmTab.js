(function () {
  const defaultUrl = "http://127.0.0.1:7820/";

  function setupLocalLlmTab(root) {
    if (!root || root.dataset.localLlmReady === "1") return;

    const urlInput = root.querySelector("#local_llm_embed_url");
    const reloadBtn = root.querySelector("#local_llm_embed_reload");
    const openLink = root.querySelector("#local_llm_embed_open");
    const frame = root.querySelector("#local_llm_embed_frame");
    const overlay = root.querySelector("#local_llm_embed_overlay");
    const signalInput = (typeof gradioApp === "function" ? gradioApp() : document).querySelector("#local_llm_embed_signal textarea");
    if (!urlInput || !reloadBtn || !openLink || !frame || !overlay) return;

    root.dataset.localLlmReady = "1";

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

  function initAllLocalLlmTabs() {
    document.querySelectorAll("#local_llm_embed_root").forEach((root) => setupLocalLlmTab(root));
  }

  const observer = new MutationObserver(function () {
    initAllLocalLlmTabs();
  });

  observer.observe(document.documentElement, { childList: true, subtree: true });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () {
      setTimeout(initAllLocalLlmTabs, 250);
    });
  } else {
    setTimeout(initAllLocalLlmTabs, 250);
  }
})();