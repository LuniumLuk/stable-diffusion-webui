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

    async function checkStatus(url) {
      try {
        const res = await fetch(new URL("api/status", url).toString(), { method: "GET" });
        if (!res.ok) {
          throw new Error("status " + res.status);
        }

        const data = await res.json();
        overlay.classList.remove("show");
      } catch (_err) {
        overlay.classList.add("show");
      }
    }

    function applyUrl(url) {
      const normalized = normalizeUrl(url);
      urlInput.value = normalized;
      openLink.href = normalized;
      frame.src = normalized;
      checkStatus(normalized);
    }

    function applySignalPayload(payloadText) {
      if (!payloadText) return;
      try {
        const payload = JSON.parse(payloadText);
        const targetUrl = normalizeUrl(payload.url || urlInput.value || defaultUrl);
        urlInput.value = targetUrl;
        openLink.href = targetUrl;

        if (payload.action === "stop") {
          overlay.classList.add("show");
          return;
        }

        if (payload.action === "start" || payload.action === "restart") {
          frame.src = targetUrl;
          setTimeout(function () {
            checkStatus(targetUrl);
          }, 400);
          return;
        }

        checkStatus(targetUrl);
      } catch (_err) {
        checkStatus(normalizeUrl(urlInput.value || defaultUrl));
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
      checkStatus(normalizeUrl(urlInput.value));
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