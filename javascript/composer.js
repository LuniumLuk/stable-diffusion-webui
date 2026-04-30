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
    };

    const canvas = root.querySelector("#composer_canvas");
    const ctx = canvas.getContext("2d");
    const bgUploadWrap = document.getElementById("composer_bg_upload");
    const charsUploadWrap = document.getElementById("composer_chars_upload");
    const layerList = root.querySelector("#composer_layers");
    const assetList = root.querySelector("#composer_assets");
    const lockModeBtn = root.querySelector("#composer_lock_mode_btn");
    const bgLockBtn = root.querySelector("#composer_bg_lock_btn");
    const restoreBgBtn = root.querySelector("#composer_restore_bg_btn");
    const mirrorBtn = root.querySelector("#composer_mirror_btn");
    const deleteBtn = root.querySelector("#composer_delete_btn");
    const layerUpBtn = root.querySelector("#composer_layer_up_btn");
    const layerDownBtn = root.querySelector("#composer_layer_down_btn");
    const statusText = root.querySelector("#composer_status_text");

    function updateLockModeUi() {
      if (!lockModeBtn) return;
      lockModeBtn.textContent = state.lockToSelected
        ? "Lock Edit To Selected: ON"
        : "Lock Edit To Selected: OFF";
      lockModeBtn.classList.toggle("active", state.lockToSelected);
    }

    function updateBgLockUi() {
      if (!bgLockBtn) return;
      bgLockBtn.textContent = state.lockEditBackground
        ? "Lock Edit Background: ON"
        : "Lock Edit Background: OFF";
      bgLockBtn.classList.toggle("active", state.lockEditBackground);
    }

    function setStatus(text) {
      statusText.textContent = text;
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
    }

    function drawLayer(layer) {
      const img = layer.img;
      const w = img.width * layer.scale;
      const h = img.height * layer.scale;
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

    function draw() {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      state.layers.forEach((layer, i) => {
        layer.selected = i === state.active;
        drawLayer(layer);
      });
    }

    function renderLayerList() {
      layerList.innerHTML = "";
      state.layers.forEach((layer, i) => {
        const item = document.createElement("div");
        item.className = "composer-layer-item" + (i === state.active ? " active" : "");
        const label = layer.isBackground ? `BG. ${layer.name}` : `${i + 1}. ${layer.name}`;
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

    function addAssetToLayers(asset) {
      const layer = makeLayerFromImage(asset.img, asset.name, false);
      state.layers.push(layer);
      state.active = state.layers.length - 1;
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

    function toLocal(layer, px, py) {
      const dx = px - layer.x;
      const dy = py - layer.y;
      const c = Math.cos(-layer.rot);
      const s = Math.sin(-layer.rot);
      const lx = dx * c - dy * s;
      const ly = dx * s + dy * c;
      return { x: layer.mirror ? -lx : lx, y: ly };
    }

    function hitTest(px, py) {
      const handleHitPadding = Math.max(8, uiPxToCanvas(12));
      const rotateDistance = Math.max(12, uiPxToCanvas(24));
      const rotateHitRadius = Math.max(7, uiPxToCanvas(10));

      if (state.lockEditBackground) {
        const bgIndex = getBackgroundIndex();
        if (bgIndex < 0) return null;
        const layer = state.layers[bgIndex];
        const w = layer.img.width * layer.scale;
        const h = layer.img.height * layer.scale;
        const local = toLocal(layer, px, py);

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
        const w = layer.img.width * layer.scale;
        const h = layer.img.height * layer.scale;
        const local = toLocal(layer, px, py);

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
        const w = layer.img.width * layer.scale;
        const h = layer.img.height * layer.scale;
        const local = toLocal(layer, px, py);

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
      const p = getMousePos(evt);
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
      if (!state.dragMode || state.active < 0) return;

      const p = getMousePos(evt);
      const layer = state.layers[state.active];
      if (!layer) return;

      if (state.dragMode === "move") {
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
      state.dragMode = null;
    });

    canvas.addEventListener("pointercancel", () => {
      state.dragMode = null;
    });

    window.addEventListener("keydown", (evt) => {
      if (!state.lockToSelected || state.active < 0) return;

      const target = evt.target;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) {
        return;
      }

      if (state.lockEditBackground) {
        setActiveToBackground();
      }

      const layer = state.layers[state.active];
      if (!canEditLayer(layer)) return;

      const key = evt.key.toLowerCase();
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

    function bindBgInput() {
      if (!bgUploadWrap) return;
      const fileInput = bgUploadWrap.querySelector('input[type="file"]');
      if (!fileInput || fileInput.dataset.composerBound === "1") return;

      fileInput.dataset.composerBound = "1";
      fileInput.addEventListener("change", async () => {
        const f = fileInput.files && fileInput.files[0];
        if (!f) return;

        const img = await loadImageFromFile(f);
        canvas.width = img.width;
        canvas.height = img.height;

        const existingBgIndex = state.layers.findIndex((x) => x.isBackground);
        const bgLayer = makeLayerFromImage(img, f.name, true);
        if (existingBgIndex >= 0) {
          state.layers[existingBgIndex] = bgLayer;
          state.active = existingBgIndex;
        } else {
          state.layers.unshift(bgLayer);
          state.active = 0;
        }

        fitCanvasToParent();
        renderLayerList();
        draw();
        setStatus(`Background loaded: ${f.name} (${canvas.width}x${canvas.height})`);
        clearUploadWidget(bgUploadWrap);
      });
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
    renderAssetList();
    state.bindUploadInputs = bindUploadInputs;
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

  const observer = new MutationObserver(() => {
    window.composer_ensure_init();
    const root = document.getElementById("composer_root");
    if (root && root.__composer_state && typeof root.__composer_state.bindUploadInputs === "function") {
      root.__composer_state.bindUploadInputs();
    }
  });

  const startObserve = () => {
    window.composer_ensure_init();
    observer.observe(document.body, { childList: true, subtree: true });
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", startObserve, { once: true });
  } else {
    startObserve();
  }
})();
