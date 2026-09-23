/**
 * Inpaint SAM panel
 * =================
 * Upgrades the img2img "Inpaint" canvas (#img2maskimg, a gradio sketch component in mask mode)
 * with:
 *   - "SAM pick" mode: click a point on the image -> Segment Anything returns 3 candidate masks;
 *     the selected candidate (0/1/2) is dilated by the "expand" radius and unioned into the mask.
 *     Both the candidate toggle and expand radius apply to the NEXT pick only.
 *   - "Erase" mode: erases mask with a destination-out brush that shares the gradio brush radius.
 *   - Paint mode is fully custom: strokes are drawn by this panel at the exact pointer position
 *     (gradio's lazy-brush lag is bypassed), the native cursor stays visible and a brush-size
 *     ring is drawn at the true cursor position. Gradio's Undo button is re-routed to the panel's
 *     snapshot undo (gradio's stroke list no longer holds the real strokes).
 *   - Wheel zoom (cursor anchored) + right-mouse drag pan, replacing the builtin
 *     canvas-zoom-and-pan behaviour for this tab (no modifier keys needed, no scrollbars).
 *
 * Implementation notes (gradio 3.41.2 sketch internals):
 *   - Canvases in the component: key="interface" (cursor preview + mouse handlers),
 *     key="mask" (the actual inpaint mask; A1111 converts its ALPHA channel to the binary mask,
 *     alpha > 128 = repaint area), key="drawing"/"temp" (the visible source image).
 *   - The component value only updates when the sketch dispatches "change", which happens on
 *     mouseup of a stroke on the interface canvas (mousedown -> mousemove -> mouseup).
 *     After modifying the mask canvas directly we therefore fire a synthetic off-canvas
 *     mousedown/mousemove/mouseup triple on the interface canvas: lazy-brush snaps to the
 *     (off-canvas) pointer, so the injected stroke is fully clipped and invisible, yet the
 *     full mask canvas is re-serialized and pushed into the component value.
 *   - The brush radius is shared with gradio's own "Brush radius" slider (read live; cached).
 */
