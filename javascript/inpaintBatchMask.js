/**
 * Inpaint batch mask panel
 * ========================
 * Adds Photoshop-like mask layers to the img2img Inpaint tab (#img2maskimg), in the empty
 * gutter left of the picture (below the SAM tool bar).
 *
 *   - Toggle "Batch mask" on to manage a list of masks: create, select (edit), duplicate,
 *     reorder, clear and delete them. Only the selected layer is present on the gradio sketch
 *     mask canvas, so all existing editing tools (brush, SAM pick, erase, undo) edit it.
 *   - Masks of the layers that are not being edited are overlaid on the picture as blinking
 *     outlines, with their processing order drawn in the middle (50% opacity).
 *   - On Generate the layers are serialized (in list order) into the hidden
 *     #img2img_batch_mask_payload textbox. The backend then inpaints each mask in order, using
 *     the result of the previous inpaint as the input image for the next one. When that
 *     finishes the last result is selected in the output gallery.
 *
 * The layer data is kept as PNG data URLs (the sketch mask canvas alpha channel is the mask),
 * and is only ever written into the canvas on layer switches / image reloads. The gradio value
 * is refreshed through the same synthetic off-canvas stroke the SAM panel uses, exposed as
 * window.inpaintSamPanel.syncMask()/resetMask().
 */
