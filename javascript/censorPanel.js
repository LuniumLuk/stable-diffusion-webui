(function () {
  function setupCensorPanel(root) {
    if (!root || root.dataset.censorReady === "1") return;

    const storageKeyWidth = "censor:last-line-width";
    const storageKeyShape = "censor:last-line-shape";

    const canvas = root.querySelector("#censor_canvas");
    const wrap = root.querySelector("#censor_canvas_wrap");
    const dropHint = root.querySelector("#censor_drop_hint");
    const widthSlider = root.querySelector("#censor_line_width");
    const widthValue = root.querySelector("#censor_line_width_value");
    const overwriteWidthBtn = root.querySelector("#censor_overwrite_width_btn");
    const shapeSelect = root.querySelector("#censor_line_shape");
    const saveBtn = root.querySelector("#censor_save_btn");
    const saveStatus = root.querySelector("#censor_save_status");
    if (!canvas || !wrap || !dropHint || !widthSlider || !widthValue || !overwriteWidthBtn || !shapeSelect || !saveBtn || !saveStatus) return;

    const ctx = canvas.getContext("2d");
    const storedWidth = Number(window.localStorage?.getItem(storageKeyWidth) || widthSlider.value || 18);
    const storedShape = (window.localStorage?.getItem(storageKeyShape) || shapeSelect.value || "round");
    widthSlider.value = String(Math.max(1, Math.min(96, storedWidth || 18)));
    if (["round", "square", "butt"].includes(storedShape)) {
      shapeSelect.value = storedShape;
    }
    const state = {
      hasImage: false,
      lineWidth: Number(widthSlider.value) || 18,
      lineShape: shapeSelect.value || "round",
      pendingStart: null,
      segments: [],
      redoSegments: [],
      baseImage: null,
      scale: 1,
      panX: 0,
      panY: 0,
      dragStartX: 0,
      dragStartY: 0,
      dragOriginX: 0,
      dragOriginY: 0,
      isPanning: false,
      displayW: canvas.clientWidth,
      displayH: canvas.clientHeight,
    };

    root.dataset.censorReady = "1";
    const appRoot = typeof gradioApp === "function" ? gradioApp() : document;

    function updateLineWidthUI() {
      widthValue.textContent = `${state.lineWidth} px`;
    }

    function persistSettings() {
      if (!window.localStorage) return;
      window.localStorage.setItem(storageKeyWidth, String(state.lineWidth));
      window.localStorage.setItem(storageKeyShape, state.lineShape);
    }

    function setStatus(text) {
      saveStatus.textContent = text;
    }

    function refreshCanvasCssSize() {
      const maxW = Math.max(360, wrap.clientWidth - 16);
      const aspect = canvas.width / canvas.height;
      const h = Math.max(300, Math.min(window.innerHeight * 0.72, maxW / aspect));
      const w = h * aspect;
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      state.displayW = w;
      state.displayH = h;
    }

    function getCanvasPoint(evt) {
      const rect = canvas.getBoundingClientRect();
      const canvasX = (evt.clientX - rect.left) * (canvas.width / rect.width);
      const canvasY = (evt.clientY - rect.top) * (canvas.height / rect.height);
      const x = (canvasX - state.panX) / state.scale;
      const y = (canvasY - state.panY) / state.scale;
      return { x, y };
    }

    function drawSegment(seg) {
      ctx.save();
      ctx.strokeStyle = "#000000";
      ctx.lineWidth = seg.width;
      ctx.lineCap = seg.shape || "round";
      ctx.lineJoin = seg.shape === "round" ? "round" : "miter";
      ctx.beginPath();
      ctx.moveTo(seg.x1, seg.y1);
      ctx.lineTo(seg.x2, seg.y2);
      ctx.stroke();
      ctx.restore();
    }

    function drawScene(targetCtx) {
      if (!state.baseImage) {
        targetCtx.clearRect(0, 0, canvas.width, canvas.height);
        return;
      }

      targetCtx.clearRect(0, 0, canvas.width, canvas.height);
      targetCtx.drawImage(state.baseImage, 0, 0, canvas.width, canvas.height);
      state.segments.forEach((seg) => {
        targetCtx.save();
        targetCtx.strokeStyle = "#000000";
        targetCtx.lineWidth = seg.width;
        targetCtx.lineCap = seg.shape || "round";
        targetCtx.lineJoin = seg.shape === "round" ? "round" : "miter";
        targetCtx.beginPath();
        targetCtx.moveTo(seg.x1, seg.y1);
        targetCtx.lineTo(seg.x2, seg.y2);
        targetCtx.stroke();
        targetCtx.restore();
      });
    }

    function redraw() {
      if (!state.baseImage) {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        return;
      }

      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.save();
      ctx.setTransform(state.scale, 0, 0, state.scale, state.panX, state.panY);
      drawScene(ctx);
      ctx.restore();

      if (state.pendingStart) {
        drawPendingStartIndicator();
      }
    }

    function getInverseIndicatorColor() {
      if (!state.pendingStart) {
        return "#ffffff";
      }

      const screenX = Math.round(state.pendingStart.x * state.scale + state.panX);
      const screenY = Math.round(state.pendingStart.y * state.scale + state.panY);
      const sampleX = Math.max(0, Math.min(canvas.width - 1, screenX));
      const sampleY = Math.max(0, Math.min(canvas.height - 1, screenY));
      const data = ctx.getImageData(sampleX, sampleY, 1, 1).data;
      const inv = [255 - data[0], 255 - data[1], 255 - data[2]];
      return `rgb(${inv[0]}, ${inv[1]}, ${inv[2]})`;
    }

    function drawPendingStartIndicator() {
      if (!state.pendingStart) return;

      const screenX = state.pendingStart.x * state.scale + state.panX;
      const screenY = state.pendingStart.y * state.scale + state.panY;
      const crossSize = Math.max(10, state.lineWidth * 0.65);
      const gap = Math.max(3, state.lineWidth * 0.16);
      const color = getInverseIndicatorColor();

      ctx.save();
      ctx.strokeStyle = color;
      ctx.lineWidth = Math.max(2, state.lineWidth * 0.14);
      ctx.lineCap = "round";

      ctx.beginPath();
      ctx.moveTo(screenX - crossSize, screenY);
      ctx.lineTo(screenX - gap, screenY);
      ctx.moveTo(screenX + gap, screenY);
      ctx.lineTo(screenX + crossSize, screenY);
      ctx.moveTo(screenX, screenY - crossSize);
      ctx.lineTo(screenX, screenY - gap);
      ctx.moveTo(screenX, screenY + gap);
      ctx.lineTo(screenX, screenY + crossSize);
      ctx.stroke();

      ctx.strokeStyle = color === "rgb(0, 0, 0)" ? "#ffffff" : "#000000";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(screenX, screenY, Math.max(2, gap), 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }

    function handleCanvasClick(evt) {
      if (!state.hasImage) return;
      evt.preventDefault();

      const p = getCanvasPoint(evt);
      if (!state.pendingStart) {
        state.pendingStart = p;
        redraw();
        return;
      }

      state.segments.push({
        x1: state.pendingStart.x,
        y1: state.pendingStart.y,
        x2: p.x,
        y2: p.y,
        width: state.lineWidth,
        shape: state.lineShape,
      });
      state.pendingStart = null;
      state.redoSegments = [];
      redraw();
    }

    function undo() {
      if (state.segments.length === 0) return;
      state.redoSegments.push(state.segments.pop());
      state.pendingStart = null;
      redraw();
    }

    function redo() {
      if (state.redoSegments.length === 0) return;
      state.segments.push(state.redoSegments.pop());
      state.pendingStart = null;
      redraw();
    }

    function overwriteExistingLineWidth() {
      if (state.segments.length === 0) {
        setStatus("No existing lines to overwrite.");
        return;
      }

      state.segments.forEach((seg) => {
        seg.width = state.lineWidth;
      });
      state.redoSegments = [];
      redraw();
      setStatus(`Updated ${state.segments.length} line(s) to ${state.lineWidth} px.`);
    }

    function loadImageFromSrc(src) {
      if (!src) return;
      const img = new Image();
      img.onload = () => {
        canvas.width = img.naturalWidth || img.width;
        canvas.height = img.naturalHeight || img.height;
        refreshCanvasCssSize();
        state.baseImage = img;
        state.segments = [];
        state.redoSegments = [];
        state.pendingStart = null;
        state.scale = 1;
        state.panX = 0;
        state.panY = 0;
        redraw();
        state.hasImage = true;
        dropHint.classList.add("hidden");
        setStatus("Image loaded.");
      };
      img.onerror = () => {
        console.warn("[censorPanel] failed to load dropped image src");
      };
      img.src = src;
    }

    function loadImageFromFile(file) {
      if (!file || !file.type || !file.type.startsWith("image/")) return;
      const reader = new FileReader();
      reader.onload = () => loadImageFromSrc(reader.result);
      reader.readAsDataURL(file);
    }

    function readDroppedSource(dataTransfer) {
      if (!dataTransfer) return null;

      const uri = dataTransfer.getData("text/uri-list") || dataTransfer.getData("text/plain");
      if (uri) {
        const trimmed = uri.trim().split("\n")[0].trim();
        if (trimmed) return trimmed;
      }

      const html = dataTransfer.getData("text/html");
      if (html) {
        const doc = new DOMParser().parseFromString(html, "text/html");
        const img = doc.querySelector("img");
        if (img && img.src) return img.src;
      }

      return null;
    }

    function onDrop(evt) {
      evt.preventDefault();
      const dt = evt.dataTransfer;
      if (!dt) return;

      if (dt.files && dt.files.length > 0) {
        loadImageFromFile(dt.files[0]);
        return;
      }

      const src = readDroppedSource(dt);
      if (src) loadImageFromSrc(src);
    }

    function onWheel(evt) {
      if (!state.hasImage) return;
      evt.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const canvasX = (evt.clientX - rect.left) * (canvas.width / rect.width);
      const canvasY = (evt.clientY - rect.top) * (canvas.height / rect.height);

      const oldScale = state.scale;
      const factor = evt.deltaY < 0 ? 1.12 : 0.89;
      state.scale = Math.min(8, Math.max(0.25, state.scale * factor));
      const ratio = state.scale / oldScale;
      state.panX = state.panX * ratio - canvasX * (ratio - 1);
      state.panY = state.panY * ratio - canvasY * (ratio - 1);
      redraw();
    }

    function onPanStart(evt) {
      if (!state.hasImage) return;
      if (evt.button !== 2) return;
      evt.preventDefault();
      state.isPanning = true;
      state.dragStartX = evt.clientX;
      state.dragStartY = evt.clientY;
      state.dragOriginX = state.panX;
      state.dragOriginY = state.panY;
      canvas.style.cursor = "grabbing";
    }

    function onPanMove(evt) {
      if (!state.isPanning) return;
      evt.preventDefault();
      const dx = evt.clientX - state.dragStartX;
      const dy = evt.clientY - state.dragStartY;
      state.panX = state.dragOriginX + dx * (canvas.width / canvas.clientWidth);
      state.panY = state.dragOriginY + dy * (canvas.height / canvas.clientHeight);
      redraw();
    }

    function onPanEnd() {
      if (!state.isPanning) return;
      state.isPanning = false;
      canvas.style.cursor = "crosshair";
    }

    widthSlider.addEventListener("input", () => {
      state.lineWidth = Math.max(1, Number(widthSlider.value) || 1);
      updateLineWidthUI();
      persistSettings();
      redraw();
    });

    shapeSelect.addEventListener("change", () => {
      state.lineShape = shapeSelect.value || "round";
      persistSettings();
      redraw();
    });

    overwriteWidthBtn.addEventListener("click", () => {
      overwriteExistingLineWidth();
    });

    canvas.addEventListener("click", handleCanvasClick);
    canvas.addEventListener("contextmenu", (evt) => evt.preventDefault());
    canvas.addEventListener("wheel", onWheel, { passive: false });
    canvas.addEventListener("mousedown", onPanStart);
    document.addEventListener("mousemove", onPanMove);
    document.addEventListener("mouseup", onPanEnd);
    canvas.addEventListener("touchend", (evt) => {
      const t = evt.changedTouches && evt.changedTouches[0];
      if (!t) return;
      handleCanvasClick({
        clientX: t.clientX,
        clientY: t.clientY,
        preventDefault: () => evt.preventDefault(),
      });
    }, { passive: false });

    [wrap, canvas].forEach((el) => {
      el.addEventListener("dragover", (evt) => evt.preventDefault());
      el.addEventListener("drop", onDrop);
    });

    root.addEventListener("paste", (evt) => {
      const items = evt.clipboardData && evt.clipboardData.items;
      if (!items) return;
      for (const item of items) {
        if (item.type && item.type.startsWith("image/")) {
          const file = item.getAsFile();
          if (file) {
            evt.preventDefault();
            loadImageFromFile(file);
            return;
          }
        }
      }
    });

    document.addEventListener("keydown", (evt) => {
      if (root.offsetParent === null) return;
      const isUndo = (evt.ctrlKey || evt.metaKey) && !evt.shiftKey && (evt.key === "z" || evt.key === "Z");
      const isRedo = (evt.ctrlKey || evt.metaKey) && (evt.key === "y" || (evt.shiftKey && (evt.key === "z" || evt.key === "Z")));
      if (isUndo) {
        evt.preventDefault();
        undo();
      } else if (isRedo) {
        evt.preventDefault();
        redo();
      }
    });

    saveBtn.addEventListener("click", () => {
      if (!state.hasImage) {
        setStatus("No image to save.");
        return;
      }

      const out = document.createElement("canvas");
      out.width = canvas.width;
      out.height = canvas.height;
      const outCtx = out.getContext("2d");
      drawScene(outCtx);
      const dataUrl = out.toDataURL("image/png");
      const exportInput = appRoot.querySelector("#censor_export_data textarea");
      const bridgeBtn = appRoot.querySelector("#censor_save_bridge_btn");
      if (!exportInput || !bridgeBtn) {
        setStatus("Save bridge not ready.");
        return;
      }

      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        "value"
      ).set;
      nativeInputValueSetter.call(exportInput, dataUrl);
      exportInput.dispatchEvent(new Event("input", { bubbles: true }));

      setStatus("Saving...");
      bridgeBtn.click();

      setTimeout(() => {
        const md = appRoot.querySelector("#censor_save_status_md");
        const txt = md ? md.innerText.trim() : "";
        if (txt) setStatus(txt);
      }, 200);
    });

    window.addEventListener("resize", refreshCanvasCssSize);

    updateLineWidthUI();
    refreshCanvasCssSize();
  }

  window.censor_export_png = function () {
    const appRoot = typeof gradioApp === "function" ? gradioApp() : document;
    const exportInput = appRoot.querySelector("#censor_export_data textarea");
    const existing = exportInput ? (exportInput.value || "") : "";
    if (existing) return [existing];
    const canvas = appRoot.querySelector("#censor_canvas");
    const dataUrl = canvas ? canvas.toDataURL("image/png") : "";
    return [dataUrl];
  };

  function initAllCensorPanels() {
    const roots = document.querySelectorAll("#censor_panel_root");
    roots.forEach((root) => setupCensorPanel(root));
  }

  const observer = new MutationObserver(() => initAllCensorPanels());
  observer.observe(document.documentElement, { childList: true, subtree: true });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => setTimeout(initAllCensorPanels, 400));
  } else {
    setTimeout(initAllCensorPanels, 400);
  }
})();