(() => {
  "use strict";

  const ROOT_SEL = "#img2maskimg";
  const LS = {
    mode: "inpsam.mode",
    model: "inpsam.model",
    maskIdx: "inpsam.maskIdx",
    expand: "inpsam.expand",
    brush: "inpsam.cachedBrushRadius",
    brushColor: "inpsam.brushColor",
    samColor: "inpsam.samColor",
    outlineColor: "inpsam.outlineColor",
    blink: "inpsam.blink",
  };
  const DEFAULT_EXPAND = 30;
  const OFFSCREEN = 50000; // synthetic sync stroke offset (large enough that lazy-brush stays off-canvas)

  const state = {
    mode: "paint", // paint | sam | erase
    model: "",
    models: [],
    maskIdx: 0,
    expand: DEFAULT_EXPAND,
    brushRadius: null, // natural-pixel radius of gradio brush, mirrored from its slider
    zoom: 1,
    panX: 0,
    panY: 0,
    busy: false,
    pan: null,
    erase: null,
    undo: [],
    imgEl: null,
    samAvailable: null,
    // colors (persisted; RGB is cosmetic only - A1111 uses the mask ALPHA channel)
    brushColor: "#ffffff", // color applied to brush-painted strokes
    samColor: "#0b0f19", // color applied to SAM-picked segments
    outlineColor: "#00e0ff", // color of the silhouette outline
    blink: true, // blink the outline (false = static outline)
    palette: { gradio: "#ffffff", brush: "#ffffff", sam: "#0b0f19" }, // colors believed present in the mask canvas
    paint: null, // active custom paint stroke {last, lastMid}
    outlineCache: null, // offscreen canvas holding the current silhouette
    blinkRaf: null,
    blinkPhase: null,
  };

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(v, hi));
  const readLS = (k, d) => {
    try {
      const v = window.localStorage ? window.localStorage.getItem(k) : null;
      return v === null || v === undefined ? d : v;
    } catch (e) {
      return d;
    }
  };
  const writeLS = (k, v) => {
    try {
      window.localStorage && window.localStorage.setItem(k, String(v));
    } catch (e) {
      /* ignore */
    }
  };

  const hexToRgb = (hex) => {
    const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex || "");
    return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : [255, 255, 255];
  };
  const normalizeHex = (v) => (/^#[0-9a-f]{6}$/i.test(v || "") ? v.toLowerCase() : null);
  const rgbToHex = (rgb) => "#" + rgb.map((c) => clamp(c | 0, 0, 255).toString(16).padStart(2, "0")).join("");
  const gradioBrushColor = () => {
    try {
      return normalizeHex((window.opts && window.opts.img2img_inpaint_mask_brush_color) || "") || "#ffffff";
    } catch (e) {
      return "#ffffff";
    }
  };

  function getRoot() {
    const app = typeof gradioApp === "function" ? gradioApp() : document;
    return app.querySelector(ROOT_SEL);
  }

  function getParts() {
    const root = getRoot();
    if (!root) return null;
    const iface = root.querySelector('canvas[key="interface"]');
    const maskCanvas = root.querySelector('canvas[key="mask"]');
    const wrap = iface ? iface.closest(".wrap") : null;
    if (!iface || !maskCanvas || !wrap) return null;
    return {
      root,
      iface,
      maskCanvas,
      wrap,
      host: wrap.parentElement,
      img: root.querySelector("img.absolute-img"),
    };
  }

  function setStatus(text, isErr) {
    const p = getParts();
    const el = (p && p.host && p.host.querySelector(".inpsam-status")) || document.querySelector(".inpsam-status");
    if (el) {
      el.textContent = text;
      el.classList.toggle("inpsam-err", !!isErr);
    }
  }

  /* ---------------------------------- zoom / pan ---------------------------------- */

  function applyView() {
    const p = getParts();
    if (!p) return;
    const t =
      state.zoom === 1 && state.panX === 0 && state.panY === 0
        ? ""
        : `translate(${state.panX}px, ${state.panY}px) scale(${state.zoom})`;
    // transform the canvases themselves: they may be larger than the wrapper box
    p.wrap.querySelectorAll("canvas").forEach((cv) => {
      cv.style.transformOrigin = "0 0";
      cv.style.transform = t;
    });
  }

  function clampPan() {
    const p = getParts();
    if (!p) return;
    const view = p.root.getBoundingClientRect();
    const w = (p.iface.offsetWidth || 1) * state.zoom;
    const h = (p.iface.offsetHeight || 1) * state.zoom;
    const keep = 80; // keep at least this much of the canvas on screen
    state.panX = clamp(state.panX, Math.min(keep - w, 0), Math.max(view.width - keep, 0));
    state.panY = clamp(state.panY, Math.min(keep - h, 0), Math.max(view.height - keep, 0));
  }

  function fitView() {
    const p = getParts();
    if (!p) return;
    const view = p.root.getBoundingClientRect();
    const w = p.iface.offsetWidth || p.wrap.offsetWidth || 1;
    const h = p.iface.offsetHeight || p.wrap.offsetHeight || 1;
    const scale = Math.min(1, (view.width * 0.98) / w, (view.height * 0.98) / h);
    state.zoom = scale > 0 ? scale : 1;
    state.panX = 0;
    state.panY = 0;
    applyView();
  }

  function zoomAt(clientX, clientY, factor) {
    const p = getParts();
    if (!p) return;
    const r = p.wrap.getBoundingClientRect();
    const cx = clientX - r.left;
    const cy = clientY - r.top;
    const next = clamp(state.zoom * factor, 0.2, 16);
    if (next === state.zoom) return;
    state.panX = state.panX + cx - (cx / state.zoom) * next;
    state.panY = state.panY + cy - (cy / state.zoom) * next;
    state.zoom = next;
    clampPan();
    applyView();
  }

  function addGestureListeners() {
    document.addEventListener("mousemove", onGestureMove, true);
    document.addEventListener("mouseup", onGestureUp, true);
  }

  function startPan(e) {
    state.pan = { x: e.clientX, y: e.clientY, panX: state.panX, panY: state.panY };
    addGestureListeners();
  }

  function onGestureMove(e) {
    if (e.__inpsamSynthetic) return;
    if (state.pan) {
      state.panX = state.pan.panX + (e.clientX - state.pan.x);
      state.panY = state.pan.panY + (e.clientY - state.pan.y);
      clampPan();
      applyView();
      e.preventDefault();
    } else if (state.erase) {
      const to = naturalPoint(e.clientX, e.clientY);
      if (to) {
        eraseStroke(state.erase.last, to);
        state.erase.last = to;
      }
      e.preventDefault();
    } else if (state.paint) {
      const to = naturalPoint(e.clientX, e.clientY);
      if (to) paintStroke(state.paint, to);
      e.preventDefault();
    }
  }

  function onGestureUp(e) {
    if (e && e.__inpsamSynthetic) return;
    let needSync = false;
    if (state.pan) state.pan = null;
    if (state.erase) {
      const wasErase = state.erase;
      state.erase = null;
      if (wasErase.last) needSync = true;
    }
    if (state.paint) {
      paintFinish(state.paint);
      state.paint = null;
      needSync = true; // commit the custom paint stroke into the gradio value
    }
    document.removeEventListener("mousemove", onGestureMove, true);
    document.removeEventListener("mouseup", onGestureUp, true);
    if (needSync) {
      syncMaskToGradio();
      rebuildOutline();
    }
  }

  /* ---------------------------------- coordinates --------------------------------- */

  function naturalSize() {
    const p = getParts();
    if (!p || !p.img) return null;
    const w = p.img.naturalWidth || p.iface.width;
    const h = p.img.naturalHeight || p.iface.height;
    if (!w || !h) return null;
    return { w, h };
  }

  // client coords -> natural image pixel coords (same mapping gradio uses internally)
  function naturalPoint(clientX, clientY) {
    const p = getParts();
    const nat = naturalSize();
    if (!p || !nat) return null;
    const r = p.iface.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    return {
      x: ((clientX - r.left) / r.width) * nat.w,
      y: ((clientY - r.top) / r.height) * nat.h,
    };
  }

  /* ---------------------------------- mask painting ------------------------------- */

  function maskCtx() {
    const p = getParts();
    if (!p) return null;
    return p.maskCanvas.getContext("2d");
  }

  function pushSnapshot() {
    const p = getParts();
    if (!p) return;
    try {
      state.undo.push(p.maskCanvas.toDataURL("image/png"));
      if (state.undo.length > 15) state.undo.shift();
    } catch (e) {
      /* ignore */
    }
  }

  async function loadImage(src) {
    return new Promise((resolve, reject) => {
      const im = new Image();
      im.onload = () => resolve(im);
      im.onerror = () => reject(new Error("failed to load image"));
      im.src = src;
    });
  }

  async function srcToDataURL(src) {
    if (!src) throw new Error("no source image");
    if (src.startsWith("data:")) return src;
    const blob = await (await fetch(src)).blob();
    return await new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result);
      fr.onerror = () => reject(new Error("failed to read image"));
      fr.readAsDataURL(blob);
    });
  }

  // Draw a white-on-black bilevel mask PNG onto the mask canvas as alpha (alpha>128 => masked).
  async function drawMaskImageOntoCanvas(b64) {
    const p = getParts();
    const ctx = maskCtx();
    if (!p || !ctx) throw new Error("canvas not ready");
    const sc = hexToRgb(state.samColor);
    const im = await loadImage((b64.startsWith("data:") ? b64 : "data:image/png;base64," + b64));
    const c = document.createElement("canvas");
    c.width = im.naturalWidth;
    c.height = im.naturalHeight;
    const cctx = c.getContext("2d");
    cctx.drawImage(im, 0, 0);
    const data = cctx.getImageData(0, 0, c.width, c.height);
    const a = data.data;
    for (let i = 0; i < a.length; i += 4) {
      a[i + 3] = a[i] > 127 ? 255 : 0; // luminance -> alpha
      a[i] = sc[0];
      a[i + 1] = sc[1];
      a[i + 2] = sc[2];
    }
    cctx.putImageData(data, 0, 0);
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = "source-over";
    ctx.drawImage(c, 0, 0, p.maskCanvas.width, p.maskCanvas.height);
    ctx.restore();
  }

  function brushRadiusNatural() {
    if (state.brushRadius && state.brushRadius > 0) return state.brushRadius;
    return 20;
  }

  // Single source of truth for the brush size (drives paint, erase and the size ring).
  // Mirrors the value into gradio's hidden brush-radius slider when it is present.
  function setBrushRadius(v, fromGradio) {
    v = clamp(Math.round(Number(v) || 0), 1, 400);
    state.brushRadius = v;
    writeLS(LS.brush, v);
    const p = getParts();
    const bar = p && p.host ? p.host.querySelector(".inpsam-bar") : null;
    if (bar) {
      const sc = bar.querySelector(".inpsam-size");
      if (sc && String(v) !== sc.value) sc.value = String(v);
      const sv = bar.querySelector(".inpsam-size-val");
      if (sv) sv.textContent = String(v);
    }
    if (!fromGradio && p) {
      const gi = p.root.querySelector("input[aria-label='Brush radius']");
      if (gi) {
        gi.value = String(v);
        gi.dispatchEvent(new Event("input"));
        gi.dispatchEvent(new Event("change"));
      }
    }
  }

  function eraseStroke(from, to) {
    const p = getParts();
    const ctx = maskCtx();
    if (!p || !ctx) return;
    const nat = naturalSize();
    const k = nat ? p.maskCanvas.width / nat.w : 1;
    ctx.save();
    ctx.setTransform(k, 0, 0, k, 0, 0);
    ctx.globalCompositeOperation = "destination-out";
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.lineWidth = brushRadiusNatural();
    ctx.strokeStyle = "rgba(0,0,0,1)";
    ctx.fillStyle = "rgba(0,0,0,1)";
    ctx.beginPath();
    if (from) {
      ctx.moveTo(from.x, from.y);
      ctx.lineTo(to.x, to.y);
      ctx.stroke();
    } else {
      ctx.arc(to.x, to.y, ctx.lineWidth / 2, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  // Custom full-speed paint brush: strokes are drawn at the exact pointer position (no lazy-brush lag).
  function paintDot(pt) {
    const p = getParts();
    const ctx = maskCtx();
    if (!p || !ctx) return;
    const nat = naturalSize();
    const k = nat ? p.maskCanvas.width / nat.w : 1;
    ctx.save();
    ctx.setTransform(k, 0, 0, k, 0, 0);
    ctx.globalCompositeOperation = "source-over";
    ctx.fillStyle = state.brushColor;
    ctx.beginPath();
    ctx.arc(pt.x, pt.y, brushRadiusNatural() / 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  function paintStroke(st, to) {
    const p = getParts();
    const ctx = maskCtx();
    if (!p || !ctx) return;
    const nat = naturalSize();
    const k = nat ? p.maskCanvas.width / nat.w : 1;
    const mid = { x: (st.last.x + to.x) / 2, y: (st.last.y + to.y) / 2 };
    ctx.save();
    ctx.setTransform(k, 0, 0, k, 0, 0);
    ctx.globalCompositeOperation = "source-over";
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.lineWidth = brushRadiusNatural();
    ctx.strokeStyle = state.brushColor;
    ctx.beginPath();
    ctx.moveTo(st.lastMid.x, st.lastMid.y);
    ctx.quadraticCurveTo(st.last.x, st.last.y, mid.x, mid.y);
    ctx.stroke();
    ctx.restore();
    st.lastMid = mid;
    st.last = to;
  }

  // Finish a custom paint stroke: the midpoint smoothing leaves the tail short of the last
  // pointer position, so draw the remaining segment so the stroke ends exactly under the cursor.
  function paintFinish(st) {
    const p = getParts();
    const ctx = maskCtx();
    if (!p || !ctx || !st) return;
    const nat = naturalSize();
    const k = nat ? p.maskCanvas.width / nat.w : 1;
    ctx.save();
    ctx.setTransform(k, 0, 0, k, 0, 0);
    ctx.globalCompositeOperation = "source-over";
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.lineWidth = brushRadiusNatural();
    ctx.strokeStyle = state.brushColor;
    ctx.beginPath();
    ctx.moveTo(st.lastMid.x, st.lastMid.y);
    ctx.lineTo(st.last.x, st.last.y);
    ctx.stroke();
    ctx.restore();
  }

  // Brush-size ring at the true cursor position (drawn on gradio's interface canvas).
  function drawBrushRing(clientX, clientY) {
    const p = getParts();
    if (!p) return;
    const pt = naturalPoint(clientX, clientY);
    if (!pt) return;
    const ctx = p.iface.getContext("2d");
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, p.iface.width, p.iface.height);
    ctx.restore();
    const r = brushRadiusNatural() / 2;
    ctx.beginPath();
    ctx.arc(pt.x, pt.y, r, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(0, 0, 0, 0.8)";
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(pt.x, pt.y, r, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(255, 255, 255, 0.9)";
    ctx.lineWidth = 1.4;
    ctx.stroke();
  }

  /* --------------------------- mask colors (brush / SAM) --------------------------- */

  // Recolor pixels in the mask canvas: map matching "from" rgb values to "to" rgb values.
  function recolorMask(pairs, tol) {
    const p = getParts();
    if (!p) return 0;
    const w = p.maskCanvas.width;
    const h = p.maskCanvas.height;
    if (!w || !h) return 0;
    const ctx = p.maskCanvas.getContext("2d");
    let img;
    try {
      img = ctx.getImageData(0, 0, w, h);
    } catch (e) {
      return 0;
    }
    const d = img.data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] === 0) continue;
      for (let k = 0; k < pairs.length; k++) {
        const from = pairs[k][0];
        const to = pairs[k][1];
        if (Math.abs(d[i] - from[0]) <= tol && Math.abs(d[i + 1] - from[1]) <= tol && Math.abs(d[i + 2] - from[2]) <= tol) {
          d[i] = to[0];
          d[i + 1] = to[1];
          d[i + 2] = to[2];
          n++;
          break;
        }
      }
    }
    if (n) ctx.putImageData(img, 0, 0);
    return n;
  }

  // Map every color the canvas may still contain (gradio's brush color / previous palette values)
  // to the currently configured colors. Color changes are cosmetic (alpha drives the mask), so the
  // gradio value is intentionally NOT re-synced here (would add no-op strokes to its history).
  function applyPaletteToCanvas() {
    const bc = hexToRgb(state.brushColor);
    const sc = hexToRgb(state.samColor);
    const pairs = [];
    if (state.palette.gradio !== state.brushColor) pairs.push([hexToRgb(state.palette.gradio), bc]);
    if (state.palette.brush !== state.brushColor) pairs.push([hexToRgb(state.palette.brush), bc]);
    if (state.palette.sam !== state.samColor) pairs.push([hexToRgb(state.palette.sam), sc]);
    state.palette.brush = state.brushColor;
    state.palette.sam = state.samColor;
    if (!pairs.length) return 0;
    return recolorMask(pairs, 6);
  }

  let paletteTimer = null;
  function schedulePaletteApply() {
    if (paletteTimer) return;
    paletteTimer = setTimeout(() => {
      paletteTimer = null;
      applyPaletteToCanvas();
    }, 80);
  }

  /* ------------------------------- silhouette outline ------------------------------ */

  function ensureOutlineCanvas(p) {
    let c = p.wrap.querySelector(".inpsam-outline");
    if (!c) {
      c = document.createElement("canvas");
      c.className = "inpsam-outline";
      c.style.pointerEvents = "none";
      p.wrap.appendChild(c);
    }
    const m = p.maskCanvas;
    if (c.width !== m.width || c.height !== m.height) {
      c.width = m.width;
      c.height = m.height;
    }
    if (c.style.width !== m.style.width) c.style.width = m.style.width;
    if (c.style.height !== m.style.height) c.style.height = m.style.height;
    return c;
  }

  // Recompute the silhouette of the current mask into an offscreen cache.
  function rebuildOutline() {
    const p = getParts();
    if (!p) return;
    const w = p.maskCanvas.width;
    const h = p.maskCanvas.height;
    if (!w || !h) return;
    ensureOutlineCanvas(p);
    let img;
    try {
      img = p.maskCanvas.getContext("2d").getImageData(0, 0, w, h);
    } catch (e) {
      return;
    }
    const a = img.data;
    const cache = document.createElement("canvas");
    cache.width = w;
    cache.height = h;
    const cctx = cache.getContext("2d");
    const cimg = cctx.createImageData(w, h);
    const cd = cimg.data;
    const col = hexToRgb(state.outlineColor);
    const alphaAt = (x, y) => (x < 0 || y < 0 || x >= w || y >= h ? 0 : a[(y * w + x) * 4 + 3]);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (alphaAt(x, y) <= 128) continue;
        const edge =
          alphaAt(x - 1, y) <= 128 || alphaAt(x + 1, y) <= 128 || alphaAt(x, y - 1) <= 128 || alphaAt(x, y + 1) <= 128;
        if (!edge) continue;
        const marks = [
          [x, y],
          [x - 1, y],
          [x + 1, y],
          [x, y - 1],
          [x, y + 1],
        ];
        for (let k = 0; k < marks.length; k++) {
          const mx = marks[k][0];
          const my = marks[k][1];
          if (mx < 0 || my < 0 || mx >= w || my >= h) continue;
          const i = (my * w + mx) * 4;
          cd[i] = col[0];
          cd[i + 1] = col[1];
          cd[i + 2] = col[2];
          cd[i + 3] = 255;
        }
      }
    }
    cctx.putImageData(cimg, 0, 0);
    state.outlineCache = cache;
    renderOutlineFrame();
  }

  function renderOutlineFrame() {
    const p = getParts();
    if (!p) return;
    const c = p.wrap.querySelector(".inpsam-outline");
    if (!c) return;
    const ctx = c.getContext("2d");
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, c.width, c.height);
    if (!state.outlineCache) return;
    const phase = state.blink ? Math.floor(performance.now() / 480) % 2 : 1;
    ctx.globalAlpha = phase ? 1 : 0.15;
    ctx.drawImage(state.outlineCache, 0, 0);
    ctx.globalAlpha = 1;
  }

  function blinkLoop() {
    state.blinkRaf = null;
    if (!state.blink) return;
    const phase = Math.floor(performance.now() / 480) % 2;
    if (phase !== state.blinkPhase) {
      state.blinkPhase = phase;
      renderOutlineFrame();
    }
    state.blinkRaf = requestAnimationFrame(blinkLoop);
  }

  function updateBlinkLoop() {
    if (state.blink) {
      state.blinkPhase = null;
      if (!state.blinkRaf) state.blinkRaf = requestAnimationFrame(blinkLoop);
    } else if (state.blinkRaf) {
      cancelAnimationFrame(state.blinkRaf);
      state.blinkRaf = null;
    }
    renderOutlineFrame();
  }

  /* -------------------------------- gradio value sync ------------------------------ */

  function syncMaskToGradio() {
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
    // Mark these events so our own handlers ignore them (only gradio should process the sync stroke).
    const mk = (type, buttons) => {
      const ev = new MouseEvent(type, Object.assign({}, base, { buttons: buttons }));
      ev.__inpsamSynthetic = true;
      return ev;
    };
    try {
      p.iface.dispatchEvent(mk("mousedown", 1));
      p.iface.dispatchEvent(mk("mousemove", 1));
      p.iface.dispatchEvent(mk("mouseup", 0));
    } catch (e) {
      setStatus("mask sync failed: " + e.message, true);
    }
  }

  /* ----------------------------------- SAM pick ----------------------------------- */

  async function postJSON(url, body) {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`${url} -> HTTP ${r.status}`);
    return r.json();
  }

  async function samPick(clientX, clientY) {
    if (state.busy) return;
    const p = getParts();
    if (!p || !p.img || !p.img.src) {
      setStatus("no image loaded", true);
      return;
    }
    const pt = naturalPoint(clientX, clientY);
    if (!pt) {
      setStatus("cannot map click position", true);
      return;
    }
    state.busy = true;
    setStatus(`segmenting (${state.model || "default"}) ...`);
    try {
      const dataUrl = await srcToDataURL(p.img.src);
      const resp = await postJSON("/sam/sam-predict", {
        sam_model_name: state.model || undefined,
        input_image: dataUrl,
        sam_positive_points: [[Math.round(pt.x), Math.round(pt.y)]],
        sam_negative_points: [],
      });
      const masks = resp.masks || [];
      if (!masks.length) throw new Error(resp.msg || "no masks returned");
      const idx = clamp(state.maskIdx, 0, masks.length - 1);
      let maskB64 = masks[idx];
      let expanded = 0;
      if (state.expand > 0) {
        const d = await postJSON("/sam/dilate-mask", {
          input_image: dataUrl,
          mask: maskB64,
          dilate_amount: state.expand,
        });
        if (d && d.mask) {
          maskB64 = d.mask;
          expanded = state.expand;
        }
      }
      pushSnapshot();
      await drawMaskImageOntoCanvas(maskB64);
      syncMaskToGradio();
      rebuildOutline();
      setStatus(`mask ${idx} added${expanded ? ` (+${expanded}px)` : ""}`);
    } catch (err) {
      setStatus("SAM error: " + err.message, true);
    } finally {
      state.busy = false;
    }
  }

  /* ------------------------------------ toolbar ----------------------------------- */

  function buildToolbar(p) {
    const bar = document.createElement("div");
    bar.className = "inpsam-bar";
    bar.innerHTML = `
      <div class="inpsam-row">
        <span class="inpsam-modes">
          <button type="button" class="inpsam-btn" data-mode="paint" title="Gradio mask paint brush">\u270E Paint</button>
          <button type="button" class="inpsam-btn" data-mode="sam" title="Click a point: segment it (SAM) and add to mask">\u2702 SAM pick</button>
          <button type="button" class="inpsam-btn" data-mode="erase" title="Erase mask (uses the gradio brush radius)">\u232B Erase</button>
        </span>
        <span class="inpsam-sep"></span>
        <button type="button" class="inpsam-btn inpsam-icon" data-act="undo" title="Undo last SAM pick / erase (restores mask snapshot; discards strokes painted after it)">\u21B6</button>
        <button type="button" class="inpsam-btn inpsam-icon" data-act="fit" title="Reset zoom (fit)">\u27F2</button>
        <span class="inpsam-status"></span>
      </div>
      <div class="inpsam-row inpsam-samrow">
        <label title="SAM model used for picks">SAM
          <select class="inpsam-model" title="SAM model (from the Segment Anything extension)"></select>
        </label>
        <label title="Which of the 3 candidate masks to use for the NEXT pick">mask
          <span class="inpsam-idx">
            <button type="button" class="inpsam-btn inpsam-mini" data-idx="0">0</button>
            <button type="button" class="inpsam-btn inpsam-mini" data-idx="1">1</button>
            <button type="button" class="inpsam-btn inpsam-mini" data-idx="2">2</button>
          </span>
        </label>
        <label title="Dilate the segment of the NEXT pick by this many pixels">expand
          <input type="range" class="inpsam-expand" min="0" max="100" step="1" />
        </label>
        <span class="inpsam-expand-val">0</span>
        <span class="inpsam-hint">(mask &amp; expand apply to next pick)</span>
      </div>
      <div class="inpsam-row inpsam-colorrow">
        <label title="Brush size (same as gradio's brush radius; also Ctrl/Alt + wheel over the canvas)">size
          <input type="range" class="inpsam-size" min="1" max="400" step="1" />
          <span class="inpsam-size-val"></span>
        </label>
        <label title="Color of brush-painted mask strokes">brush <input type="color" class="inpsam-c-brush" /></label>
        <label title="Color of SAM-picked segments">SAM <input type="color" class="inpsam-c-sam" /></label>
        <label title="Color of the silhouette outline around the mask">outline <input type="color" class="inpsam-c-outline" /></label>
        <button type="button" class="inpsam-btn inpsam-icon inpsam-blink" title="Toggle blinking outline (off = static outline)">\u25C9</button>
      </div>`;
    p.host.appendChild(bar);

    bar.addEventListener("mousedown", (e) => e.stopPropagation());
    bar.addEventListener("click", (e) => e.stopPropagation());

    // mode buttons
    bar.querySelectorAll("[data-mode]").forEach((btn) => {
      btn.addEventListener("click", () => setMode(btn.dataset.mode));
    });
    // mask index
    bar.querySelectorAll("[data-idx]").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.maskIdx = parseInt(btn.dataset.idx, 10) || 0;
        writeLS(LS.maskIdx, state.maskIdx);
        refreshToolbarState();
      });
    });
    // expand radius
    const expandInput = bar.querySelector(".inpsam-expand");
    const expandVal = bar.querySelector(".inpsam-expand-val");
    expandInput.value = String(state.expand);
    expandVal.textContent = String(state.expand);
    expandInput.addEventListener("input", () => {
      state.expand = parseInt(expandInput.value, 10) || 0;
      expandVal.textContent = String(state.expand);
      writeLS(LS.expand, state.expand);
    });
    // model select
    const sel = bar.querySelector(".inpsam-model");
    sel.addEventListener("change", () => {
      state.model = sel.value;
      writeLS(LS.model, state.model);
    });
    // action buttons
    bar.querySelector('[data-act="undo"]').addEventListener("click", undoLast);
    bar.querySelector('[data-act="fit"]').addEventListener("click", () => fitView());

    // colors + blink toggle
    const cBrush = bar.querySelector(".inpsam-c-brush");
    cBrush.value = state.brushColor;
    cBrush.addEventListener("input", () => {
      const v = normalizeHex(cBrush.value);
      if (!v) return;
      state.brushColor = v;
      writeLS(LS.brushColor, v);
      schedulePaletteApply();
    });
    const cSam = bar.querySelector(".inpsam-c-sam");
    cSam.value = state.samColor;
    cSam.addEventListener("input", () => {
      const v = normalizeHex(cSam.value);
      if (!v) return;
      state.samColor = v;
      writeLS(LS.samColor, v);
      schedulePaletteApply();
    });
    let outlineTimer = null;
    const cOutline = bar.querySelector(".inpsam-c-outline");
    cOutline.value = state.outlineColor;
    cOutline.addEventListener("input", () => {
      const v = normalizeHex(cOutline.value);
      if (!v) return;
      state.outlineColor = v;
      writeLS(LS.outlineColor, v);
      if (outlineTimer) clearTimeout(outlineTimer);
      outlineTimer = setTimeout(() => {
        outlineTimer = null;
        rebuildOutline();
      }, 80);
    });
    bar.querySelector(".inpsam-blink").addEventListener("click", () => {
      state.blink = !state.blink;
      writeLS(LS.blink, state.blink ? "1" : "0");
      refreshToolbarState();
      updateBlinkLoop();
    });

    // brush size
    const sizeInput = bar.querySelector(".inpsam-size");
    sizeInput.value = String(brushRadiusNatural());
    bar.querySelector(".inpsam-size-val").textContent = String(brushRadiusNatural());
    sizeInput.addEventListener("input", () => setBrushRadius(parseInt(sizeInput.value, 10) || 20, false));
    return bar;
  }

  function refreshToolbarState() {
    const p = getParts();
    if (!p) return;
    const bar = p.host.querySelector(".inpsam-bar");
    if (!bar) return;
    bar.querySelectorAll("[data-mode]").forEach((b) => b.classList.toggle("inpsam-active", b.dataset.mode === state.mode));
    bar.querySelectorAll("[data-idx]").forEach((b) => b.classList.toggle("inpsam-active", parseInt(b.dataset.idx, 10) === state.maskIdx));
    const cB = bar.querySelector(".inpsam-c-brush");
    if (cB && cB.value !== state.brushColor) cB.value = state.brushColor;
    const cS = bar.querySelector(".inpsam-c-sam");
    if (cS && cS.value !== state.samColor) cS.value = state.samColor;
    const cO = bar.querySelector(".inpsam-c-outline");
    if (cO && cO.value !== state.outlineColor) cO.value = state.outlineColor;
    const bl = bar.querySelector(".inpsam-blink");
    if (bl) bl.classList.toggle("inpsam-active", state.blink);
    const sz = bar.querySelector(".inpsam-size");
    if (sz && String(brushRadiusNatural()) !== sz.value) sz.value = String(brushRadiusNatural());
    const szv = bar.querySelector(".inpsam-size-val");
    if (szv) szv.textContent = String(brushRadiusNatural());
    const sel = bar.querySelector(".inpsam-model");
    if (sel && state.model && sel.value !== state.model) sel.value = state.model;
    if (sel && state.models.length && !sel.options.length) {
      sel.innerHTML = state.models.map((m) => `<option value="${m}">${m}</option>`).join("");
      sel.value = state.model || state.models[0];
    }
    bar.classList.toggle("inpsam-no-sam", state.samAvailable === false);
  }

  async function refreshModels() {
    try {
      const r = await fetch("/sam/sam-model");
      if (!r.ok) throw new Error("http " + r.status);
      const models = await r.json();
      if (Array.isArray(models) && models.length) {
        state.models = models;
        state.samAvailable = true;
        if (!state.model || models.indexOf(state.model) === -1) {
          state.model = readLS(LS.model, "") || "";
          if (models.indexOf(state.model) === -1) state.model = models[0];
        }
      }
    } catch (e) {
      state.samAvailable = false;
      setStatus("SAM extension not reachable", true);
    }
    refreshToolbarState();
  }

  async function undoLast() {
    const p = getParts();
    if (!p) return;
    const snap = state.undo.pop();
    if (!snap) {
      setStatus("nothing to undo");
      return;
    }
    try {
      const im = await loadImage(snap);
      const ctx = p.maskCanvas.getContext("2d");
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, p.maskCanvas.width, p.maskCanvas.height);
      ctx.drawImage(im, 0, 0, p.maskCanvas.width, p.maskCanvas.height);
      ctx.restore();
      syncMaskToGradio();
      applyPaletteToCanvas();
      rebuildOutline();
      setStatus("undo");
    } catch (e) {
      setStatus("undo failed: " + e.message, true);
    }
  }

  /* ---------------------------------- mode handling -------------------------------- */

  function setMode(mode) {
    if (["paint", "sam", "erase"].indexOf(mode) === -1) mode = "paint";
    state.mode = mode;
    writeLS(LS.mode, mode);
    applyModeAppearance();
    refreshToolbarState();
    if (mode === "sam") setStatus("click a point to pick a segment");
    else if (mode === "erase") setStatus("drag to erase mask");
    else setStatus("");
  }

  function clearGradioCursor() {
    const p = getParts();
    if (!p) return;
    try {
      const ctx = p.iface.getContext("2d");
      ctx.clearRect(0, 0, p.iface.width, p.iface.height);
    } catch (e) {
      /* ignore */
    }
  }

  function cursorEl() {
    let c = document.querySelector(".inpsam-cursor");
    if (!c) {
      c = document.createElement("div");
      c.className = "inpsam-cursor";
      document.body.appendChild(c);
    }
    return c;
  }

  function updateCursor(e) {
    const c = cursorEl();
    if (state.mode !== "erase") {
      c.style.display = "none";
      return;
    }
    const p = getParts();
    const nat = naturalSize();
    if (!p || !nat || !p.wrap.contains(e.target)) {
      c.style.display = "none";
      return;
    }
    const r = p.iface.getBoundingClientRect();
    const d = brushRadiusNatural() * (r.width / nat.w);
    c.style.width = `${d}px`;
    c.style.height = `${d}px`;
    c.style.left = `${e.clientX - d / 2}px`;
    c.style.top = `${e.clientY - d / 2}px`;
    c.style.display = "block";
  }

  function applyModeAppearance() {
    const p = getParts();
    if (!p) return;
    p.wrap.querySelectorAll("canvas").forEach((cv) => {
      cv.style.cursor = "crosshair"; // keep the native cursor visible in every mode
    });
    if (state.mode !== "erase") cursorEl().style.display = "none";
    clearGradioCursor();
  }

  function watchBrushRadius() {
    const p = getParts();
    if (!p) return null;
    const input = p.root.querySelector("input[aria-label='Brush radius']");
    if (input && !input.dataset.inpsam) {
      input.dataset.inpsam = "1";
      const upd = () => {
        const v = parseFloat(input.value);
        if (!isNaN(v) && v > 0) setBrushRadius(v, true);
      };
      input.addEventListener("input", upd);
      input.addEventListener("change", upd);
      upd();
    }
    return input || null;
  }

  /* -------------------------------- event plumbing -------------------------------- */

  function inCanvas(p, e) {
    return !!p && p.wrap.contains(e.target);
  }

  function inBar(p, e) {
    const bar = p && p.host && p.host.querySelector(".inpsam-bar");
    return !!(bar && bar.contains(e.target));
  }

  function bindRootListeners(p) {
    if (p.root.dataset.inpsamBound) return;
    p.root.dataset.inpsamBound = "1";

    p.root.addEventListener(
      "mousedown",
      (e) => {
        if (e.__inpsamSynthetic) return; // our own mask-sync stroke: let gradio process it
        const q = getParts();
        if (!q || inBar(q, e)) return;
        if (e.button === 2 && inCanvas(q, e)) {
          // right mouse: pan in every mode (also stops gradio from painting with RMB)
          e.preventDefault();
          e.stopPropagation();
          startPan(e);
          return;
        }
        if (!inCanvas(q, e)) return;
        e.preventDefault();
        e.stopPropagation();
        if (e.button !== 0) return;
        if (state.mode === "sam") {
          samPick(e.clientX, e.clientY);
          return;
        }
        const to = naturalPoint(e.clientX, e.clientY);
        if (!to) return;
        if (state.mode === "erase") {
          pushSnapshot();
          state.erase = { last: null };
          eraseStroke(null, to);
          state.erase.last = to;
        } else {
          // paint: custom full-speed stroke (gradio's lazy-brush painting is bypassed entirely)
          pushSnapshot();
          state.paint = { last: to, lastMid: to };
          paintDot(to);
        }
        addGestureListeners();
      },
      true
    );

    // gradio must not see hover/move/up either (stale lazy cursor / its own strokes); in paint
    // mode the panel draws the stroke itself at the exact pointer position.
    p.root.addEventListener(
      "mousemove",
      (e) => {
        if (e.__inpsamSynthetic) return; // sync stroke: gradio must receive it
        const q = getParts();
        if (!q || inBar(q, e)) {
          cursorEl().style.display = "none";
          return;
        }
        updateCursor(e);
        if (state.mode === "paint") drawBrushRing(e.clientX, e.clientY);
        if (inCanvas(q, e) || state.paint || state.erase || state.pan) {
          e.stopPropagation();
          e.preventDefault();
        }
      },
      true
    );
    ["mouseup", "mouseout", "click"].forEach((type) => {
      p.root.addEventListener(
        type,
        (e) => {
          if (e.__inpsamSynthetic) return; // sync stroke: gradio must receive it
          const q = getParts();
          if (!q || inBar(q, e)) return;
          if (inCanvas(q, e)) {
            e.stopPropagation();
            e.preventDefault();
          }
        },
        true
      );
    });

    p.root.addEventListener("contextmenu", (e) => {
      const q = getParts();
      if (q && inCanvas(q, e)) e.preventDefault();
    });

    p.root.addEventListener(
      "wheel",
      (e) => {
        const q = getParts();
        if (!q || inBar(q, e)) return;
        e.preventDefault();
        e.stopPropagation();
        if (e.ctrlKey || e.altKey) {
          adjustGradioBrush(e.deltaY);
        } else {
          zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.0015));
        }
      },
      { capture: true, passive: false }
    );

    p.root.addEventListener(
      "dblclick",
      (e) => {
        const q = getParts();
        if (!q || inBar(q, e) || !inCanvas(q, e)) return;
        e.preventDefault();
        e.stopPropagation();
        fitView();
      },
      true
    );

    p.root.addEventListener("mouseleave", () => {
      cursorEl().style.display = "none";
      clearGradioCursor();
    });

    // reset view when a new image is loaded into the canvas
    p.root.addEventListener(
      "load",
      (e) => {
        if (e.target && e.target.classList && e.target.classList.contains("absolute-img")) {
          state.undo = [];
          setTimeout(() => {
            applyModeAppearance();
            fitView();
          }, 60);
          setTimeout(fitView, 300); // re-fit once layout (imageMaskFix) settles
        }
      },
      true
    );

    // gradio's own Undo button is re-routed to the panel's snapshot undo (gradio's stroke list no
    // longer contains the real strokes); Clear/Remove Image keep gradio's behavior, then the
    // palette + outline are refreshed.
    p.root.addEventListener(
      "click",
      (e) => {
        const btn = e.target && e.target.closest ? e.target.closest("button") : null;
        if (!btn || (e.target.closest && e.target.closest(".inpsam-bar"))) return;
        const label = btn.getAttribute("aria-label") || "";
        if (label === "Undo") {
          e.preventDefault();
          e.stopPropagation();
          undoLast();
          return;
        }
        if (label !== "Clear" && label !== "Remove Image") return;
        setTimeout(() => {
          applyPaletteToCanvas();
          rebuildOutline();
        }, 80);
      },
      true
    );
  }

  function adjustGradioBrush(deltaY) {
    const step = Math.max(1, Math.round(brushRadiusNatural() * 0.1));
    setBrushRadius(brushRadiusNatural() + (deltaY > 0 ? -step : step), false);
  }

  /* ------------------------------------ ensure ------------------------------------ */

  function positionBar(bar, host) {
    if (!bar || !host) return;
    const hostRect = host.getBoundingClientRect();
    if (!hostRect.width || !hostRect.height) return; // component hidden
    const op = bar.offsetParent || document.body;
    const opRect = op.getBoundingClientRect();
    const left = hostRect.left - opRect.left + (op.scrollLeft || 0) + 6;
    const top = hostRect.top - opRect.top + (op.scrollTop || 0) + 6;
    bar.style.left = `${left}px`;
    bar.style.top = `${top}px`;
  }

  function ensure() {
    const p = getParts();
    if (!p) {
      // canvas not present (no image loaded): remove stale UI
      document.querySelectorAll(".inpsam-bar").forEach((b) => b.remove());
      cursorEl().style.display = "none";
      return;
    }
    bindRootListeners(p);
    watchBrushRadius();

    // keep the silhouette layer sized to the mask canvas (also after gradio resizes/swaps the image)
    const oc = p.wrap.querySelector(".inpsam-outline");
    if (!oc || oc.width !== p.maskCanvas.width || oc.height !== p.maskCanvas.height) {
      rebuildOutline();
    }

    let bar = p.host.querySelector(".inpsam-bar");
    if (!bar || bar.parentElement !== p.host) {
      document.querySelectorAll(".inpsam-bar").forEach((b) => b.remove());
      bar = buildToolbar(p);
      positionBar(bar, p.host);
      refreshModels();
    } else {
      positionBar(bar, p.host);
    }
    refreshToolbarState();

    // image identity changed -> reset state and fit the view
    if (p.img && state.imgEl !== p.img) {
      state.imgEl = p.img;
      state.undo = [];
      state.zoom = 1;
      state.panX = 0;
      state.panY = 0;
      applyModeAppearance();
      const refit = () => {
        const q = getParts();
        if (q && q.img === p.img) {
          applyModeAppearance();
          fitView();
        }
      };
      setTimeout(refit, 200);
      setTimeout(refit, 700); // re-fit once a later layout pass settles the canvas size
    }
  }

  function boot() {
    // restore persisted settings
    state.mode = ["paint", "sam", "erase"].indexOf(readLS(LS.mode, "paint")) !== -1 ? readLS(LS.mode, "paint") : "paint";
    state.maskIdx = clamp(parseInt(readLS(LS.maskIdx, "0"), 10) || 0, 0, 2);
    state.expand = clamp(parseInt(readLS(LS.expand, String(DEFAULT_EXPAND)), 10) || 0, 0, 100);
    const cachedBrush = parseFloat(readLS(LS.brush, ""));
    if (!isNaN(cachedBrush) && cachedBrush > 0) state.brushRadius = cachedBrush;

    // colors + blink (remembered across sessions; defaults mirror the classic white-brush / dark-SAM look)
    state.brushColor = normalizeHex(readLS(LS.brushColor, "")) || gradioBrushColor();
    state.samColor = normalizeHex(readLS(LS.samColor, "")) || "#0b0f19";
    state.outlineColor = normalizeHex(readLS(LS.outlineColor, "")) || "#00e0ff";
    state.blink = readLS(LS.blink, "1") !== "0";
    state.palette.gradio = gradioBrushColor();
    state.palette.brush = state.brushColor;
    state.palette.sam = state.samColor;

    ensure();
    setMode(state.mode);
    updateBlinkLoop();
    if (typeof onAfterUiUpdate === "function") onAfterUiUpdate(ensure);
    window.addEventListener("resize", () => {
      const p = getParts();
      if (p) {
        const bar = p.host.querySelector(".inpsam-bar");
        if (bar) positionBar(bar, p.host);
      }
    });
    setInterval(ensure, 1500);
  }

  if (typeof onUiLoaded === "function") onUiLoaded(boot);
  else if (document.readyState === "complete") boot();
  else window.addEventListener("load", boot);
})();