(() => {
    "use strict";

    const ROOT_SEL = "#img2maskimg";
    const PAYLOAD_ID = "img2img_batch_mask_payload";
    const OFFSCREEN = 50000;

    const GHOST_COLORS = ["#ff9f43", "#b388ff", "#22d3ee", "#f472b6", "#a3e635", "#facc15"];
    const GHOST_MAX_DIM = 720;

    const state = {
        enabled: false,
        layers: [], // {id, name, dataUrl, __ghost}
        activeId: null,
        canvasLayerId: null, // layer whose mask is currently drawn on the sketch canvas
        counter: 0,
        imgEl: null,
        canvasEl: null,
        applyToken: 0,
        ghostToken: 0,
        thumbEls: new Map(),
        progressHooked: false,
        pendingSelectLast: false,
        batchInitialSrc: null, // input image of the running batch-mask generation
        batchInitials: new Map(), // normalized result src -> initial image src (for compare)
    };

    function app() {
        return typeof gradioApp === "function" ? gradioApp() : document;
    }

    function byId(id) {
        const root = app();
        if (root.getElementById) return root.getElementById(id);
        return root.querySelector(`#${id}`) || document.getElementById(id);
    }

    function getRoot() {
        return app().querySelector(ROOT_SEL);
    }

    function getParts() {
        const root = getRoot();
        if (!root) return null;
        const iface = root.querySelector('canvas[key="interface"]');
        const maskCanvas = root.querySelector('canvas[key="mask"]');
        const wrap = iface ? iface.closest(".wrap") : null;
        if (!iface || !maskCanvas || !wrap) return null;
        return {root, iface, maskCanvas, wrap, host: wrap.parentElement, img: root.querySelector("img.absolute-img")};
    }

    function activeLayer() {
        return state.layers.find((layer) => layer.id === state.activeId) || null;
    }

    /* ------------------------------- gradio value sync ------------------------------- */

    function fallbackSyncStroke() {
        const p = getParts();
        if (!p) return;
        const r = p.iface.getBoundingClientRect();
        const base = {
            bubbles: true,
            cancelable: true,
            view: window,
            button: 0,
            clientX: r.left - OFFSCREEN,
            clientY: r.top - OFFSCREEN,
        };
        const make = (type, buttons) => {
            const ev = new MouseEvent(type, Object.assign({}, base, {buttons}));
            ev.__inpsamSynthetic = true; // let gradio process it, ignore it ourselves
            return ev;
        };
        try {
            p.iface.dispatchEvent(make("mousedown", 1));
            p.iface.dispatchEvent(make("mousemove", 1));
            p.iface.dispatchEvent(make("mouseup", 0));
        } catch (e) {
            console.warn("[inpbatch] mask sync failed", e);
        }
    }

    function refreshSketch(resetUndo) {
        const api = window.inpaintSamPanel;
        if (api && typeof api.isReady === "function" && api.isReady()) {
            if (resetUndo && typeof api.resetMask === "function") api.resetMask();
            else if (typeof api.syncMask === "function") api.syncMask();
            return;
        }
        fallbackSyncStroke();
    }

    /* ------------------------------------ payload ------------------------------------ */

    function setTextarea(id, value) {
        const host = byId(id);
        const textarea = host ? host.querySelector("textarea") : null;
        if (!textarea) return false;
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
        setter.call(textarea, value);
        textarea.dispatchEvent(new Event("input", {bubbles: true}));
        return true;
    }

    function captureActiveLayer() {
        const layer = activeLayer();
        const p = getParts();
        if (!state.enabled || !layer || !p) return;
        if (state.canvasLayerId !== layer.id) return;
        layer.dataUrl = p.maskCanvas.toDataURL("image/png");
        updateThumb(layer);
    }

    function pushPayload(capture = true) {
        if (state.enabled && capture) captureActiveLayer();
        const masks = state.enabled ? state.layers.map((layer) => layer.dataUrl).filter(Boolean) : [];
        const payload = masks.length ? JSON.stringify({enabled: true, masks}) : "{}";
        setTextarea(PAYLOAD_ID, payload);
    }

    /* --------------------------------- canvas / layers -------------------------------- */

    function applyActiveLayer(resetUndo) {
        const p = getParts();
        const layer = activeLayer();
        const token = ++state.applyToken;

        if (!p || !layer) {
            state.canvasLayerId = null;
            return;
        }

        const ctx = p.maskCanvas.getContext("2d");
        const width = p.maskCanvas.width;
        const height = p.maskCanvas.height;
        if (!width || !height) return;

        const paint = (image) => {
            ctx.save();
            ctx.globalCompositeOperation = "source-over";
            ctx.clearRect(0, 0, width, height);
            if (image) ctx.drawImage(image, 0, 0, width, height);
            ctx.restore();
            state.canvasLayerId = layer.id;
            refreshSketch(resetUndo);
        };

        if (!layer.dataUrl) {
            paint(null);
            return;
        }

        const image = new Image();
        image.onload = () => {
            if (token !== state.applyToken || state.activeId !== layer.id) return;
            paint(image);
        };
        image.onerror = () => {
            if (token !== state.applyToken) return;
            paint(null);
        };
        image.src = layer.dataUrl;
    }

    function selectLayer(id) {
        if (!state.layers.some((layer) => layer.id === id)) return;
        if (state.activeId === id) {
            renderList();
            return;
        }
        captureActiveLayer();
        state.activeId = id;
        renderList();
        updateChrome();
        applyActiveLayer(true);
        pushPayload();
        refreshGhosts();
    }

    function newLayer(name) {
        state.counter += 1;
        return {id: `inpbatch-${Date.now().toString(36)}-${state.counter}`, name: name || `Mask ${state.counter}`, dataUrl: ""};
    }

    function addLayer() {
        captureActiveLayer();
        const layer = newLayer();
        state.layers.push(layer);
        state.activeId = layer.id;
        state.canvasLayerId = layer.id;
        renderList();
        updateChrome();
        applyActiveLayer(true);
        pushPayload();
        refreshGhosts();
    }

    function duplicateLayer() {
        captureActiveLayer();
        const source = activeLayer();
        if (!source) return;
        const index = state.layers.indexOf(source);
        const copy = newLayer(`${source.name} copy`);
        copy.dataUrl = source.dataUrl;
        state.layers.splice(index + 1, 0, copy);
        state.activeId = copy.id;
        renderList();
        updateChrome();
        applyActiveLayer(true);
        pushPayload();
        refreshGhosts();
    }

    function deleteLayer(id) {
        const index = state.layers.findIndex((layer) => layer.id === id);
        if (index === -1) return;

        state.layers.splice(index, 1);
        const wasActive = state.activeId === id;

        if (!state.layers.length) {
            state.layers.push(newLayer());
            state.activeId = state.layers[0].id;
        } else if (wasActive) {
            state.activeId = state.layers[Math.min(index, state.layers.length - 1)].id;
        }

        renderList();
        updateChrome();

        if (wasActive || state.canvasLayerId === id) {
            state.canvasLayerId = null;
            applyActiveLayer(true);
        }
        pushPayload();
        refreshGhosts();
    }

    function moveLayer(id, delta) {
        const index = state.layers.findIndex((layer) => layer.id === id);
        const target = index + delta;
        if (index === -1 || target < 0 || target >= state.layers.length) return;
        const [layer] = state.layers.splice(index, 1);
        state.layers.splice(target, 0, layer);
        renderList();
        pushPayload();
        refreshGhosts();
    }

    let clearConfirmTimer = null;

    function resetClearAllButton() {
        const panel = panelEl();
        const button = panel ? panel.querySelector('[data-act="clear-all"]') : null;
        if (!button) return;
        button.classList.remove("inpbatch-confirm");
        button.textContent = "\u232B Clear all";
    }

    function clearAllLayers() {
        const panel = panelEl();
        const button = panel ? panel.querySelector('[data-act="clear-all"]') : null;
        if (!state.layers.length) return;

        // two-step confirmation, so a stray click cannot wipe every mask
        if (button && !button.classList.contains("inpbatch-confirm")) {
            button.classList.add("inpbatch-confirm");
            button.textContent = "Confirm clear";
            clearTimeout(clearConfirmTimer);
            clearConfirmTimer = setTimeout(resetClearAllButton, 3000);
            return;
        }
        clearTimeout(clearConfirmTimer);
        resetClearAllButton();

        state.layers.forEach((layer) => {
            layer.dataUrl = "";
            layer.__ghost = null;
            updateThumb(layer);
        });
        state.canvasLayerId = null;
        applyActiveLayer(true);
        pushPayload(false); // layers are empty: clear the payload instead of capturing the blank canvas
        refreshGhosts();
    }

    function setEnabled(enabled) {
        if (state.enabled === enabled) return;

        if (enabled) {
            state.enabled = true;
            if (!state.layers.length) {
                const p = getParts();
                const layer = newLayer();
                layer.dataUrl = p ? p.maskCanvas.toDataURL("image/png") : "";
                state.layers.push(layer);
                state.activeId = layer.id;
                state.canvasLayerId = layer.id;
                renderList();
            } else if (state.canvasLayerId === state.activeId) {
                captureActiveLayer(); // keep strokes painted while batch mode was off
            } else {
                applyActiveLayer(true);
            }
        } else {
            captureActiveLayer();
            state.enabled = false;
        }

        updateChrome();
        pushPayload();
        refreshGhosts();
    }

    /* ------------------------------- other layers overlay ----------------------------- */

    function ensureGhostCanvases(p) {
        let border = p.wrap.querySelector(".inpbatch-ghost-border");
        let label = p.wrap.querySelector(".inpbatch-ghost-label");
        if (!border) {
            border = document.createElement("canvas");
            border.className = "inpbatch-ghost-border";
            p.wrap.appendChild(border);
        }
        if (!label) {
            label = document.createElement("canvas");
            label.className = "inpbatch-ghost-label";
            p.wrap.appendChild(label);
        }

        // follow the mask canvas box so the outlines land exactly on the picture
        const maskStyle = getComputedStyle(p.maskCanvas);
        for (const canvas of [border, label]) {
            if (canvas.style.width !== maskStyle.width) canvas.style.width = maskStyle.width;
            if (canvas.style.height !== maskStyle.height) canvas.style.height = maskStyle.height;
        }
        return {border, label};
    }

    function hexToRgb(hex) {
        const value = parseInt(hex.slice(1), 16);
        return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
    }

    function buildGhost(image, width, height, color, key) {
        const temp = document.createElement("canvas");
        temp.width = width;
        temp.height = height;
        const tempCtx = temp.getContext("2d", {willReadFrequently: true});
        tempCtx.drawImage(image, 0, 0, width, height);

        let source;
        try {
            source = tempCtx.getImageData(0, 0, width, height).data;
        } catch (e) {
            return null;
        }

        const alpha = new Uint8Array(width * height);
        let sumX = 0;
        let sumY = 0;
        let count = 0;
        for (let i = 0, j = 3; i < alpha.length; i++, j += 4) {
            if (source[j] > 8) {
                alpha[i] = 1;
                sumX += i % width;
                sumY += (i / width) | 0;
                count++;
            }
        }
        if (!count) return null;

        const out = tempCtx.createImageData(width, height);
        const pixels = out.data;
        const [red, green, blue] = hexToRgb(color);
        const put = (index) => {
            const k = index * 4;
            pixels[k] = red;
            pixels[k + 1] = green;
            pixels[k + 2] = blue;
            pixels[k + 3] = 255;
        };

        for (let y = 0; y < height; y++) {
            const row = y * width;
            for (let x = 0; x < width; x++) {
                const i = row + x;
                if (!alpha[i]) continue;
                const edge = x === 0 || y === 0 || x === width - 1 || y === height - 1 ||
                    !alpha[i - 1] || !alpha[i + 1] || !alpha[i - width] || !alpha[i + width];
                if (!edge) continue;
                put(i);
                if (x + 1 < width) put(i + 1);
                if (y + 1 < height) put(i + width);
            }
        }

        const border = document.createElement("canvas");
        border.width = width;
        border.height = height;
        border.getContext("2d").putImageData(out, 0, 0);

        // label anchor: centroid, nudged onto the mask for concave shapes
        let cx = Math.round(sumX / count);
        let cy = Math.round(sumY / count);
        if (!alpha[cy * width + cx]) {
            let best = Infinity;
            for (let y = 0; y < height; y++) {
                const row = y * width;
                for (let x = 0; x < width; x++) {
                    if (!alpha[row + x]) continue;
                    const dist = (x - cx) * (x - cx) + (y - cy) * (y - cy);
                    if (dist < best) {
                        best = dist;
                        cx = x;
                        cy = y;
                    }
                }
            }
        }

        return {key, border, cx, cy};
    }

    function ghostFor(layer, width, height, color, token) {
        const key = `${width}x${height}:${color}:${layer.dataUrl.length}:${layer.dataUrl.slice(-48)}`;
        if (layer.__ghost && layer.__ghost.key === key) return Promise.resolve(layer.__ghost);
        if (layer.__ghostPending && layer.__ghostPendingKey === key) return layer.__ghostPending;

        const promise = new Promise((resolve) => {
            const image = new Image();
            image.onload = () => {
                if (token !== state.ghostToken) {
                    resolve(null);
                    return;
                }
                const ghost = buildGhost(image, width, height, color, key);
                if (ghost) layer.__ghost = ghost;
                resolve(ghost);
            };
            image.onerror = () => resolve(null);
            image.src = layer.dataUrl;
        });
        layer.__ghostPending = promise;
        layer.__ghostPendingKey = key;
        return promise;
    }

    async function refreshGhosts() {
        const token = ++state.ghostToken;
        const p = getParts();
        if (!p) return;

        const {border, label} = ensureGhostCanvases(p);
        if (!state.enabled || state.layers.length < 2) {
            border.getContext("2d").clearRect(0, 0, border.width, border.height);
            label.getContext("2d").clearRect(0, 0, label.width, label.height);
            return;
        }

        const scale = Math.min(1, GHOST_MAX_DIM / Math.max(p.maskCanvas.width, p.maskCanvas.height));
        const width = Math.max(1, Math.round(p.maskCanvas.width * scale));
        const height = Math.max(1, Math.round(p.maskCanvas.height * scale));
        if (border.width !== width || border.height !== height) {
            border.width = width;
            border.height = height;
        }
        if (label.width !== width || label.height !== height) {
            label.width = width;
            label.height = height;
        }

        const borderCtx = border.getContext("2d");
        const labelCtx = label.getContext("2d");
        borderCtx.clearRect(0, 0, width, height);
        labelCtx.clearRect(0, 0, width, height);
        labelCtx.textAlign = "center";
        labelCtx.textBaseline = "middle";

        const others = state.layers
            .map((layer, index) => ({layer, index}))
            .filter(({layer}) => layer.id !== state.activeId && layer.dataUrl);

        for (const {layer, index} of others) {
            const color = GHOST_COLORS[index % GHOST_COLORS.length];
            const ghost = await ghostFor(layer, width, height, color, token);
            if (token !== state.ghostToken) return;
            if (!ghost) continue;

            borderCtx.drawImage(ghost.border, 0, 0);

            const radius = Math.max(9, Math.min(24, Math.round(Math.min(width, height) * 0.026)));
            labelCtx.beginPath();
            labelCtx.arc(ghost.cx, ghost.cy, radius, 0, Math.PI * 2);
            labelCtx.fillStyle = "rgba(10, 14, 22, 0.72)";
            labelCtx.fill();
            labelCtx.lineWidth = Math.max(1.5, radius * 0.12);
            labelCtx.strokeStyle = color;
            labelCtx.stroke();
            labelCtx.fillStyle = "#ffffff";
            labelCtx.font = `600 ${Math.round(radius * 1.2)}px sans-serif`;
            labelCtx.fillText(String(index + 1), ghost.cx, ghost.cy + radius * 0.04);
        }
    }

    /* -------------------------------------- UI --------------------------------------- */

    function actionButton(act, text, title) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "inpbatch-btn inpbatch-action";
        button.dataset.act = act;
        button.textContent = text;
        button.title = title;
        return button;
    }

    function renderList() {
        const panel = panelEl();
        if (!panel) return;
        const list = panel.querySelector(".inpbatch-list");
        if (!list) return;

        list.textContent = "";
        state.thumbEls = new Map();

        state.layers.forEach((layer, index) => {
            const item = document.createElement("div");
            item.className = `inpbatch-item${layer.id === state.activeId ? " inpbatch-active" : ""}`;
            item.dataset.id = layer.id;
            item.title = `${layer.name} - click to edit this mask`;

            const number = document.createElement("span");
            number.className = "inpbatch-num";
            number.textContent = String(index + 1);

            const thumb = document.createElement("span");
            thumb.className = "inpbatch-thumb";
            const img = document.createElement("img");
            img.className = "inpbatch-thumb-img";
            img.alt = "";
            if (layer.dataUrl) img.src = layer.dataUrl;
            else img.classList.add("inpbatch-thumb-empty");
            thumb.appendChild(img);
            state.thumbEls.set(layer.id, img);

            const name = document.createElement("span");
            name.className = "inpbatch-name";
            name.textContent = layer.name;

            const actions = document.createElement("span");
            actions.className = "inpbatch-actions";
            actions.append(
                actionButton("up", "\u25B2", "Process earlier"),
                actionButton("down", "\u25BC", "Process later"),
                actionButton("delete", "\u2715", "Delete this mask")
            );

            item.append(number, thumb, name, actions);
            list.appendChild(item);
        });
    }

    function updateThumb(layer) {
        const img = state.thumbEls.get(layer.id);
        if (!img) return;
        if (layer.dataUrl) {
            img.src = layer.dataUrl;
            img.classList.remove("inpbatch-thumb-empty");
        } else {
            img.removeAttribute("src");
            img.classList.add("inpbatch-thumb-empty");
        }
    }

    function updateChrome() {
        const panel = panelEl();
        if (!panel) return;
        const toggle = panel.querySelector(".inpbatch-toggle");
        const status = panel.querySelector(".inpbatch-status");
        const body = panel.querySelector(".inpbatch-body");
        toggle.textContent = `\u25E7 Batch mask: ${state.enabled ? "on" : "off"}`;
        toggle.classList.toggle("inpbatch-on", state.enabled);
        body.hidden = !state.enabled;
        status.textContent = state.enabled ?
            `${state.layers.length} mask${state.layers.length === 1 ? "" : "s"}` :
            "Single mask";
    }

    function panelEl() {
        const root = getRoot();
        return root ? root.querySelector(".inpbatch-panel") : null;
    }

    function onListClick(event) {
        const item = event.target.closest ? event.target.closest(".inpbatch-item") : null;
        if (!item) return;
        const action = event.target.closest("button[data-act]");
        const id = item.dataset.id;
        if (!action) {
            selectLayer(id);
            return;
        }
        if (action.dataset.act === "up") moveLayer(id, -1);
        else if (action.dataset.act === "down") moveLayer(id, 1);
        else if (action.dataset.act === "delete") deleteLayer(id);
    }

    function buildPanel() {
        const panel = document.createElement("div");
        panel.className = "inpbatch-panel";
        panel.innerHTML = `
      <div class="inpbatch-head">
        <button type="button" class="inpbatch-toggle" data-act="toggle">\u25E7 Batch mask: off</button>
        <span class="inpbatch-status">Single mask</span>
      </div>
      <div class="inpbatch-body" hidden>
        <div class="inpbatch-toolbar">
          <button type="button" class="inpbatch-btn" data-act="add" title="Create a new empty mask">+ New mask</button>
          <button type="button" class="inpbatch-btn" data-act="duplicate" title="Copy the selected mask">\u29C9 Duplicate</button>
          <button type="button" class="inpbatch-btn" data-act="clear-all" title="Erase the painted content of every mask (layers are kept)">\u232B Clear all</button>
        </div>
        <div class="inpbatch-order-hint">Applied top \u2192 bottom</div>
        <div class="inpbatch-list"></div>
        <div class="inpbatch-hint">Generate applies masks top \u2192 bottom, each starting from the previous result. Outlines show the other layers.</div>
      </div>`;
        panel.querySelector("[data-act=toggle]").addEventListener("click", () => setEnabled(!state.enabled));
        panel.querySelector("[data-act=add]").addEventListener("click", addLayer);
        panel.querySelector("[data-act=duplicate]").addEventListener("click", duplicateLayer);
        panel.querySelector("[data-act=clear-all]").addEventListener("click", clearAllLayers);
        panel.querySelector(".inpbatch-list").addEventListener("click", onListClick);
        return panel;
    }

    // place the panel in the empty gutter left of the picture, below the SAM tool bar
    function positionPanel(panel) {
        const root = getRoot();
        if (!root) return;
        const rootRect = root.getBoundingClientRect();
        const p = getParts();
        const bar = p ? p.host.querySelector(".inpsam-bar") : null;
        const barRect = bar ? bar.getBoundingClientRect() : null;

        let top = 8;
        if (barRect && barRect.height) top = Math.max(8, Math.ceil(barRect.bottom - rootRect.top + 6));

        let width = 230;
        if (p) {
            const canvasRect = p.iface.getBoundingClientRect();
            const gutter = canvasRect.left - rootRect.left - 12;
            if (gutter > 0) width = Math.max(160, Math.min(240, Math.round(gutter)));
        }

        panel.style.top = `${top}px`;
        panel.style.left = "6px";
        panel.style.width = `${width}px`;
        panel.style.maxHeight = `calc(100% - ${top + 8}px)`;
    }

    /* ---------------------------------- sketch hooks --------------------------------- */

    function bindSketchListeners() {
        const p = getParts();
        if (!p || p.root.dataset.inpbatchBound) return;
        p.root.dataset.inpbatchBound = "1";

        const onStrokeEnd = (event) => {
            if (event && event.__inpsamSynthetic) return; // our own / SAM's gradio sync stroke
            if (!state.enabled || !p.wrap.contains(event.target)) return;
            setTimeout(pushPayload, 0);
        };
        p.root.addEventListener("mouseup", onStrokeEnd, true);
        p.root.addEventListener("touchend", onStrokeEnd, true);

        p.root.addEventListener(
            "click",
            (event) => {
                const button = event.target.closest ? event.target.closest("button") : null;
                const label = button ? button.getAttribute("aria-label") || "" : "";
                if (label !== "Undo" && label !== "Clear") return;
                setTimeout(() => {
                    if (state.enabled) pushPayload();
                }, 80);
            },
            true
        );
    }

    // The mask canvas is recreated/cleared when a new image is loaded: put the selected layer back.
    function watchImage() {
        const p = getParts();
        if (!p) {
            if (state.imgEl || state.canvasEl) {
                state.imgEl = null;
                state.canvasEl = null;
                state.canvasLayerId = null;
            }
            return;
        }

        const imageChanged = p.img !== state.imgEl;
        const canvasChanged = p.maskCanvas !== state.canvasEl;
        if (!imageChanged && !canvasChanged) return;

        state.imgEl = p.img;
        state.canvasEl = p.maskCanvas;
        state.canvasLayerId = null;
        if (!state.enabled || !state.layers.length) {
            refreshGhosts();
            return;
        }

        setTimeout(() => {
            if (state.enabled) applyActiveLayer(true);
        }, 120);
        setTimeout(() => {
            if (state.enabled) applyActiveLayer(true);
        }, 500);
        setTimeout(refreshGhosts, 300);
    }

    /* ------------------------------- output gallery selection ------------------------ */

    // Batch results are chained: image N+1 was inpainted on top of image N, so "compare
    // with input" must show the image the whole chain started from, not a previous step.
    function normSrc(src) {
        if (!src) return "";
        let value = String(src).split("?")[0];
        try {
            value = decodeURIComponent(value);
        } catch (e) {
            // malformed escapes: keep the raw value
        }
        return value;
    }

    function rememberBatchInitial() {
        const gallery = byId("img2img_gallery");
        if (!gallery || !state.batchInitialSrc) return;
        gallery.querySelectorAll("img").forEach((img) => {
            const key = normSrc(img.src);
            if (key) state.batchInitials.set(key, state.batchInitialSrc);
        });
    }

    function selectLastResult(attempt) {
        const gallery = byId("img2img_gallery");
        if (!gallery) return;
        const thumbs = gallery.querySelectorAll(".thumbnail-item.thumbnail-small");
        if (!thumbs.length) {
            if (attempt < 24) setTimeout(() => selectLastResult(attempt + 1), 250);
            return;
        }
        const last = thumbs[thumbs.length - 1];
        if (!last.classList.contains("selected")) last.click();
    }

    function hookProgress() {
        if (state.progressHooked || typeof window.requestProgress !== "function") return;
        state.progressHooked = true;
        const original = window.requestProgress;
        window.requestProgress = function(idTask, progressContainer, gallery, atEnd, onProgress, inactivityTimeout) {
            const isImg2img = !!(gallery && gallery.id === "img2img_gallery");
            const wrapped = function() {
                try {
                    if (typeof atEnd === "function") return atEnd.apply(this, arguments);
                } finally {
                    if (isImg2img) {
                        if (state.pendingSelectLast) {
                            state.pendingSelectLast = false;
                            setTimeout(() => selectLastResult(0), 350);
                        }
                        if (state.batchInitialSrc) {
                            setTimeout(rememberBatchInitial, 350);
                            setTimeout(rememberBatchInitial, 1200);
                        }
                    }
                }
            };
            return original.call(this, idTask, progressContainer, gallery, wrapped, onProgress, inactivityTimeout);
        };
    }

    /* -------------------------------------- boot ------------------------------------- */

    function ensure() {
        const root = getRoot();
        if (!root) return;

        let panel = root.querySelector(".inpbatch-panel");
        if (!panel) {
            panel = buildPanel();
            root.appendChild(panel);
            renderList();
            updateChrome();
        }

        positionPanel(panel);
        bindSketchListeners();
        watchImage();
    }

    function boot() {
        hookProgress();
        ensure();

        window.inpaintBatchMask = {
            // used by the image viewer's "compare with input" button
            initialImageFor: (src) => state.batchInitials.get(normSrc(src)) || null,
        };

        // Generate reads the hidden textbox; refresh it before gradio's own click handler runs.
        document.addEventListener(
            "click",
            (event) => {
                const button = event.target.closest ? event.target.closest("#img2img_generate") : null;
                if (!button) return;
                pushPayload();
                state.pendingSelectLast = state.enabled && state.layers.filter((layer) => layer.dataUrl).length > 1;
                const p = getParts();
                state.batchInitialSrc = state.enabled && p && p.img && p.img.src ? p.img.src : null;
            },
            true
        );

        if (typeof onAfterUiUpdate === "function") onAfterUiUpdate(ensure);
        setInterval(ensure, 1000);
    }

    if (typeof onUiLoaded === "function") onUiLoaded(boot);
    else if (document.readyState === "complete") boot();
    else window.addEventListener("load", boot);
})();
