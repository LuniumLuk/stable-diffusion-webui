(function () {
  function makeComposerController(root) {
    const state = {
      layers: [],
      active: -1,
      lockToSelected: false,
      lockEditBackground: false,
      backgroundLocked: true,
      assets: [],
      assetKeys: new Set(),
      dragMode: null,
      startX: 0,
      startY: 0,
      startLayer: null,
      startDist: 0,
      startAngle: 0,
      tool: "move",
      drawColor: "#ff3366",
      brushSize: 18,
      linePreview: null,
      cropSelection: null,
      cropPreview: null,
      brushLastPoint: null,
      viewportX: 0,
      viewportY: 0,
      viewportScale: 1,
      viewportScaleMin: 0.25,
      // Maximum number of CSS pixels a single canvas internal pixel may map to
      // (adaptive max scale = maxCanvasPixelScreen * canvas.width / clientWidth)
      maxCanvasPixelScreen: 8,
      startClientX: 0,
      startClientY: 0,
      startViewportX: 0,
      startViewportY: 0,
      useColorBackground: false,
      backgroundColor: "#1e293b",
      paintUndoStack: [],
      paintRedoStack: [],
      maxPaintHistory: 80,
    };

    const canvas = root.querySelector("#composer_canvas");
    const ctx = canvas.getContext("2d");
    const canvasWrap = root.querySelector("#composer_canvas_wrap");
    const bgUploadWrap = document.getElementById("composer_bg_upload");
    const charsUploadWrap = document.getElementById("composer_chars_upload");
    const layerList = root.querySelector("#composer_layers");
    const assetList = root.querySelector("#composer_assets");
    const lockModeBtn = root.querySelector("#composer_lock_mode_btn");
    const bgLockBtn = root.querySelector("#composer_bg_lock_btn");
    const restoreBgBtn = root.querySelector("#composer_restore_bg_btn");
    const bgColorInput = root.querySelector("#composer_bg_color");
    const bgColorApplyBtn = root.querySelector("#composer_bg_color_apply");
    const bgColorRandomBtn = root.querySelector("#composer_bg_color_random");
    const mirrorBtn = root.querySelector("#composer_mirror_btn");
    const deleteBtn = root.querySelector("#composer_delete_btn");
    const layerUpBtn = root.querySelector("#composer_layer_up_btn");
    const layerDownBtn = root.querySelector("#composer_layer_down_btn");
    const toolMoveBtn = root.querySelector("#composer_tool_move_btn");
    const toolBrushBtn = root.querySelector("#composer_tool_brush_btn");
    const toolLineBtn = root.querySelector("#composer_tool_line_btn");
    const toolPickerBtn = root.querySelector("#composer_tool_picker_btn");
    const toolCropBtn = root.querySelector("#composer_tool_crop_btn");
    const drawColorInput = root.querySelector("#composer_draw_color");
    const brushSizeInput = root.querySelector("#composer_brush_size");
    const brushSizeValue = root.querySelector("#composer_brush_size_value");
    const cropApplyBtn = root.querySelector("#composer_crop_apply_btn");
    const cropCancelBtn = root.querySelector("#composer_crop_cancel_btn");
    const statusText = root.querySelector("#composer_status_text");

    const toolButtons = {
      move: toolMoveBtn,
      brush: toolBrushBtn,
      line: toolLineBtn,
      picker: toolPickerBtn,
      crop: toolCropBtn,
    };

    function updateLockModeUi() {
      if (!lockModeBtn) return;
      lockModeBtn.textContent = state.lockToSelected
        ? "Lock to Selected: ON"
        : "Lock to Selected: OFF";
      lockModeBtn.classList.toggle("active", state.lockToSelected);
    }

    function updateBgLockUi() {
      if (!bgLockBtn) return;
      bgLockBtn.textContent = state.lockEditBackground
        ? "Edit BG Only: ON"
        : "Edit BG Only: OFF";
      bgLockBtn.classList.toggle("active", state.lockEditBackground);
    }

    function setStatus(text) {
      statusText.textContent = text;
    }

    function updateToolUi() {
      Object.entries(toolButtons).forEach(([name, btn]) => {
        if (btn) {
          btn.classList.toggle("active", state.tool === name);
        }
      });

      if (brushSizeValue) {
        brushSizeValue.textContent = `${state.brushSize} px`;
      }
      // update canvas cursor for active tool
      try {
        if (canvas) {
          if (state.dragMode === "pan_canvas") {
            canvas.style.cursor = "grabbing";
          } else {
            switch (state.tool) {
              case "move":
                canvas.style.cursor = "grab";
                break;
              case "brush":
              case "line":
                canvas.style.cursor = "crosshair";
                break;
              case "picker":
                canvas.style.cursor = "crosshair";
                break;
              case "crop":
                canvas.style.cursor = "crosshair";
                break;
              default:
                canvas.style.cursor = "default";
            }
          }
        }
      } catch (e) {
        // ignore cursor errors in odd environments
      }
    }

    // Cursor position tracking for preview placement
    state.cursorClientX = null;
    state.cursorClientY = null;
    let _sizePreviewTimeout = null;

    function ensureSizePreviewEl() {
      // make a unique id for this composer root so multiple composer instances
      // don't collide
      const uid = root.dataset.composerUid || (root.dataset.composerUid = crypto.randomUUID());
      let el = document.querySelector(`.composer-size-preview[data-composer-uid="${uid}"]`);
      if (el) return el;
      // container
      el = document.createElement('div');
      el.className = 'composer-size-preview';
      el.setAttribute('data-composer-uid', uid);
      Object.assign(el.style, {
        position: 'fixed',
        pointerEvents: 'none',
        zIndex: 10000,
        left: '0px',
        top: '0px',
        transform: 'translate(-50%, -50%)',
        display: 'none',
      });

      // inner dot
      const dot = document.createElement('div');
      dot.className = 'composer-size-preview-dot';
      Object.assign(dot.style, {
        border: '2px solid rgba(255,255,255,0.85)',
        borderRadius: '50%',
        background: 'rgba(0,0,0,0.12)',
        boxSizing: 'border-box',
        transform: 'translate(-50%, -50%)',
        position: 'absolute',
        left: '50%',
        top: '50%',
      });
      el.appendChild(dot);

      // label
      const label = document.createElement('div');
      label.className = 'composer-size-preview-label';
      Object.assign(label.style, {
        position: 'absolute',
        left: '50%',
        top: 'calc(50% + 8px)',
        transform: 'translateX(-50%)',
        color: '#fff',
        background: 'rgba(0,0,0,0.6)',
        fontSize: '12px',
        padding: '2px 6px',
        borderRadius: '4px',
        whiteSpace: 'nowrap',
        pointerEvents: 'none',
      });
      el.appendChild(label);

      // store references for quick access
      el._dot = dot;
      el._label = label;

      document.body.appendChild(el);
      return el;
    }

    function showSizePreview(clientX, clientY) {
      const el = ensureSizePreviewEl();
      if (!el) return;
          // fallback to last-known cursor if event didn't provide coords
          const rect = canvas.getBoundingClientRect();
          const x = (clientX || clientX === 0) ? clientX : (state.cursorClientX || (rect.left + rect.width / 2));
          const y = (clientY || clientY === 0) ? clientY : (state.cursorClientY || (rect.top + rect.height / 2));
          // Determine the target layer for painting (paint overlay if present,
          // otherwise the active layer). The stroke width used when drawing is
          // `state.brushSize / layer.scale` in canvas/internal pixels. Convert
          // that to CSS pixels for the DOM preview by multiplying with
          // (rect.width / canvas.width).
      const paintLayer = state.layers.find((x) => x.isPaintOverlay) || state.layers[state.active] || null;
      const layerScale = paintLayer ? Math.max(0.05, paintLayer.scale || 1) : 1;
      const editLineWidth = Math.max(1, state.brushSize / layerScale);
      const sizeCss = Math.max(1, Math.round(editLineWidth * (rect.width / canvas.width)));
      // debug logging removed
      // update inner dot and label
      if (el._dot) {
        el._dot.style.width = `${sizeCss}px`;
        el._dot.style.height = `${sizeCss}px`;
      } else {
        el.style.width = `${sizeCss}px`;
        el.style.height = `${sizeCss}px`;
      }
      if (el._label) {
        el._label.textContent = `${Math.round(state.brushSize)} px`;
      }
      el.style.left = `${x}px`;
      el.style.top = `${y}px`;
      el.style.display = 'block';
      // force reflow so size change is applied immediately
      // eslint-disable-next-line no-unused-expressions
      el.offsetWidth;
      if (_sizePreviewTimeout) clearTimeout(_sizePreviewTimeout);
      _sizePreviewTimeout = setTimeout(() => {
        el.style.display = 'none';
        _sizePreviewTimeout = null;
      }, 900);
    }

    function hideSizePreview() {
      const uid = root.dataset.composerUid;
      if (!uid) return;
      const sel = `.composer-size-preview[data-composer-uid="${uid}"]`;
      const el = document.querySelector(sel);
      if (!el) return;
      if (_sizePreviewTimeout) {
        clearTimeout(_sizePreviewTimeout);
        _sizePreviewTimeout = null;
      }
      el.style.display = 'none';
    }

    function setTool(toolName) {
      state.tool = toolName;
      if (toolName !== "crop") {
        state.cropPreview = null;
      }
      if (toolName !== "line") {
        state.linePreview = null;
      }
      updateToolUi();
      draw();
    }

    function getBackgroundIndex() {
      return state.layers.findIndex((x) => x.isBackground);
    }

    function canEditLayer(layer) {
      if (!layer) return false;
      if (layer.isBackground && state.backgroundLocked && !state.lockEditBackground) {
        return false;
      }
      if (state.lockEditBackground) {
        return !!layer.isBackground;
      }
      return true;
    }

    function setActiveToBackground() {
      const bgIndex = getBackgroundIndex();
      if (bgIndex >= 0) {
        state.active = bgIndex;
      }
    }

    function restoreBackgroundTransform() {
      const bgIndex = getBackgroundIndex();
      if (bgIndex < 0) {
        setStatus("No background layer to restore.");
        return;
      }

      const bgLayer = state.layers[bgIndex];
      bgLayer.x = canvas.width / 2;
      bgLayer.y = canvas.height / 2;
      bgLayer.scale = 1;
      bgLayer.rot = 0;
      bgLayer.mirror = false;

      state.active = bgIndex;
      renderLayerList();
      draw();
      setStatus("Background transform restored.");
    }

    function uiPxToCanvas(px) {
      const rect = canvas.getBoundingClientRect();
      if (!rect || rect.width <= 0) {
        return px;
      }
      return px * (canvas.width / rect.width);
    }

    function applyCanvasViewport() {
      canvas.style.transformOrigin = "0 0";
      canvas.style.transform = `translate(${state.viewportX}px, ${state.viewportY}px) scale(${state.viewportScale})`;

      // Choose filtering strategy:
      // - When magnifying (viewportScale >= 1) use nearest (pixelated) for crisp zoom-in
      // - When minifying (viewportScale < 1) use smoothing (area-like) for better downscale
      try {
        if (state.viewportScale >= 1) {
          canvas.style.imageRendering = "pixelated";
          if (ctx && typeof ctx.imageSmoothingEnabled !== 'undefined') {
            ctx.imageSmoothingEnabled = false;
          }
        } else {
          canvas.style.imageRendering = "auto";
          if (ctx && typeof ctx.imageSmoothingEnabled !== 'undefined') {
            ctx.imageSmoothingEnabled = true;
            if (typeof ctx.imageSmoothingQuality !== 'undefined') {
              ctx.imageSmoothingQuality = 'high';
            }
          }
        }
      } catch (e) {
        // ignore browser-specific failures
      }
    }

    function captureLayerSnapshot(layer) {
      if (!layer || !layer.img) return null;
      const editable = ensureEditableLayerCanvas(layer);
      if (!editable) return null;

      return {
        layerId: layer.id,
        dataUrl: editable.toDataURL("image/png"),
      };
    }

    async function restoreLayerSnapshot(snapshot) {
      if (!snapshot || !snapshot.layerId || !snapshot.dataUrl) return false;
      const layer = state.layers.find((x) => x.id === snapshot.layerId);
      if (!layer) return false;

      const img = await loadImageFromDataUrl(snapshot.dataUrl);
      if (!img) return false;

      const restored = document.createElement("canvas");
      restored.width = Math.max(1, img.width);
      restored.height = Math.max(1, img.height);
      restored.getContext("2d").drawImage(img, 0, 0);
      updateLayerImageSource(layer, restored);
      return true;
    }

    function pushPaintUndoSnapshot(layer) {
      const snap = captureLayerSnapshot(layer);
      if (!snap) return;

      state.paintUndoStack.push(snap);
      if (state.paintUndoStack.length > state.maxPaintHistory) {
        state.paintUndoStack.shift();
      }
      state.paintRedoStack = [];
    }

    async function undoPaint() {
      if (state.paintUndoStack.length === 0) {
        setStatus("Nothing to undo.");
        return;
      }

      const overlay = ensurePaintOverlayLayer();
      const current = captureLayerSnapshot(overlay);
      const previous = state.paintUndoStack.pop();
      if (!previous) {
        setStatus("Nothing to undo.");
        return;
      }

      if (current) {
        state.paintRedoStack.push(current);
        if (state.paintRedoStack.length > state.maxPaintHistory) {
          state.paintRedoStack.shift();
        }
      }

      const restored = await restoreLayerSnapshot(previous);
      if (restored) {
        draw();
        setStatus("Undo paint stroke.");
      } else {
        setStatus("Undo failed.");
      }
    }

    async function redoPaint() {
      if (state.paintRedoStack.length === 0) {
        setStatus("Nothing to redo.");
        return;
      }

      const overlay = ensurePaintOverlayLayer();
      const current = captureLayerSnapshot(overlay);
      const next = state.paintRedoStack.pop();
      if (!next) {
        setStatus("Nothing to redo.");
        return;
      }

      if (current) {
        state.paintUndoStack.push(current);
        if (state.paintUndoStack.length > state.maxPaintHistory) {
          state.paintUndoStack.shift();
        }
      }

      const restored = await restoreLayerSnapshot(next);
      if (restored) {
        draw();
        setStatus("Redo paint stroke.");
      } else {
        setStatus("Redo failed.");
      }
    }

    function getLayerSize(layer) {
      return {
        w: layer.img.width * layer.scale,
        h: layer.img.height * layer.scale,
      };
    }

    function clearUploadWidget(uploadWrap) {
      if (!uploadWrap) return;

      const clearBtn = uploadWrap.querySelector('button[aria-label*="Clear"], button[title*="Clear"], .clear-button');
      if (clearBtn) {
        clearBtn.click();
      }

      uploadWrap.querySelectorAll('input[type="file"]').forEach((el) => {
        el.value = "";
      });
    }

    function loadImageFromFile(file) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
          const img = new Image();
          img.onload = () => resolve(img);
          img.onerror = reject;
          img.src = reader.result;
        };
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
    }

    function loadImageFromDataUrl(src) {
      return new Promise((resolve) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => resolve(null);
        img.src = src;
      });
    }

    async function restoreFromConfigJson(configJson) {
      let payload;
      try {
        payload = JSON.parse(configJson);
      } catch (e) {
        setStatus("Failed to parse config file.");
        return;
      }

      if (payload.width && payload.height) {
        canvas.width = payload.width;
        canvas.height = payload.height;
      }

      if (payload.background_color) {
        state.useColorBackground = true;
        state.backgroundColor = payload.background_color;
        const bgColorInput = root.querySelector("#composer_bg_color");
        if (bgColorInput) bgColorInput.value = payload.background_color;
      } else {
        state.useColorBackground = false;
      }

      const layers = [];
      for (const ld of payload.layers || []) {
        if (!ld.src) continue;
        const img = await loadImageFromDataUrl(ld.src);
        if (!img) continue;
        layers.push({
          id: crypto.randomUUID(),
          name: ld.name || "Layer",
          src: ld.src,
          img,
          x: ld.x,
          y: ld.y,
          scale: ld.scale,
          rot: ((ld.rot_deg || 0) * Math.PI) / 180,
          mirror: ld.mirror || false,
          opacity: ld.opacity !== undefined ? ld.opacity : 1,
          isBackground: ld.is_background || false,
          isPaintOverlay: ld.is_paint_overlay || false,
        });
      }

      state.layers = layers;
      state.active = layers.length > 0 ? 0 : -1;

      // Restore foreground layers (non-background, non-overlay) back into the staged assets panel.
      state.assets = [];
      state.assetKeys = new Set();
      for (const layer of layers) {
        if (layer.isBackground || layer.isPaintOverlay) continue;
        const key = `restored::${layer.name}`;
        if (state.assetKeys.has(key)) continue;
        state.assets.push({
          id: crypto.randomUUID(),
          key,
          name: layer.name,
          img: layer.img,
          src: layer.src,
        });
        state.assetKeys.add(key);
      }

      renderLayerList();
      renderAssetList();
      fitCanvasToParent();
      draw();
      setStatus(`Config loaded: ${layers.length} layer(s), ${state.assets.length} asset(s) restored.`);
    }

    state.restoreFromConfigJson = restoreFromConfigJson;

    function fitCanvasToParent() {
      const wrap = root.querySelector("#composer_canvas_wrap");
      if (!wrap) return;
      
      // Get canvas internal aspect ratio
      const internalAspect = canvas.width / canvas.height;
      
      // Calculate available space
      const maxW = Math.max(640, wrap.clientWidth - 16);
      const maxH = Math.max(420, Math.floor(window.innerHeight * 0.68));
      
      // Fit to available space while preserving internal aspect ratio
      let cssW = maxW;
      let cssH = cssW / internalAspect;
      
      if (cssH > maxH) {
        cssH = maxH;
        cssW = cssH * internalAspect;
      }
      
      canvas.style.width = cssW + "px";
      canvas.style.height = cssH + "px";
      applyCanvasViewport();
    }

    function drawLayer(layer) {
      const img = layer.img;
      const { w, h } = getLayerSize(layer);
      const lineWidth = Math.max(1, uiPxToCanvas(2));
      const handleSize = Math.max(8, uiPxToCanvas(12));
      const rotateDistance = Math.max(12, uiPxToCanvas(24));
      const rotateRadius = Math.max(4, uiPxToCanvas(7));

      ctx.save();
      ctx.translate(layer.x, layer.y);
      ctx.rotate(layer.rot);
      ctx.scale(layer.mirror ? -1 : 1, 1);
      ctx.globalAlpha = layer.opacity;
      ctx.drawImage(img, -w / 2, -h / 2, w, h);
      ctx.restore();

      if (layer.selected) {
        ctx.save();
        ctx.translate(layer.x, layer.y);
        ctx.rotate(layer.rot);
        ctx.strokeStyle = "#38bdf8";
        ctx.lineWidth = lineWidth;
        ctx.strokeRect(-w / 2, -h / 2, w, h);
        ctx.fillStyle = "#22d3ee";
        ctx.fillRect(w / 2 - handleSize / 2, h / 2 - handleSize / 2, handleSize, handleSize);
        ctx.beginPath();
        ctx.arc(0, -h / 2 - rotateDistance, rotateRadius, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
    }

    function drawCropOverlay(selection) {
      if (!selection || state.active < 0) return;

      const layer = state.layers[state.active];
      if (!layer || selection.layerId !== layer.id) return;

      const startDisplay = imageLocalToDisplayLocal(layer, selection.start);
      const endDisplay = imageLocalToDisplayLocal(layer, selection.end);
      const x = Math.min(startDisplay.x, endDisplay.x);
      const y = Math.min(startDisplay.y, endDisplay.y);
      const w = Math.abs(endDisplay.x - startDisplay.x);
      const h = Math.abs(endDisplay.y - startDisplay.y);

      ctx.save();
      ctx.translate(layer.x, layer.y);
      ctx.rotate(layer.rot);
      ctx.strokeStyle = "#f59e0b";
      ctx.fillStyle = "rgba(245, 158, 11, 0.14)";
      ctx.lineWidth = Math.max(1, uiPxToCanvas(2));
      ctx.setLineDash([uiPxToCanvas(8), uiPxToCanvas(6)]);
      ctx.fillRect(x, y, w, h);
      ctx.strokeRect(x, y, w, h);
      ctx.restore();
    }

    function drawLineOverlay(preview) {
      if (!preview || state.active < 0) return;

      const layer = state.layers[state.active];
      if (!layer || preview.layerId !== layer.id) return;

      // Convert image-local points to display-local (layer space) then
      // account for canvas viewport scaling so the preview line width
      // matches the apparent size on-screen.
      const startDisplay = imageLocalToDisplayLocal(layer, preview.start);
      const endDisplay = imageLocalToDisplayLocal(layer, preview.end);

      // The actual stroke drawing uses a line width in canvas/internal
      // pixels equal to `state.brushSize / layer.scale`. Use the same value
      // here so the preview line thickness matches the final stroke.
      const adjustedWidth = Math.max(1, state.brushSize / Math.max(0.05, layer.scale || 1));
      // debug logging removed

      ctx.save();
      ctx.translate(layer.x, layer.y);
      ctx.rotate(layer.rot);
      ctx.strokeStyle = state.drawColor;
      ctx.lineWidth = adjustedWidth;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(startDisplay.x, startDisplay.y);
      ctx.lineTo(endDisplay.x, endDisplay.y);
      ctx.stroke();
      ctx.restore();
    }

    function renderBaseCanvas() {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      if (state.useColorBackground && state.backgroundColor) {
        ctx.save();
        ctx.fillStyle = state.backgroundColor;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.restore();
      }
      state.layers.forEach((layer, i) => {
        layer.selected = i === state.active;
        drawLayer(layer);
      });
    }

    function draw() {
      renderBaseCanvas();
      drawLineOverlay(state.linePreview);
      drawCropOverlay(state.cropPreview || state.cropSelection);
    }

    function applyColorBackground(hexColor) {
      const color = (hexColor || "").trim();
      if (!/^#[0-9a-fA-F]{6}$/.test(color)) return;

      const bgIndex = getBackgroundIndex();
      if (bgIndex >= 0) {
        state.layers.splice(bgIndex, 1);
        if (state.active === bgIndex) {
          state.active = Math.min(bgIndex, state.layers.length - 1);
        } else if (state.active > bgIndex) {
          state.active -= 1;
        }
      }

      state.useColorBackground = true;
      state.backgroundColor = color;
      renderLayerList();
      draw();
      setStatus(`Background color set: ${color}`);
    }

    function randomHexColor() {
      const n = Math.floor(Math.random() * 0xffffff);
      return `#${n.toString(16).padStart(6, "0")}`;
    }

    function renderLayerList() {
      layerList.innerHTML = "";
      state.layers.forEach((layer, i) => {
        const item = document.createElement("div");
        item.className = "composer-layer-item" + (i === state.active ? " active" : "");
        const label = layer.isBackground
          ? `BG. ${layer.name}`
          : layer.isPaintOverlay
            ? `Top Paint Layer`
            : `${i + 1}. ${layer.name}`;
        item.textContent = label;
        item.onclick = () => {
          state.active = i;
          renderLayerList();
          draw();
        };
        layerList.appendChild(item);
      });
    }

    function renderAssetList() {
      if (!assetList) return;

      assetList.innerHTML = "";
      if (state.assets.length === 0) {
        const empty = document.createElement("div");
        empty.textContent = "No staged images yet.";
        empty.style.color = "#94a3b8";
        empty.style.fontSize = "12px";
        assetList.appendChild(empty);
        return;
      }

      state.assets.forEach((asset) => {
        const card = document.createElement("div");
        card.className = "composer-asset-item";

        const img = document.createElement("img");
        img.src = asset.src;
        img.alt = asset.name;
        card.appendChild(img);

        const meta = document.createElement("div");
        meta.className = "composer-asset-meta";

        const name = document.createElement("div");
        name.className = "composer-asset-name";
        name.textContent = asset.name;
        meta.appendChild(name);

        const actions = document.createElement("div");
        actions.className = "composer-asset-actions";

        const addBtn = document.createElement("button");
        addBtn.type = "button";
        addBtn.textContent = "Add to Layers";
        addBtn.addEventListener("click", () => {
          addAssetToLayers(asset);
        });
        actions.appendChild(addBtn);

        const removeBtn = document.createElement("button");
        removeBtn.type = "button";
        removeBtn.textContent = "Remove";
        removeBtn.addEventListener("click", () => {
          state.assets = state.assets.filter((x) => x.id !== asset.id);
          state.assetKeys.delete(asset.key);
          renderAssetList();
          setStatus(`Removed staged image: ${asset.name}`);
        });
        actions.appendChild(removeBtn);

        meta.appendChild(actions);
        card.appendChild(meta);
        assetList.appendChild(card);
      });
    }

    function makeLayerFromImage(img, name, isBackground = false) {
      return {
        id: crypto.randomUUID(),
        name,
        src: img.src,
        img,
        x: canvas.width / 2,
        y: canvas.height / 2,
        scale: 1,
        rot: 0,
        mirror: false,
        opacity: 1,
        isBackground,
      };
    }

    function getActiveLayer() {
      return state.active >= 0 ? state.layers[state.active] : null;
    }

    function syncPaintOverlaySize(layer) {
      const nextCanvas = document.createElement("canvas");
      nextCanvas.width = Math.max(1, canvas.width);
      nextCanvas.height = Math.max(1, canvas.height);
      nextCanvas.getContext("2d").drawImage(layer.img, 0, 0, nextCanvas.width, nextCanvas.height);
      layer.img = nextCanvas;
      layer.src = nextCanvas.toDataURL("image/png");
      layer.x = canvas.width / 2;
      layer.y = canvas.height / 2;
      layer.scale = 1;
      layer.rot = 0;
      layer.mirror = false;
      layer.opacity = 1;
    }

    function ensurePaintOverlayLayer() {
      let overlayIndex = state.layers.findIndex((x) => x.isPaintOverlay);
      let overlay = overlayIndex >= 0 ? state.layers[overlayIndex] : null;

      if (!overlay) {
        const overlayCanvas = document.createElement("canvas");
        overlayCanvas.width = Math.max(1, canvas.width);
        overlayCanvas.height = Math.max(1, canvas.height);
        overlay = makeLayerFromImage(overlayCanvas, "Top Paint Layer", false);
        overlay.isPaintOverlay = true;
        overlay.x = canvas.width / 2;
        overlay.y = canvas.height / 2;
        overlay.scale = 1;
        overlay.rot = 0;
        overlay.mirror = false;
        state.layers.push(overlay);
        overlayIndex = state.layers.length - 1;
      }

      if (overlay.img.width !== canvas.width || overlay.img.height !== canvas.height) {
        syncPaintOverlaySize(overlay);
      }

      if (overlayIndex !== state.layers.length - 1) {
        state.layers.splice(overlayIndex, 1);
        state.layers.push(overlay);
        if (state.active === overlayIndex) {
          state.active = state.layers.length - 1;
        } else if (state.active > overlayIndex) {
          state.active -= 1;
        }
      }

      return state.layers[state.layers.length - 1];
    }

    function addAssetToLayers(asset) {
      const layer = makeLayerFromImage(asset.img, asset.name, false);
      const overlayIndex = state.layers.findIndex((x) => x.isPaintOverlay);
      if (overlayIndex >= 0) {
        state.layers.splice(overlayIndex, 0, layer);
        state.active = overlayIndex;
      } else {
        state.layers.push(layer);
        state.active = state.layers.length - 1;
      }
      renderLayerList();
      draw();
      setStatus(`Added to layers: ${asset.name}`);
    }

    async function addAssetFromFile(file) {
      const key = `${file.name}::${file.size}::${file.lastModified}`;
      if (state.assetKeys.has(key)) {
        return;
      }

      const img = await loadImageFromFile(file);
      state.assets.push({
        id: crypto.randomUUID(),
        key,
        name: file.name,
        img,
        src: img.src,
      });
      state.assetKeys.add(key);
    }

    function getMousePos(evt) {
      const rect = canvas.getBoundingClientRect();
      const scaleX = canvas.width / rect.width;
      const scaleY = canvas.height / rect.height;
      return {
        x: (evt.clientX - rect.left) * scaleX,
        y: (evt.clientY - rect.top) * scaleY,
      };
    }

    function toDisplayLocal(layer, px, py) {
      const dx = px - layer.x;
      const dy = py - layer.y;
      const c = Math.cos(-layer.rot);
      const s = Math.sin(-layer.rot);
      return {
        x: dx * c - dy * s,
        y: dx * s + dy * c,
      };
    }

    function displayLocalToImageLocal(layer, point) {
      return {
        x: layer.mirror ? -point.x : point.x,
        y: point.y,
      };
    }

    function imageLocalToDisplayLocal(layer, point) {
      return {
        x: layer.mirror ? -point.x : point.x,
        y: point.y,
      };
    }

    function toImageLocal(layer, px, py) {
      return displayLocalToImageLocal(layer, toDisplayLocal(layer, px, py));
    }

    function localToImagePixel(layer, imageLocalPoint) {
      const { w, h } = getLayerSize(layer);
      const x = ((imageLocalPoint.x + w / 2) / Math.max(1, w)) * layer.img.width;
      const y = ((imageLocalPoint.y + h / 2) / Math.max(1, h)) * layer.img.height;
      return {
        x: Math.max(0, Math.min(layer.img.width, x)),
        y: Math.max(0, Math.min(layer.img.height, y)),
      };
    }

    function getDisplayBoundsHit(layer, px, py) {
      const { w, h } = getLayerSize(layer);
      const local = toDisplayLocal(layer, px, py);
      return Math.abs(local.x) <= w / 2 && Math.abs(local.y) <= h / 2;
    }

    function getTopEditableLayerAt(px, py) {
      if (state.lockEditBackground) {
        const bgIndex = getBackgroundIndex();
        if (bgIndex < 0) return null;
        const bgLayer = state.layers[bgIndex];
        if (!canEditLayer(bgLayer) || !getDisplayBoundsHit(bgLayer, px, py)) return null;
        return { index: bgIndex, layer: bgLayer };
      }

      if (state.lockToSelected && state.active >= 0) {
        const selectedLayer = state.layers[state.active];
        if (!canEditLayer(selectedLayer) || !getDisplayBoundsHit(selectedLayer, px, py)) return null;
        return { index: state.active, layer: selectedLayer };
      }

      for (let i = state.layers.length - 1; i >= 0; i--) {
        const layer = state.layers[i];
        if (!canEditLayer(layer)) continue;
        if (getDisplayBoundsHit(layer, px, py)) {
          return { index: i, layer };
        }
      }

      return null;
    }

    function getPaintOverlayPoint(px, py) {
      const overlay = ensurePaintOverlayLayer();
      return {
        layer: overlay,
        point: toImageLocal(overlay, px, py),
      };
    }

    function ensureEditableLayerCanvas(layer) {
      if (!layer) return null;
      if (layer.img instanceof HTMLCanvasElement) {
        return layer.img;
      }

      const editable = document.createElement("canvas");
      editable.width = Math.max(1, layer.img.width);
      editable.height = Math.max(1, layer.img.height);
      const editCtx = editable.getContext("2d");
      editCtx.drawImage(layer.img, 0, 0);
      layer.img = editable;
      layer.src = editable.toDataURL("image/png");
      return editable;
    }

    function updateLayerImageSource(layer, canvasEl) {
      layer.img = canvasEl;
      layer.src = canvasEl.toDataURL("image/png");
    }

    function imageLocalToWorld(layer, point) {
      const displayLocal = imageLocalToDisplayLocal(layer, point);
      const worldOffset = rotateLocalToWorld(layer, displayLocal);
      return {
        x: layer.x + worldOffset.x,
        y: layer.y + worldOffset.y,
      };
    }

    function buildBackgroundClipPolygon() {
      const bgIndex = getBackgroundIndex();
      if (bgIndex < 0) return null;
      const bg = state.layers[bgIndex];
      if (!bg || !bg.img) return null;

      const { w, h } = getLayerSize(bg);
      const corners = [
        { x: -w / 2, y: -h / 2 },
        { x: w / 2, y: -h / 2 },
        { x: w / 2, y: h / 2 },
        { x: -w / 2, y: h / 2 },
      ];

      return corners.map((p) => imageLocalToWorld(bg, p));
    }

    function applyBackgroundClipIfNeeded(editCtx, layer) {
      if (!editCtx || !layer || !layer.isPaintOverlay) return;

      const poly = buildBackgroundClipPolygon();
      if (!poly || poly.length < 3) return;

      editCtx.beginPath();
      editCtx.moveTo(poly[0].x, poly[0].y);
      for (let i = 1; i < poly.length; i++) {
        editCtx.lineTo(poly[i].x, poly[i].y);
      }
      editCtx.closePath();
      editCtx.clip();
    }

    function strokeOnLayer(layer, startLocal, endLocal) {
      const editCanvas = ensureEditableLayerCanvas(layer);
      if (!editCanvas) return;

      const editCtx = editCanvas.getContext("2d");
      const startPx = localToImagePixel(layer, startLocal);
      const endPx = localToImagePixel(layer, endLocal);
      editCtx.save();
      applyBackgroundClipIfNeeded(editCtx, layer);
      editCtx.strokeStyle = state.drawColor;
      editCtx.lineCap = "round";
      editCtx.lineJoin = "round";
      editCtx.lineWidth = Math.max(1, state.brushSize / Math.max(0.05, layer.scale));
      editCtx.beginPath();
      editCtx.moveTo(startPx.x, startPx.y);
      editCtx.lineTo(endPx.x, endPx.y);
      editCtx.stroke();
      editCtx.restore();
      updateLayerImageSource(layer, editCanvas);
    }

    function sampleCanvasColor(px, py) {
      renderBaseCanvas();
      const data = ctx.getImageData(Math.round(px), Math.round(py), 1, 1).data;
      draw();
      return `#${[data[0], data[1], data[2]].map((value) => value.toString(16).padStart(2, "0")).join("")}`;
    }

    function rotateLocalToWorld(layer, point) {
      const c = Math.cos(layer.rot);
      const s = Math.sin(layer.rot);
      return {
        x: point.x * c - point.y * s,
        y: point.x * s + point.y * c,
      };
    }

    function normalizeCropSelection(selection) {
      if (!selection) return null;

      return {
        x1: Math.min(selection.start.x, selection.end.x),
        y1: Math.min(selection.start.y, selection.end.y),
        x2: Math.max(selection.start.x, selection.end.x),
        y2: Math.max(selection.start.y, selection.end.y),
      };
    }

    function applyCropSelection() {
      const selection = state.cropSelection;
      const layer = getActiveLayer();
      if (!selection || !layer || selection.layerId !== layer.id) {
        setStatus("No crop selection to apply.");
        return;
      }

      const normalized = normalizeCropSelection(selection);
      const startPx = localToImagePixel(layer, { x: normalized.x1, y: normalized.y1 });
      const endPx = localToImagePixel(layer, { x: normalized.x2, y: normalized.y2 });
      const cropX = Math.max(0, Math.floor(Math.min(startPx.x, endPx.x)));
      const cropY = Math.max(0, Math.floor(Math.min(startPx.y, endPx.y)));
      const cropW = Math.max(1, Math.ceil(Math.abs(endPx.x - startPx.x)));
      const cropH = Math.max(1, Math.ceil(Math.abs(endPx.y - startPx.y)));

      if (cropW < 2 || cropH < 2) {
        setStatus("Crop area is too small.");
        return;
      }

      const sourceCanvas = ensureEditableLayerCanvas(layer);
      const cropped = document.createElement("canvas");
      cropped.width = cropW;
      cropped.height = cropH;
      cropped.getContext("2d").drawImage(sourceCanvas, cropX, cropY, cropW, cropH, 0, 0, cropW, cropH);

      const cropCenterImage = {
        x: (normalized.x1 + normalized.x2) / 2,
        y: (normalized.y1 + normalized.y2) / 2,
      };
      const cropCenterDisplay = imageLocalToDisplayLocal(layer, cropCenterImage);
      const worldShift = rotateLocalToWorld(layer, cropCenterDisplay);

      layer.x += worldShift.x;
      layer.y += worldShift.y;
      updateLayerImageSource(layer, cropped);
      state.cropSelection = null;
      state.cropPreview = null;
      draw();
      setStatus(`Cropped layer: ${layer.name}`);
    }

    function hitTest(px, py) {
      const handleHitPadding = Math.max(8, uiPxToCanvas(12));
      const rotateDistance = Math.max(12, uiPxToCanvas(24));
      const rotateHitRadius = Math.max(7, uiPxToCanvas(10));

      if (state.lockEditBackground) {
        const bgIndex = getBackgroundIndex();
        if (bgIndex < 0) return null;
        const layer = state.layers[bgIndex];
        const { w, h } = getLayerSize(layer);
        const local = toDisplayLocal(layer, px, py);

        const resizeX = w / 2;
        const resizeY = h / 2;
        if (Math.abs(local.x - resizeX) < handleHitPadding && Math.abs(local.y - resizeY) < handleHitPadding) {
          return { index: bgIndex, mode: "resize" };
        }

        if (Math.hypot(local.x, local.y + h / 2 + rotateDistance) < rotateHitRadius) {
          return { index: bgIndex, mode: "rotate" };
        }

        if (Math.abs(local.x) <= w / 2 && Math.abs(local.y) <= h / 2) {
          return { index: bgIndex, mode: "move" };
        }

        return null;
      }

      if (state.lockToSelected && state.active >= 0) {
        const layer = state.layers[state.active];
        if (!canEditLayer(layer)) return null;
        const { w, h } = getLayerSize(layer);
        const local = toDisplayLocal(layer, px, py);

        const resizeX = w / 2;
        const resizeY = h / 2;
        if (Math.abs(local.x - resizeX) < handleHitPadding && Math.abs(local.y - resizeY) < handleHitPadding) {
          return { index: state.active, mode: "resize" };
        }

        if (Math.hypot(local.x, local.y + h / 2 + rotateDistance) < rotateHitRadius) {
          return { index: state.active, mode: "rotate" };
        }

        if (Math.abs(local.x) <= w / 2 && Math.abs(local.y) <= h / 2) {
          return { index: state.active, mode: "move" };
        }

        return null;
      }

      for (let i = state.layers.length - 1; i >= 0; i--) {
        const layer = state.layers[i];
        if (!canEditLayer(layer)) continue;
        const { w, h } = getLayerSize(layer);
        const local = toDisplayLocal(layer, px, py);

        const resizeX = w / 2;
        const resizeY = h / 2;
        if (Math.abs(local.x - resizeX) < handleHitPadding && Math.abs(local.y - resizeY) < handleHitPadding) {
          return { index: i, mode: "resize" };
        }

        if (Math.hypot(local.x, local.y + h / 2 + rotateDistance) < rotateHitRadius) {
          return { index: i, mode: "rotate" };
        }

        if (Math.abs(local.x) <= w / 2 && Math.abs(local.y) <= h / 2) {
          return { index: i, mode: "move" };
        }
      }

      return null;
    }

    canvas.addEventListener("pointerdown", (evt) => {
      // track last pointer position for preview placement
      state.cursorClientX = evt.clientX;
      state.cursorClientY = evt.clientY;
      if (evt.button === 2) {
        evt.preventDefault();
        state.dragMode = "pan_canvas";
        state.startClientX = evt.clientX;
        state.startClientY = evt.clientY;
        state.startViewportX = state.viewportX;
        state.startViewportY = state.viewportY;
        if (canvasWrap) {
          canvasWrap.classList.add("panning");
        }
        canvas.setPointerCapture(evt.pointerId);
        return;
      }

      const p = getMousePos(evt);

      if (state.tool === "picker") {
        const color = sampleCanvasColor(p.x, p.y);
        state.drawColor = color;
        if (drawColorInput) {
          drawColorInput.value = color;
        }
        updateToolUi();
        setStatus(`Picked color ${color}`);
        return;
      }

      if (state.tool === "brush" || state.tool === "line" || state.tool === "crop") {
        if (state.tool === "brush" || state.tool === "line") {
          const paintTarget = getPaintOverlayPoint(p.x, p.y);
          const layer = paintTarget.layer;
          const imageLocal = paintTarget.point;
          state.active = state.layers.indexOf(layer);
          renderLayerList();

          if (state.tool === "brush") {
            pushPaintUndoSnapshot(layer);
            state.dragMode = "brush";
            state.brushLastPoint = imageLocal;
            strokeOnLayer(layer, imageLocal, imageLocal);
            draw();
          } else {
            state.dragMode = "line";
            state.linePreview = {
              layerId: layer.id,
              start: imageLocal,
              end: imageLocal,
            };
            draw();
          }

          canvas.setPointerCapture(evt.pointerId);
          return;
        }

        const layerHit = getTopEditableLayerAt(p.x, p.y);
        if (!layerHit) {
          if (!state.lockToSelected) {
            state.active = -1;
            renderLayerList();
            draw();
          }
          return;
        }

        state.active = layerHit.index;
        renderLayerList();
        const layer = layerHit.layer;
        const imageLocal = toImageLocal(layer, p.x, p.y);

        if (state.tool === "brush") {
          state.dragMode = "brush";
          state.brushLastPoint = imageLocal;
          strokeOnLayer(layer, imageLocal, imageLocal);
          draw();
        } else if (state.tool === "line") {
          state.dragMode = "line";
          state.linePreview = {
            layerId: layer.id,
            start: imageLocal,
            end: imageLocal,
          };
          draw();
        } else if (state.tool === "crop") {
          state.dragMode = "crop";
          state.cropPreview = {
            layerId: layer.id,
            start: imageLocal,
            end: imageLocal,
          };
          draw();
        }

        canvas.setPointerCapture(evt.pointerId);
        return;
      }

      const hit = hitTest(p.x, p.y);
      if (!hit) {
        if (!state.lockToSelected) {
          state.active = -1;
          renderLayerList();
          draw();
        }
        return;
      }

      state.active = hit.index;
      state.dragMode = hit.mode;
      state.startX = p.x;
      state.startY = p.y;
      state.startLayer = { ...state.layers[state.active] };

      const layer = state.layers[state.active];
      if (hit.mode === "resize") {
        state.startDist = Math.hypot(p.x - layer.x, p.y - layer.y);
      }
      if (hit.mode === "rotate") {
        state.startAngle = Math.atan2(p.y - layer.y, p.x - layer.x);
      }

      renderLayerList();
      draw();
      canvas.setPointerCapture(evt.pointerId);
    });

    canvas.addEventListener("pointermove", (evt) => {
      // update cursor position used by size preview
      state.cursorClientX = evt.clientX;
      state.cursorClientY = evt.clientY;
      if (state.dragMode === "pan_canvas") {
        state.viewportX = state.startViewportX + (evt.clientX - state.startClientX);
        state.viewportY = state.startViewportY + (evt.clientY - state.startClientY);
        applyCanvasViewport();
        return;
      }

      if (!state.dragMode || state.active < 0) return;

      const p = getMousePos(evt);
      const layer = state.layers[state.active];
      if (!layer) return;

      if (state.dragMode === "brush") {
        const imageLocal = toImageLocal(layer, p.x, p.y);
        strokeOnLayer(layer, state.brushLastPoint || imageLocal, imageLocal);
        state.brushLastPoint = imageLocal;
      } else if (state.dragMode === "line") {
        state.linePreview = {
          layerId: layer.id,
          start: state.linePreview ? state.linePreview.start : toImageLocal(layer, state.startX, state.startY),
          end: toImageLocal(layer, p.x, p.y),
        };
      } else if (state.dragMode === "crop") {
        state.cropPreview = {
          layerId: layer.id,
          start: state.cropPreview ? state.cropPreview.start : toImageLocal(layer, state.startX, state.startY),
          end: toImageLocal(layer, p.x, p.y),
        };
      } else if (state.dragMode === "move") {
        layer.x = state.startLayer.x + (p.x - state.startX);
        layer.y = state.startLayer.y + (p.y - state.startY);
      } else if (state.dragMode === "resize") {
        const dist = Math.hypot(p.x - state.startLayer.x, p.y - state.startLayer.y);
        const ratio = Math.max(0.05, dist / Math.max(1, state.startDist));
        layer.scale = Math.max(0.05, state.startLayer.scale * ratio);
      } else if (state.dragMode === "rotate") {
        const a = Math.atan2(p.y - state.startLayer.y, p.x - state.startLayer.x);
        layer.rot = state.startLayer.rot + (a - state.startAngle);
      }

      draw();
    });

    canvas.addEventListener("pointerup", () => {
      const layer = getActiveLayer();
      if (state.dragMode === "pan_canvas") {
        if (canvasWrap) {
          canvasWrap.classList.remove("panning");
        }
      } else if (state.dragMode === "line" && layer && state.linePreview && state.linePreview.layerId === layer.id) {
        pushPaintUndoSnapshot(layer);
        strokeOnLayer(layer, state.linePreview.start, state.linePreview.end);
        state.linePreview = null;
      } else if (state.dragMode === "crop" && state.cropPreview) {
        state.cropSelection = state.cropPreview;
        state.cropPreview = null;
        setStatus("Crop selection ready. Click Apply Crop to commit.");
      }

      state.dragMode = null;
      state.brushLastPoint = null;
      draw();
    });

    canvas.addEventListener("pointercancel", () => {
      if (canvasWrap) {
        canvasWrap.classList.remove("panning");
      }
      state.dragMode = null;
      state.brushLastPoint = null;
      state.linePreview = null;
      state.cropPreview = null;
      draw();
    });

    canvas.addEventListener("contextmenu", (evt) => {
      evt.preventDefault();
    });


    canvas.addEventListener("wheel", (evt) => {
      // Shift + wheel: adjust brush/line size when brush/line tool active
      if (evt.shiftKey && (state.tool === "brush" || state.tool === "line")) {
        evt.preventDefault();
        const step = evt.deltaY < 0 ? 1 : -1;
        state.brushSize = Math.max(1, Math.min(2048, state.brushSize + step));
        updateToolUi();
        setStatus(`${state.tool === "line" ? "Line" : "Brush"} size: ${state.brushSize} px`);
        showSizePreview(evt.clientX, evt.clientY);
        return;
      }

      // Ctrl/Meta + wheel: resize brush size if brush tool is active (legacy behavior)
      if ((evt.ctrlKey || evt.metaKey) && state.tool === "brush") {
        evt.preventDefault();
        const step = evt.deltaY < 0 ? 2 : -2;
        state.brushSize = Math.max(1, Math.min(512, state.brushSize + step));
        updateToolUi();
        setStatus(`Brush size: ${state.brushSize} px`);
        showSizePreview(evt.clientX, evt.clientY);
        return;
      }

      // Default: canvas zoom. Compute anchor in canvas-internal pixels and
      // convert state.viewportX/Y (CSS pixels) to canvas pixels so math is
      // correct even after the canvas has been translated.
      evt.preventDefault();
      const zoomStep = evt.deltaY < 0 ? 1.1 : 1 / 1.1;

      // Measure pointer position against an untransformed container so
      // CSS transforms on the canvas don't change the measurement used
      // for interaction math (this prevents drift during repeated zooms).
      const measureRect = (canvasWrap && canvasWrap.getBoundingClientRect)
        ? canvasWrap.getBoundingClientRect()
        : canvas.getBoundingClientRect();

      // pointer position in CSS pixels relative to the (untransformed) container
      const pointerCssX = evt.clientX - measureRect.left;
      const pointerCssY = evt.clientY - measureRect.top;

      // Use the layout (client) size to convert CSS px -> canvas internal pixels.
      // clientWidth/clientHeight are not affected by CSS transforms.
      const clientWidth = canvas.clientWidth || measureRect.width || 1;
      const clientHeight = canvas.clientHeight || measureRect.height || 1;
      const cssToCanvasX = canvas.width / clientWidth;
      const cssToCanvasY = canvas.height / clientHeight;

      // Compute adaptive max scale so that one canvas internal pixel maps to at
      // most `state.maxCanvasPixelScreen` CSS pixels on-screen.
      const maxScaleAdaptive = (state.maxCanvasPixelScreen * canvas.width) / clientWidth;
      const minScale = typeof state.viewportScaleMin === 'number' ? state.viewportScaleMin : 0.25;
      const maxScale = Math.max(0.0001, maxScaleAdaptive);
      const nextScale = Math.min(maxScale, Math.max(minScale, state.viewportScale * zoomStep));
      if (Math.abs(nextScale - state.viewportScale) < 0.0001) return;

      // debug logging removed

      // pointer position in canvas internal pixels
      const canvasPointerX = pointerCssX * cssToCanvasX;
      const canvasPointerY = pointerCssY * cssToCanvasY;

      // convert viewport CSS px to canvas internal pixels
      const viewportX_canvas = state.viewportX * cssToCanvasX;
      const viewportY_canvas = state.viewportY * cssToCanvasY;

      // world coordinates in canvas internal pixels (before zoom)
      const worldX_canvas = (canvasPointerX - viewportX_canvas) / state.viewportScale;
      const worldY_canvas = (canvasPointerY - viewportY_canvas) / state.viewportScale;

      // compute new viewport (in canvas pixels) so the world point remains under cursor
      const newViewportX_canvas = canvasPointerX - worldX_canvas * nextScale;
      const newViewportY_canvas = canvasPointerY - worldY_canvas * nextScale;

      // convert back to CSS px for storage in state
      state.viewportX = newViewportX_canvas / cssToCanvasX;
      state.viewportY = newViewportY_canvas / cssToCanvasY;
      state.viewportScale = nextScale;

      applyCanvasViewport();

      setStatus(`Canvas zoom: ${Math.round(state.viewportScale * 100)}%`);
    }, { passive: false });


    window.addEventListener("keydown", (evt) => {
      const target = evt.target;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) {
        return;
      }

      const key = evt.key.toLowerCase();

      // --- Tool hotkeys ---
      if (!evt.ctrlKey && !evt.metaKey && !evt.altKey) {
        // Tool hotkeys: Q/W/E/R/T or numeric row 1-5 as alternates
        if (key === "q" || key === "1") {
          setTool("move");
          evt.preventDefault();
          return;
        } else if (key === "w" || key === "2") {
          setTool("brush");
          evt.preventDefault();
          return;
        } else if (key === "e" || key === "3") {
          setTool("line");
          evt.preventDefault();
          return;
        } else if (key === "r" || key === "4") {
          setTool("picker");
          evt.preventDefault();
          return;
        } else if (key === "t" || key === "5") {
          setTool("crop");
          evt.preventDefault();
          return;
        } else if (key === "a") {
          // Brush size smaller
          if (state.tool === "brush") {
            state.brushSize = Math.max(1, state.brushSize - 1);
            updateToolUi();
            const rect = canvas.getBoundingClientRect();
            const cx = state.cursorClientX || (rect.left + rect.width / 2);
            const cy = state.cursorClientY || (rect.top + rect.height / 2);
            showSizePreview(cx, cy);
            evt.preventDefault();
            return;
          }
        } else if (key === "d") {
          // Brush size bigger
          if (state.tool === "brush") {
            state.brushSize = Math.min(512, state.brushSize + 1);
            updateToolUi();
            const rect = canvas.getBoundingClientRect();
            const cx = state.cursorClientX || (rect.left + rect.width / 2);
            const cy = state.cursorClientY || (rect.top + rect.height / 2);
            showSizePreview(cx, cy);
            evt.preventDefault();
            return;
          }
        }
      }

      if ((evt.ctrlKey || evt.metaKey) && key === "z") {
        evt.preventDefault();
        if (evt.shiftKey) {
          redoPaint();
        } else {
          undoPaint();
        }
        return;
      }

      if ((evt.ctrlKey || evt.metaKey) && key === "y") {
        evt.preventDefault();
        redoPaint();
        return;
      }

      if (!state.lockToSelected || state.active < 0) return;

      if (state.lockEditBackground) {
        setActiveToBackground();
      }

      const layer = state.layers[state.active];
      if (!canEditLayer(layer)) return;
      const moveStep = evt.shiftKey ? 20 : 8;
      let changed = false;

      if (key === "w") {
        layer.y -= moveStep;
        changed = true;
      } else if (key === "s") {
        layer.y += moveStep;
        changed = true;
      } else if (key === "a") {
        layer.x -= moveStep;
        changed = true;
      } else if (key === "d") {
        layer.x += moveStep;
        changed = true;
      } else if (evt.key === "+" || evt.key === "=") {
        layer.scale = Math.max(0.05, layer.scale * 1.05);
        changed = true;
      } else if (evt.key === "-" || evt.key === "_") {
        layer.scale = Math.max(0.05, layer.scale / 1.05);
        changed = true;
      }

      if (changed) {
        evt.preventDefault();
        draw();
      }
    });

    // Hide preview immediately when Shift is released
    window.addEventListener('keyup', (evt) => {
      if (evt.key === 'Shift') {
        hideSizePreview();
      }
    });

    function bindBgInput() {
      if (!bgUploadWrap) return;
      const fileInput = bgUploadWrap.querySelector('input[type="file"]');
      if (!fileInput || fileInput.dataset.composerBound === "1") return;

      const loadBackgroundFromFile = async (file) => {
        if (!file || !String(file.type || "").startsWith("image/")) return;

        const img = await loadImageFromFile(file);
        canvas.width = img.width;
        canvas.height = img.height;
        state.useColorBackground = false;

        const existingBgIndex = state.layers.findIndex((x) => x.isBackground);
        const bgLayer = makeLayerFromImage(img, file.name || "Background", true);
        if (existingBgIndex >= 0) {
          state.layers[existingBgIndex] = bgLayer;
          state.active = existingBgIndex;
        } else {
          state.layers.unshift(bgLayer);
          state.active = 0;
        }

        const overlay = state.layers.find((x) => x.isPaintOverlay);
        if (overlay) {
          syncPaintOverlaySize(overlay);
        }

        fitCanvasToParent();
        renderLayerList();
        draw();
        setStatus(`Background loaded: ${file.name} (${canvas.width}x${canvas.height})`);
      };

      fileInput.dataset.composerBound = "1";
      fileInput.addEventListener("change", async () => {
        const f = fileInput.files && fileInput.files[0];
        if (!f) return;

        await loadBackgroundFromFile(f);
        clearUploadWidget(bgUploadWrap);
      });

      if (bgUploadWrap.dataset.composerDropBound !== "1") {
        bgUploadWrap.dataset.composerDropBound = "1";
        bgUploadWrap.addEventListener("dragover", (evt) => {
          evt.preventDefault();
        });
        bgUploadWrap.addEventListener("drop", async (evt) => {
          evt.preventDefault();

          const files = evt.dataTransfer ? Array.from(evt.dataTransfer.files || []) : [];
          const imageFile = files.find((f) => String(f.type || "").startsWith("image/"));
          if (!imageFile) {
            setStatus("Drop an image file to set background.");
            return;
          }

          await loadBackgroundFromFile(imageFile);
          clearUploadWidget(bgUploadWrap);
        });
      }
    }

    function bindCharsInput() {
      if (!charsUploadWrap) return;
      const fileInput = charsUploadWrap.querySelector('input[type="file"]');
      if (!fileInput || fileInput.dataset.composerBound === "1") return;

      fileInput.dataset.composerBound = "1";
      fileInput.addEventListener("change", async () => {
        const files = Array.from(fileInput.files || []);
        for (const file of files) {
          await addAssetFromFile(file);
        }

        renderAssetList();
        clearUploadWidget(charsUploadWrap);
        setStatus(`Staged ${files.length} character image(s). Click Add to Layers for each.`);
      });
    }

    function bindUploadInputs() {
      bindBgInput();
      bindCharsInput();
    }

    if (lockModeBtn) {
      lockModeBtn.addEventListener("click", () => {
        state.lockToSelected = !state.lockToSelected;
        updateLockModeUi();
        if (state.lockToSelected) {
          state.lockEditBackground = false;
          updateBgLockUi();
        }
        if (state.lockToSelected && state.active < 0 && state.layers.length > 0) {
          state.active = state.layers.length - 1;
          renderLayerList();
          draw();
        }
      });
    }

    if (bgLockBtn) {
      bgLockBtn.addEventListener("click", () => {
        state.lockEditBackground = !state.lockEditBackground;
        updateBgLockUi();
        if (state.lockEditBackground) {
          state.lockToSelected = false;
          updateLockModeUi();
          setActiveToBackground();
          renderLayerList();
          draw();
        }
      });
    }

    if (restoreBgBtn) {
      restoreBgBtn.addEventListener("click", () => {
        restoreBackgroundTransform();
      });
    }

    if (bgColorApplyBtn && bgColorInput) {
      bgColorApplyBtn.addEventListener("click", () => {
        applyColorBackground(bgColorInput.value || "#1e293b");
      });
    }

    Object.entries(toolButtons).forEach(([toolName, btn]) => {
      if (!btn) return;
      btn.addEventListener("click", () => {
        setTool(toolName);
      });
    });

    if (drawColorInput) {
      drawColorInput.addEventListener("input", () => {
        state.drawColor = drawColorInput.value || "#ff3366";
      });
    }

    if (brushSizeInput) {
      brushSizeInput.addEventListener("input", () => {
        state.brushSize = Math.max(1, Number(brushSizeInput.value) || 18);
        updateToolUi();
        // show preview at last known cursor or canvas center
        const rect = canvas.getBoundingClientRect();
        const cx = state.cursorClientX || (rect.left + rect.width / 2);
        const cy = state.cursorClientY || (rect.top + rect.height / 2);
        showSizePreview(cx, cy);
      });
    }

    if (cropApplyBtn) {
      cropApplyBtn.addEventListener("click", () => {
        applyCropSelection();
      });
    }

    if (cropCancelBtn) {
      cropCancelBtn.addEventListener("click", () => {
        state.cropSelection = null;
        state.cropPreview = null;
        draw();
        setStatus("Crop selection cleared.");
      });
    }

    if (bgColorRandomBtn && bgColorInput) {
      bgColorRandomBtn.addEventListener("click", () => {
        const color = randomHexColor();
        bgColorInput.value = color;
        applyColorBackground(color);
      });
    }

    mirrorBtn.addEventListener("click", () => {
      if (state.active < 0) return;
      if (!canEditLayer(state.layers[state.active])) return;
      state.layers[state.active].mirror = !state.layers[state.active].mirror;
      draw();
    });

    deleteBtn.addEventListener("click", () => {
      if (state.active < 0) return;
      if (!canEditLayer(state.layers[state.active])) return;
      state.layers.splice(state.active, 1);
      state.active = Math.min(state.active, state.layers.length - 1);
      renderLayerList();
      draw();
    });

    layerUpBtn.addEventListener("click", () => {
      if (state.active < 0 || state.active >= state.layers.length - 1) return;
      if (!canEditLayer(state.layers[state.active])) return;
      const tmp = state.layers[state.active];
      state.layers[state.active] = state.layers[state.active + 1];
      state.layers[state.active + 1] = tmp;
      state.active += 1;
      renderLayerList();
      draw();
    });

    layerDownBtn.addEventListener("click", () => {
      if (state.active <= 0) return;
      if (!canEditLayer(state.layers[state.active])) return;
      const tmp = state.layers[state.active];
      state.layers[state.active] = state.layers[state.active - 1];
      state.layers[state.active - 1] = tmp;
      state.active -= 1;
      renderLayerList();
      draw();
    });

    window.addEventListener("resize", fitCanvasToParent);
    bindUploadInputs();
    updateLockModeUi();
    updateBgLockUi();
    updateToolUi();
    renderAssetList();
    state.bindUploadInputs = bindUploadInputs;

    // Load Config button: open hidden file input
    const loadConfigBtn = document.getElementById("composer_load_config_btn");
    const configFileInput = document.getElementById("composer_config_file_input");
    if (loadConfigBtn && configFileInput) {
      loadConfigBtn.addEventListener("click", () => {
        configFileInput.value = "";
        configFileInput.click();
      });
      configFileInput.addEventListener("change", async () => {
        const file = configFileInput.files && configFileInput.files[0];
        if (!file) return;
        try {
          const text = await file.text();
          await restoreFromConfigJson(text);
        } catch (e) {
          setStatus("Error loading config file: " + e.message);
        }
      });
    }

    root.__composer_state = state;
    fitCanvasToParent();
    draw();

    return state;
  }

  window.composer_ensure_init = function () {
    const root = document.getElementById("composer_root");
    if (!root) return;

    if (!root.__composer_initialized) {
      root.__composer_initialized = true;
      makeComposerController(root);
    }
  };

  window.composer_export_payload = function (_payload) {
    window.composer_ensure_init();
    const root = document.getElementById("composer_root");
    if (!root || !root.__composer_state) {
      return [""];
    }

    const canvas = root.querySelector("#composer_canvas");
    const state = root.__composer_state;
    const payload = {
      width: canvas.width,
      height: canvas.height,
      background: null,
      background_color: state.useColorBackground ? state.backgroundColor : null,
      layers: state.layers.map((l) => ({
        name: l.name,
        src: l.src,
        x: l.x,
        y: l.y,
        scale: l.scale,
        rot_deg: (l.rot * 180) / Math.PI,
        mirror: l.mirror,
        opacity: l.opacity,
        is_background: !!l.isBackground,
      })),
    };

    return [JSON.stringify(payload)];
  };

  /**
   * Load a composed image (and optionally its .composerstate.json) into the
   * Composer from the Gallery tab.
   * @param {string} imagePath  Absolute filesystem path to the PNG.
   * @param {string} configPath Absolute filesystem path to the .composerstate.json,
   *                            or empty string if none exists.
   */
  window.composer_load_from_gallery = async function (imagePath, configPath) {
    window.composer_ensure_init();
    const root = document.getElementById("composer_root");
    if (!root || !root.__composer_state) return;
    const state = root.__composer_state;
    const canvas = root.querySelector("#composer_canvas");

    function toFileUrl(absPath) {
      return `/file=${encodeURIComponent(String(absPath).replace(/\\/g, "/"))}`;
    }

    // If a config sidecar exists, restore full state from it.
    if (configPath) {
      try {
        const resp = await fetch(toFileUrl(configPath));
        if (resp.ok) {
          const configJson = await resp.text();
          await state.restoreFromConfigJson(configJson);
          return;
        }
      } catch (e) {
        console.warn("[composer] Failed to load config sidecar:", e);
      }
    }

    // Fallback: load the image as a background layer via a minimal config.
    try {
      const resp = await fetch(toFileUrl(imagePath));
      if (!resp.ok) throw new Error("fetch failed: " + resp.status);
      const blob = await resp.blob();
      const src = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      });
      const img = await new Promise((resolve, reject) => {
        const probe = new Image();
        probe.onload = () => resolve(probe);
        probe.onerror = reject;
        probe.src = src;
      });
      const imageWidth = Math.max(1, Number(img.naturalWidth || img.width || canvas.width || 1));
      const imageHeight = Math.max(1, Number(img.naturalHeight || img.height || canvas.height || 1));
      canvas.width = imageWidth;
      canvas.height = imageHeight;
      const fname = String(imagePath).split(/[\\/]/).pop() || "Gallery Image";
      const minimalPayload = JSON.stringify({
        width: imageWidth,
        height: imageHeight,
        background_color: null,
        layers: [{ name: fname, src, x: imageWidth / 2, y: imageHeight / 2,
                   scale: 1, rot_deg: 0, mirror: false, opacity: 1, is_background: true }],
      });
      await state.restoreFromConfigJson(minimalPayload);
    } catch (e) {
      console.warn("[composer] Failed to load gallery image:", e);
    }
  };

  function bindCaptionClickToCopy() {
    const captionWrap = document.getElementById("composer_caption_output");
    if (!captionWrap) return;

    const captionArea = captionWrap.querySelector("textarea");
    if (!captionArea || captionArea.dataset.copyOnClickBound === "1") return;

    captionArea.dataset.copyOnClickBound = "1";
    captionArea.title = "Click to copy caption";
    captionArea.style.cursor = "copy";

    const getCopyText = (raw) => {
      const text = String(raw || "").trim();
      if (!text) return "";

      const marker = "Paste the above into a LLM";
      const markerIdx = text.indexOf(marker);
      if (markerIdx >= 0) {
        return text.slice(0, markerIdx).trimEnd();
      }

      return text;
    };

    captionArea.addEventListener("click", async () => {
      const text = getCopyText(captionArea.value);
      if (!text) return;

      const root = document.getElementById("composer_root");
      const statusEl = root ? root.querySelector("#composer_status_text") : null;

      try {
        await navigator.clipboard.writeText(text);
        if (statusEl) {
          statusEl.textContent = "Caption copied to clipboard.";
        }
      } catch (_err) {
        if (typeof document.execCommand === "function") {
          let tmp = null;
          try {
            tmp = document.createElement("textarea");
            tmp.value = text;
            tmp.setAttribute("readonly", "");
            tmp.style.position = "fixed";
            tmp.style.top = "-9999px";
            document.body.appendChild(tmp);
            tmp.focus();
            tmp.select();
            document.execCommand("copy");
            if (statusEl) {
              statusEl.textContent = "Caption copied to clipboard.";
            }
          } catch (_ignored) {
            if (statusEl) {
              statusEl.textContent = "Copy failed. Select text and copy manually.";
            }
          } finally {
            if (tmp && tmp.parentNode) {
              tmp.parentNode.removeChild(tmp);
            }
          }
        } else if (statusEl) {
          statusEl.textContent = "Copy failed. Select text and copy manually.";
        }
      }
    });
  }

  const observer = new MutationObserver(() => {
    window.composer_ensure_init();
    bindCaptionClickToCopy();
    const root = document.getElementById("composer_root");
    if (root && root.__composer_state && typeof root.__composer_state.bindUploadInputs === "function") {
      root.__composer_state.bindUploadInputs();
    }
  });

  const startObserve = () => {
    window.composer_ensure_init();
    bindCaptionClickToCopy();
    observer.observe(document.body, { childList: true, subtree: true });
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", startObserve, { once: true });
  } else {
    startObserve();
  }
})();
