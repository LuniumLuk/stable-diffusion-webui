(function () {
  function makeComposerController(root) {
    const state = {
      bg: null,
      layers: [],
      active: -1,
      dragMode: null,
      startX: 0,
      startY: 0,
      startLayer: null,
      startDist: 0,
      startAngle: 0,
    };

    const canvas = root.querySelector("#composer_canvas");
    const ctx = canvas.getContext("2d");
    const bgInput = root.querySelector("#composer_bg_input");
    const charsInput = root.querySelector("#composer_chars_input");
    const layerList = root.querySelector("#composer_layers");
    const mirrorBtn = root.querySelector("#composer_mirror_btn");
    const deleteBtn = root.querySelector("#composer_delete_btn");
    const statusText = root.querySelector("#composer_status_text");

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
        ctx.lineWidth = 2;
        ctx.strokeRect(-w / 2, -h / 2, w, h);
        ctx.fillStyle = "#22d3ee";
        ctx.fillRect(w / 2 - 6, h / 2 - 6, 12, 12);
        ctx.beginPath();
        ctx.arc(0, -h / 2 - 24, 7, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
    }

    function draw() {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      if (state.bg) {
        ctx.drawImage(state.bg, 0, 0, canvas.width, canvas.height);
      }
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
        item.textContent = `${i + 1}. ${layer.name}`;
        item.onclick = () => {
          state.active = i;
          renderLayerList();
          draw();
        };
        layerList.appendChild(item);
      });
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
      for (let i = state.layers.length - 1; i >= 0; i--) {
        const layer = state.layers[i];
        const w = layer.img.width * layer.scale;
        const h = layer.img.height * layer.scale;
        const local = toLocal(layer, px, py);

        const resizeX = w / 2;
        const resizeY = h / 2;
        if (Math.abs(local.x - resizeX) < 12 && Math.abs(local.y - resizeY) < 12) {
          return { index: i, mode: "resize" };
        }

        if (Math.hypot(local.x, local.y + h / 2 + 24) < 10) {
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
        state.active = -1;
        renderLayerList();
        draw();
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

    bgInput.addEventListener("change", async () => {
      const f = bgInput.files && bgInput.files[0];
      if (!f) return;
      state.bg = await loadImageFromFile(f);
      canvas.width = state.bg.width;
      canvas.height = state.bg.height;
      fitCanvasToParent();
      draw();
      statusText.textContent = `Background loaded: ${f.name} (${canvas.width}x${canvas.height})`;
    });

    charsInput.addEventListener("change", async () => {
      const files = Array.from(charsInput.files || []);
      for (const file of files) {
        const img = await loadImageFromFile(file);
        state.layers.push({
          id: crypto.randomUUID(),
          name: file.name,
          src: img.src,
          img,
          x: canvas.width / 2,
          y: canvas.height / 2,
          scale: 1,
          rot: 0,
          mirror: false,
          opacity: 1,
        });
      }

      if (state.active < 0 && state.layers.length > 0) {
        state.active = state.layers.length - 1;
      }

      renderLayerList();
      draw();
      statusText.textContent = `Loaded ${files.length} character image(s).`;
    });

    mirrorBtn.addEventListener("click", () => {
      if (state.active < 0) return;
      state.layers[state.active].mirror = !state.layers[state.active].mirror;
      draw();
    });

    deleteBtn.addEventListener("click", () => {
      if (state.active < 0) return;
      state.layers.splice(state.active, 1);
      state.active = Math.min(state.active, state.layers.length - 1);
      renderLayerList();
      draw();
    });

    window.addEventListener("resize", fitCanvasToParent);
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
      background: state.bg ? state.bg.src : null,
      layers: state.layers.map((l) => ({
        name: l.name,
        src: l.src,
        x: l.x,
        y: l.y,
        scale: l.scale,
        rot_deg: (l.rot * 180) / Math.PI,
        mirror: l.mirror,
        opacity: l.opacity,
      })),
    };

    return [JSON.stringify(payload)];
  };

  const observer = new MutationObserver(() => {
    window.composer_ensure_init();
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
