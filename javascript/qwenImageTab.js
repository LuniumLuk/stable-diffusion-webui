(function () {
  const defaultUrl = "http://127.0.0.1:7862/";

  function setupQwenImageTab(root) {
    if (!root || root.dataset.qwenImageReady === "1") return;

    const urlInput = root.querySelector("#qwen_image_embed_url");
    const reloadBtn = root.querySelector("#qwen_image_embed_reload");
    const openLink = root.querySelector("#qwen_image_embed_open");
    const frame = root.querySelector("#qwen_image_embed_frame");
    const overlay = root.querySelector("#qwen_image_embed_overlay");
    const signalInput = (typeof gradioApp === "function" ? gradioApp() : document).querySelector("#qwen_image_embed_signal textarea");
    if (!urlInput || !reloadBtn || !openLink || !frame || !overlay) return;

    root.dataset.qwenImageReady = "1";

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

  function initAllQwenImageTabs() {
    document.querySelectorAll("#qwen_image_embed_root").forEach((root) => setupQwenImageTab(root));
  }

  const observer = new MutationObserver(function () {
    initAllQwenImageTabs();
  });

  observer.observe(document.documentElement, { childList: true, subtree: true });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () {
      setTimeout(initAllQwenImageTabs, 250);
    });
  } else {
    setTimeout(initAllQwenImageTabs, 250);
  }
})();
