// Result panel quick actions:
//  - ➕ stage: fill the tab's hidden stage payload and press its hidden capture
//    button, which is wired to Img2imgStageManager.capture in modules/ui.py;
//  - 🧩 composer: load the selected result image into the Composer tab;
//  - log lines marked by modules/ui_common.py quick_action_message() (endorse,
//    stage, ...) are also popped up as global banners.
(function () {
  "use strict";

  const STAGE_BUTTONS = {txt2img_stage: "txt2img", img2img_stage: "img2img"};
  const COMPOSER_BUTTONS = {
    txt2img_send_to_composer: "txt2img",
    img2img_send_to_composer: "img2img",
    extras_send_to_composer: "extras",
  };
  const LOG_IDS = ["html_log_txt2img", "html_log_img2img"];

  function banner(message, kind) {
    if (window.webuiBanner && typeof window.webuiBanner.show === "function") {
      window.webuiBanner.show(message, { kind: kind || "info", duration: 3600 });
    }
  }

  function setHiddenTextbox(id, value) {
    const host = gradioApp().getElementById(id);
    const input = host && host.querySelector("textarea, input");
    if (!input) return false;

    const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  }

  function stageFieldKeys() {
    const list = gradioApp().getElementById("img2img_stage_list");
    const raw = list && list.dataset ? list.dataset.fields : "";
    if (!raw) return null;

    try {
      const fields = JSON.parse(raw);
      return Array.isArray(fields) ? fields.map((field) => field.key) : null;
    } catch (e) {
      return null;
    }
  }

  function addStage(tabname) {
    const fields = stageFieldKeys();
    if (!fields || fields.length === 0) {
      banner("Stage panel is not available", "error");
      return;
    }

    if (!setHiddenTextbox(tabname + "_stage_quick_payload", JSON.stringify({ name: "", fields }))) {
      banner("Stage: payload field is missing (reload the UI)", "error");
      return;
    }

    const capture = gradioApp().getElementById(tabname + "_stage_quick_capture");
    if (!capture) {
      banner("Stage: capture button is missing (reload the UI)", "error");
      return;
    }

    capture.click();
  }

  function resultImage(tabname, index) {
    const gallery = gradioApp().getElementById(tabname + "_gallery");
    if (!gallery) return null;

    const thumbs = gallery.querySelectorAll(".thumbnail-lg");
    if (thumbs.length === 0) return null;

    const selected = Number(index);
    let thumb = selected >= 0 && selected < thumbs.length ? thumbs[selected] : null;
    if (!thumb) thumb = gallery.querySelector(".thumbnail-lg.selected") || thumbs[0];

    return thumb ? thumb.querySelector("img") : null;
  }

  function switchToTab(name) {
    const nav = gradioApp().querySelector("#tabs > .tab-nav");
    if (!nav) return;

    const target = String(name).toLowerCase();
    for (const button of nav.querySelectorAll("button")) {
      if (button.textContent.trim().toLowerCase() === target) {
        button.click();
        return;
      }
    }
  }

  function sendToComposer(tabname, index) {
    const image = resultImage(tabname, index);
    if (!image || !image.src) {
      banner("Composer: no image to send", "error");
      return;
    }

    const src = image.src;
    switchToTab("Composer");

    // let the composer tab lay itself out before loading into it
    setTimeout(async () => {
      if (typeof window.composer_load_from_url !== "function") {
        banner("Composer is not available", "error");
        return;
      }

      try {
        await window.composer_load_from_url(src);
        banner("🧩 Sent to Composer", "success");
      } catch (e) {
        banner("Composer load failed: " + ((e && e.message) || e), "error");
      }
    }, 450);
  }

  function watchLog(id) {
    const log = gradioApp().getElementById(id);
    if (!log || log.dataset.quickActionBound === "1") return;

    log.dataset.quickActionBound = "1";
    let lastMessage = null;
    const observer = new MutationObserver(() => {
      const message = log.querySelector(".quick-action-success, .quick-action-error");
      // gradio re-renders the log when tabs change, so compare the text to only
      // announce every action once
      if (!message || message.textContent === lastMessage) return;

      lastMessage = message.textContent;
      const success = message.classList.contains("quick-action-success");
      banner(message.textContent.trim(), success ? "success" : "error");
    });
    observer.observe(log, { childList: true, subtree: true });
  }

  document.addEventListener("click", function (event) {
    const button = event.target instanceof Element ? event.target.closest("button[id]") : null;
    if (!button) return;

    if (STAGE_BUTTONS[button.id]) {
      addStage(STAGE_BUTTONS[button.id]);
    } else if (COMPOSER_BUTTONS[button.id]) {
      sendToComposer(COMPOSER_BUTTONS[button.id], selected_gallery_index());
    }
  }, true);

  function setup() {
    LOG_IDS.forEach(watchLog);
  }

  onUiLoaded(setup);
  onAfterUiUpdate(setup);
})();
