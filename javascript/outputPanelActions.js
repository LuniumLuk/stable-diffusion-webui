// Result panel quick actions: the generation preview carries a floating capsule
// with three buttons only.
//  - 🖼️ To img2img / 🎨 To inpaint: a plain click runs the variation starred as
//    the default in the gallery's detail panel (image only unless changed
//    there), right-click opens that same "what gets sent" menu;
//  - 🧩 Composer: load the selected result image into the Composer tab;
//  - log lines marked by modules/ui_common.py quick_action_message() (endorse,
//    save, ...) are also popped up as global banners.
(function () {
  "use strict";

  const SEND_BUTTONS = {
    txt2img_send_to_img2img: {tab: "txt2img", action: "img2img"},
    txt2img_send_to_inpaint: {tab: "txt2img", action: "inpaint"},
    img2img_send_to_img2img: {tab: "img2img", action: "img2img"},
    img2img_send_to_inpaint: {tab: "img2img", action: "inpaint"},
  };
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

    if (input.value !== value) {
      // the prompt editors chain their own value setter; going through it keeps
      // them in sync, otherwise they may render their stale value back
      const own = Object.getOwnPropertyDescriptor(input, "value");
      if (own && own.set) {
        own.set.call(input, value);
      } else {
        const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto, "value").set.call(input, value);
      }
    }

    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }

  function textboxValue(id) {
    const host = gradioApp().getElementById(id);
    const input = host && host.querySelector("textarea, input");
    return input ? input.value : null;
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

  // ---------------------------------------------------------------- send variations
  // the gallery and the result panels share one menu and one remembered default
  // (javascript/galleryV2.js exposes it as window.gallerySendMenu)
  const PREFS_KEY = "gv2.prefs.v1";
  const SEND_VARIANTS = ["", "prompt", "image_prompt", "all"];

  function sendMenu() {
    return window.gallerySendMenu || null;
  }

  function sendVariation(action) {
    const menu = sendMenu();
    if (menu) return menu.defaultOnly(action);

    // galleryV2.js did not load: still honour the stored default
    try {
      const prefs = JSON.parse(window.localStorage.getItem(PREFS_KEY) || "{}") || {};
      const only = prefs.sendDefaults ? prefs.sendDefaults[action] : "";
      return SEND_VARIANTS.indexOf(only) > -1 ? only : "";
    } catch (e) {
      return "";
    }
  }

  function selectedInfotext(tabname) {
    const host = gradioApp().getElementById("generation_info_" + tabname);
    const input = host && host.querySelector("textarea, input");
    if (!input || !input.value) return "";

    let infotexts;
    try {
      infotexts = JSON.parse(input.value).infotexts;
    } catch (e) {
      return "";
    }
    if (!Array.isArray(infotexts) || infotexts.length === 0) return "";

    const index = Number(selected_gallery_index());
    const text = infotexts[index >= 0 && index < infotexts.length ? index : 0];
    return text || "";
  }

  function splitInfotext(text) {
    const body = String(text || "");
    // an empty prompt makes the infotext start straight at "Steps: ..."
    const params = /(?:^|\n)Steps: \d/.exec(body);
    const head = (params ? body.slice(0, params.index) : body).replace(/\n$/, "");
    const negAt = head.lastIndexOf("\nNegative prompt: ");
    return {
      prompt: negAt >= 0 ? head.slice(0, negAt) : head,
      negative: negAt >= 0 ? head.slice(negAt + "\nNegative prompt: ".length) : "",
    };
  }

  // prompt + negative only: no image and no other setting is touched.
  // The write is verified because the prompt editors (CodeMirror / chips) can
  // render their own state back over the textarea.
  function applyPromptOnly(tabname, retries) {
    const infotext = selectedInfotext(tabname);
    const parts = splitInfotext(infotext);
    if (!infotext || (!parts.prompt && !parts.negative)) {
      banner("No prompt to send for the selected result", "error");
      return false;
    }

    const targets = [];
    if (parts.prompt) targets.push(["img2img_prompt", parts.prompt]);
    if (parts.negative) targets.push(["img2img_neg_prompt", parts.negative]);

    let pending = targets;
    for (let attempt = retries == null ? 1 : retries; attempt >= 0; attempt--) {
      pending.forEach(([id, text]) => setHiddenTextbox(id, text));
      pending = targets.filter(([id, text]) => textboxValue(id) !== text);
      if (pending.length === 0) return true;
    }

    banner("Could not write the prompt into img2img", "error");
    return false;
  }

  // full infotext (prompt + every parameter) through the tab's hidden paste bridge
  function applyInfotext(tabname) {
    const infotext = selectedInfotext(tabname);
    if (!infotext) {
      banner("No generation info to send for the selected result", "error");
      return false;
    }

    const inputId = tabname + "_infotext_apply";
    const apply = gradioApp().getElementById(tabname + "_apply_infotext");
    if (!apply) {
      banner("Send bridge is missing (reload the UI)", "error");
      return false;
    }

    // gradio sends the textbox value it saw at click time, so make sure the write landed
    let written = false;
    for (let attempt = 0; attempt < 2 && !written; attempt++) {
      setHiddenTextbox(inputId, infotext);
      written = textboxValue(inputId) === infotext;
    }
    if (!written) {
      banner("Could not hand the generation info to the send bridge", "error");
      return false;
    }

    apply.click();
    return true;
  }

  function switchToTarget(action) {
    setTimeout(function () {
      if (action === "inpaint") {
        if (typeof window.switch_to_inpaint === "function") window.switch_to_inpaint();
      } else if (typeof window.switch_to_img2img === "function") {
        window.switch_to_img2img();
      }
    }, 250);
  }

  // the hidden, per-target button that only sends the selected image; the
  // visible button's own chain would also copy the current prompt/settings
  function sendImage(tabname, action) {
    const button = gradioApp().getElementById(tabname + "_send_image_" + action);
    if (!button) return false;

    button.click();
    return true;
  }

  // the prompt editors can write their state back a frame later; confirm the text
  // survived before sending anything
  function whenPromptSettled(tabname, done) {
    setTimeout(function () {
      if (applyPromptOnly(tabname, 0)) done();
    }, 80);
  }

  function runSend(tabname, action, only) {
    const label = action === "inpaint" ? "inpaint" : "img2img";

    if (only === "prompt") {
      if (!applyPromptOnly(tabname)) return;
      whenPromptSettled(tabname, function () {
        switchToTarget(action);
        banner("Prompt sent to " + label, "success");
      });
      return;
    }

    if (!resultImage(tabname, selected_gallery_index())) {
      banner("No result image to send", "error");
      return;
    }

    if (only === "image_prompt") {
      if (!applyPromptOnly(tabname)) return;
      whenPromptSettled(tabname, function () {
        if (!sendImage(tabname, action)) {
          banner("Send bridge is missing (reload the UI)", "error");
          return;
        }
        banner("Image + prompt sent to " + label, "success");
      });
      return;
    }

    if (only === "all" && !applyInfotext(tabname)) return;

    if (!sendImage(tabname, action)) {
      banner("Send bridge is missing (reload the UI)", "error");
      return;
    }
    if (only === "all") {
      // the paste bridge lands on the img2img sub-tab; go back to the picked one
      switchToTarget(action);
    }

    banner((only === "all" ? "Image + prompt + settings" : "Image") + " sent to " + label, "success");
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

    const send = SEND_BUTTONS[button.id];
    if (send) {
      event.preventDefault();
      event.stopPropagation();
      runSend(send.tab, send.action, sendVariation(send.action));
      return;
    }

    if (COMPOSER_BUTTONS[button.id]) {
      sendToComposer(COMPOSER_BUTTONS[button.id], selected_gallery_index());
    }
  }, true);

  document.addEventListener("contextmenu", function (event) {
    const button = event.target instanceof Element ? event.target.closest("button[id]") : null;
    const send = button && SEND_BUTTONS[button.id];
    const menu = sendMenu();
    if (!send || !menu) return;

    event.preventDefault();
    event.stopPropagation();
    menu.openOptions(event, send.action, function (only) {
      runSend(send.tab, send.action, only);
    });
  }, true);

  function setup() {
    LOG_IDS.forEach(watchLog);
  }

  onUiLoaded(setup);
  onAfterUiUpdate(setup);
})();
