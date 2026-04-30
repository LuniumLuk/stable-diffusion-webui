(function () {
  "use strict";

  function hasFiles(event) {
    const dt = event && event.dataTransfer;
    if (!dt) return false;
    if (dt.files && dt.files.length > 0) return true;
    if (dt.items && dt.items.length > 0) {
      return Array.from(dt.items).some((item) => item.kind === "file");
    }
    return false;
  }

  function getTextAreaValue(elemId) {
    const el = gradioApp().getElementById(elemId);
    if (!el) return "";
    const ta = el.tagName === "TEXTAREA" ? el : el.querySelector("textarea");
    return ta ? ta.value : "";
  }

  function getTextAreaElement(elemId) {
    const el = gradioApp().getElementById(elemId);
    if (!el) return null;
    return el.tagName === "TEXTAREA" ? el : el.querySelector("textarea");
  }

  function setTextAreaValue(elemId, value) {
    const ta = getTextAreaElement(elemId);
    if (!ta) return;

    const nativeSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
    nativeSetter.call(ta, value);
    ta.dispatchEvent(new Event("input", { bubbles: true }));
    ta.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function applyTextareaTheme(target, sourceElemId) {
    const source = getTextAreaElement(sourceElemId);
    if (!target || !source) return;

    const styles = getComputedStyle(source);
    const props = [
      "backgroundColor",
      "color",
      "borderColor",
      "borderWidth",
      "borderStyle",
      "borderRadius",
      "fontFamily",
      "fontSize",
      "fontWeight",
      "lineHeight",
      "paddingTop",
      "paddingRight",
      "paddingBottom",
      "paddingLeft",
      "boxShadow",
      "caretColor",
    ];

    for (const prop of props) {
      target.style[prop] = styles[prop];
    }
  }

  function containWheelScroll(element) {
    if (!element || element.dataset.wheelContained === "1") return;
    element.dataset.wheelContained = "1";

    element.addEventListener("wheel", (event) => {
      const canScrollY = element.scrollHeight > element.clientHeight;
      const canScrollX = element.scrollWidth > element.clientWidth;
      if (!canScrollY && !canScrollX) return;

      if (canScrollY && event.deltaY !== 0) {
        element.scrollTop += event.deltaY;
      }

      if (canScrollX && event.deltaX !== 0) {
        element.scrollLeft += event.deltaX;
      }

      event.preventDefault();
      event.stopPropagation();
    }, { passive: false });
  }

  function autoSizeTextarea(textarea) {
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = `${textarea.scrollHeight}px`;
  }

  function fitComparePopupHost(wrapper) {
    const host = wrapper && wrapper.closest(".global-popup-inner");
    if (!host) return;

    host.style.width = "min(1680px, calc(100vw - 32px))";
    host.style.maxWidth = "calc(100vw - 32px)";
    host.style.maxHeight = "calc(100vh - 32px)";
    host.style.height = "calc(100vh - 32px)";
    host.style.padding = "16px";
    host.style.overflow = "auto";
    host.style.scrollbarWidth = "none";
    host.style.msOverflowStyle = "none";
  }

  function getControlInputById(elemId) {
    const wrap = gradioApp().getElementById(elemId);
    if (!wrap) return null;
    return wrap.querySelector("input, textarea") || wrap;
  }

  function setControlValue(elemId, value) {
    const input = getControlInputById(elemId);
    if (!input) return false;

    const tag = input.tagName.toLowerCase();
    if (tag === "input" || tag === "textarea") {
      const proto = tag === "textarea" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
      if (setter) {
        setter.call(input, value);
      } else {
        input.value = value;
      }
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    }

    return false;
  }

  function getControlValue(elemId) {
    const input = getControlInputById(elemId);
    if (!input) return "";
    return (input.value || "").toString();
  }

  function parseInfotext(infotext) {
    const text = (infotext || "").trim();
    const result = {
      prompt: "",
      negativePrompt: "",
      params: {},
      raw: text,
    };

    if (!text) return result;

    const negativeMarker = "Negative prompt:";
    const stepsMarker = "Steps:";

    const idxNeg = text.indexOf(negativeMarker);
    const idxSteps = text.lastIndexOf(stepsMarker);

    if (idxNeg >= 0) {
      result.prompt = text.slice(0, idxNeg).trim();
      if (idxSteps > idxNeg) {
        result.negativePrompt = text.slice(idxNeg + negativeMarker.length, idxSteps).trim().replace(/,$/, "");
      } else {
        result.negativePrompt = text.slice(idxNeg + negativeMarker.length).trim().replace(/,$/, "");
      }
    } else if (idxSteps > 0) {
      result.prompt = text.slice(0, idxSteps).trim().replace(/,$/, "");
    } else {
      result.prompt = text;
    }

    if (idxSteps >= 0) {
      const paramsLine = text.slice(idxSteps).trim();
      const chunks = paramsLine.split(/,\s*/);
      for (const chunk of chunks) {
        const cidx = chunk.indexOf(":");
        if (cidx <= 0) continue;
        const key = chunk.slice(0, cidx).trim();
        const val = chunk.slice(cidx + 1).trim();
        if (key) result.params[key] = val;
      }
    }

    return result;
  }

  function escapeHtml(value) {
    return (value || "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;");
  }

  function diffLines(leftText, rightText) {
    const left = (leftText || "").split(/\r?\n/);
    const right = (rightText || "").split(/\r?\n/);
    const m = left.length;
    const n = right.length;
    const dp = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));

    for (let i = m - 1; i >= 0; i--) {
      for (let j = n - 1; j >= 0; j--) {
        dp[i][j] = left[i] === right[j]
          ? dp[i + 1][j + 1] + 1
          : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }

    const rows = [];
    let i = 0;
    let j = 0;
    while (i < m && j < n) {
      if (left[i] === right[j]) {
        rows.push({ type: "same", left: left[i], right: right[j] });
        i += 1;
        j += 1;
      } else if (dp[i + 1][j] >= dp[i][j + 1]) {
        rows.push({ type: "remove", left: left[i], right: "" });
        i += 1;
      } else {
        rows.push({ type: "add", left: "", right: right[j] });
        j += 1;
      }
    }

    while (i < m) {
      rows.push({ type: "remove", left: left[i], right: "" });
      i += 1;
    }

    while (j < n) {
      rows.push({ type: "add", left: "", right: right[j] });
      j += 1;
    }

    return rows;
  }

  function renderDiffHtml(leftText, rightText) {
    const rows = diffLines(leftText, rightText);
    return rows.map((row) => {
      const leftPrefix = row.type === "remove" ? "-" : row.type === "same" ? " " : "";
      const rightPrefix = row.type === "add" ? "+" : row.type === "same" ? " " : "";
      return `
        <div class="prompt-compare-diff-row ${row.type}">
          <div class="prompt-compare-diff-cell left"><span class="prefix">${leftPrefix}</span><span>${escapeHtml(row.left)}</span></div>
          <div class="prompt-compare-diff-cell right"><span class="prefix">${rightPrefix}</span><span>${escapeHtml(row.right)}</span></div>
        </div>`;
    }).join("");
  }

  function promptToKeywordList(text) {
    return (text || "")
      .split(/[\r\n,\.]+/)
      .map((part) => part.trim())
      .filter((part) => part.length > 0)
      .join("\n");
  }

  function toDiffSource(labelText, value) {
    if (labelText === "Prompt" || labelText === "Negative prompt") {
      return promptToKeywordList(value);
    }
    return value || "";
  }

  function currentSettings(tab) {
    const settings = {
      "Steps": getControlValue(`${tab}_steps`) || "",
      "Sampler": getControlValue(`${tab}_sampling`) || getControlValue(`${tab}_sampler`) || "",
      "CFG scale": getControlValue(`${tab}_cfg_scale`) || "",
      "Seed": getControlValue(`${tab}_seed`) || "",
      "Size-1": getControlValue(`${tab}_width`) || "",
      "Size-2": getControlValue(`${tab}_height`) || "",
    };

    const denoise = getControlValue(`${tab}_denoising_strength`);
    if (denoise) {
      settings["Denoising strength"] = denoise;
    }

    return settings;
  }

  function settingsToLines(settings) {
    return Object.entries(settings)
      .filter(([, value]) => value !== "")
      .map(([key, value]) => `${key}: ${value}`)
      .join("\n");
  }

  function parseSettingsLines(text) {
    const parsed = {};
    (text || "").split(/\r?\n/).forEach((line) => {
      const idx = line.indexOf(":");
      if (idx <= 0) return;
      const key = line.slice(0, idx).trim();
      const value = line.slice(idx + 1).trim();
      if (!key) return;
      parsed[key] = value;
    });
    return parsed;
  }

  function applyLeftSettingsToUi(tab, settingsText) {
    const map = {
      "Steps": `${tab}_steps`,
      "Sampler": `${tab}_sampling`,
      "CFG scale": `${tab}_cfg_scale`,
      "Seed": `${tab}_seed`,
      "Size-1": `${tab}_width`,
      "Size-2": `${tab}_height`,
      "Denoising strength": `${tab}_denoising_strength`,
    };

    const parsed = parseSettingsLines(settingsText);
    for (const [key, value] of Object.entries(parsed)) {
      const target = map[key];
      if (!target) continue;
      setControlValue(target, value);
    }
  }

  async function extractInfotextFromImage(file) {
    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });

    const resp = await fetch("/sdapi/v1/png-info", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image: dataUrl }),
    });

    if (!resp.ok) {
      throw new Error(`PNG info API failed: ${resp.status}`);
    }

    const json = await resp.json();
    return (json && (json.info || json.items || "")) || "";
  }

  async function extractInfotextViaPromptImageInput(tab, file) {
    const promptId = `${tab}_prompt`;
    const promptImageWrap = gradioApp().getElementById(`${tab}_prompt_image`);
    if (!promptImageWrap) {
      return "";
    }

    const fileInput = promptImageWrap.querySelector('input[type="file"]');
    if (!fileInput) {
      return "";
    }

    const beforePrompt = getTextAreaValue(promptId);

    const data = new DataTransfer();
    data.items.add(file);
    fileInput.files = data.files;
    fileInput.dispatchEvent(new Event("change", { bubbles: true }));

    const maxTries = 40;
    let tries = 0;

    return await new Promise((resolve) => {
      const timer = setInterval(() => {
        tries += 1;
        const currentPrompt = getTextAreaValue(promptId);
        const looksLikeInfotext = /\bSteps:\s*\d+/.test(currentPrompt) || currentPrompt.includes("Negative prompt:");

        if (currentPrompt && currentPrompt !== beforePrompt && looksLikeInfotext) {
          clearInterval(timer);
          // Restore the user's prompt after extracting parse result.
          setTextAreaValue(promptId, beforePrompt);
          resolve(currentPrompt);
          return;
        }

        if (tries >= maxTries) {
          clearInterval(timer);
          setTextAreaValue(promptId, beforePrompt);
          resolve("");
        }
      }, 100);
    });
  }

  function createComparePopup(tab, droppedInfo) {
    const wrapper = document.createElement("div");
    wrapper.className = "prompt-compare-popup";

    const title = document.createElement("h3");
    title.className = "prompt-compare-title";
    title.textContent = tab === "img2img" ? "img2img Prompt/Settings Compare" : "txt2img Prompt/Settings Compare";
    wrapper.appendChild(title);

    const grid = document.createElement("div");
    grid.className = "prompt-compare-grid";

    const diffContainer = document.createElement("div");
    diffContainer.className = "prompt-compare-diff-container";

    const left = document.createElement("div");
    left.className = "prompt-compare-col";
    const right = document.createElement("div");
    right.className = "prompt-compare-col";

    const leftHead = document.createElement("h4");
    leftHead.textContent = "Current (Editable + Sync)";
    left.appendChild(leftHead);

    const rightHead = document.createElement("h4");
    rightHead.textContent = "Dropped Settings (Read-only)";
    right.appendChild(rightHead);

    const makeLabel = (text) => {
      const label = document.createElement("div");
      label.className = "prompt-compare-label";
      label.textContent = text;
      return label;
    };

    function createCompareSection(labelText, leftValue, rightValue, leftApply) {
      const leftLabel = makeLabel(labelText);
      const rightLabel = makeLabel(labelText);

      const leftArea = document.createElement("textarea");
      leftArea.className = "prompt-compare-textarea" + (labelText === "Settings" ? " settings" : "");
      leftArea.value = leftValue;

      const rightArea = document.createElement("textarea");
      rightArea.className = "prompt-compare-textarea" + (labelText === "Settings" ? " settings" : "");
      rightArea.readOnly = true;
      rightArea.value = rightValue;

      applyTextareaTheme(leftArea, `${tab}_prompt`);
      applyTextareaTheme(rightArea, `${tab}_prompt`);
      autoSizeTextarea(leftArea);
      autoSizeTextarea(rightArea);

      const diffWrap = document.createElement("div");
      diffWrap.className = "prompt-compare-diff";

      const diffTitle = document.createElement("div");
      diffTitle.className = "prompt-compare-diff-title";
      diffTitle.textContent = `${labelText} diff`;
      diffWrap.appendChild(diffTitle);

      const diffGrid = document.createElement("div");
      diffGrid.className = "prompt-compare-diff-grid";
      diffWrap.appendChild(diffGrid);

      const refreshDiff = () => {
        diffGrid.innerHTML = renderDiffHtml(
          toDiffSource(labelText, leftArea.value),
          toDiffSource(labelText, rightArea.value),
        );
      };

      leftArea.addEventListener("input", () => {
        leftApply(leftArea.value);
        autoSizeTextarea(leftArea);
        refreshDiff();
      });

      refreshDiff();

      left.appendChild(leftLabel);
      left.appendChild(leftArea);
      right.appendChild(rightLabel);
      right.appendChild(rightArea);
      diffContainer.appendChild(diffWrap);
    }

    createCompareSection(
      "Prompt",
      getTextAreaValue(`${tab}_prompt`),
      droppedInfo.prompt || "",
      (value) => setTextAreaValue(`${tab}_prompt`, value),
    );

    createCompareSection(
      "Negative prompt",
      getTextAreaValue(`${tab}_neg_prompt`),
      droppedInfo.negativePrompt || "",
      (value) => setTextAreaValue(`${tab}_neg_prompt`, value),
    );

    createCompareSection(
      "Settings",
      settingsToLines(currentSettings(tab)),
      settingsToLines(droppedInfo.params || {}),
      (value) => applyLeftSettingsToUi(tab, value),
    );

    grid.appendChild(left);
    grid.appendChild(right);
    wrapper.appendChild(grid);
    wrapper.appendChild(diffContainer);

    if (typeof popup === "function") {
      popup(wrapper);
      fitComparePopupHost(wrapper);
    }
  }

  async function parseDroppedFile(tab, file) {
    const name = (file.name || "").toLowerCase();
    if (name.endsWith(".txt")) {
      const txt = await file.text();
      return parseInfotext(txt);
    }

    if ((file.type || "").startsWith("image/")) {
      let info = "";
      try {
        info = await extractInfotextFromImage(file);
      } catch {
        info = "";
      }

      // Fallback to the same hidden prompt-image parser path used by main prompt drop.
      if (!info) {
        info = await extractInfotextViaPromptImageInput(tab, file);
      }

      return parseInfotext(info);
    }

    throw new Error("Unsupported file type; use .txt or image file.");
  }

  function bindDropZone(tab) {
    const zone = gradioApp().getElementById(`${tab}_compare_dropzone`);
    if (!zone) return;
    if (zone.dataset.bound === "1") return;
    zone.dataset.bound = "1";

    zone.addEventListener("dragover", (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.stopPropagation();
      zone.classList.add("drag-over");
    });

    zone.addEventListener("dragleave", () => {
      zone.classList.remove("drag-over");
    });

    zone.addEventListener("drop", async (e) => {
      zone.classList.remove("drag-over");
      if (!hasFiles(e)) return;

      e.preventDefault();
      e.stopPropagation();

      const file = e.dataTransfer.files[0];
      if (!file) return;

      zone.textContent = "Parsing dropped file...";
      try {
        const dropped = await parseDroppedFile(tab, file);
        createComparePopup(tab, dropped);
        zone.textContent = "Drop .txt or image here to compare against current prompt/settings";
      } catch (err) {
        console.error(err);
        zone.textContent = `Could not parse dropped file (${err?.message || "unknown error"}). Drop .txt or image with generation settings.`;
      }
    });
  }

  function initPromptCompareDropZones() {
    bindDropZone("txt2img");
    bindDropZone("img2img");
  }

  onUiLoaded(initPromptCompareDropZones);
  onAfterUiUpdate(initPromptCompareDropZones);
})();
