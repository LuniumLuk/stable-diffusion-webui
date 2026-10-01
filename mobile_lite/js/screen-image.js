/* Image screen: img2img + inpaint (paint / erase / SAM-tap mask editor). */

import { api, randomTaskId, ROOT } from './api.js';
import { isJobActive, runJob } from './job.js';
import { openParamsSheet } from './params.js';
import { createPromptEditor } from './prompt.js';
import { planInputResize } from './resize-plan.js';
import { on, persist, imageParams, resolveOutputSize, setParam, state } from './state.js';
import { busy, clamp, el, fileToImageSource, pickFile, toast } from './ui.js';
import { metaFromItem, openResultViewer } from './send.js';

// ------------------------------------------------------------------ state

const mask = {
  tool: 'paint', // paint | erase | sam
  drawing: false,
  last: null,
  currentOp: null, // stroke op being painted (pinch start removes it again)
  ops: [], // {type:'stroke', erase, brush, points:[[x,y]]} | {type:'sam', dataUrl}
  samAvailable: null,
  samBusy: false,
  lastPick: null, // { point, masks: [dataUrl], applied: opIndex }
};

const SAM_MAX_SIDE = 1024;

// ------------------------------------------------------------------ DOM refs

let root;
let prompt;
let stage;
let stageCard;
let stageFrame;
let stageImg;
let maskOutline;
let outlineRaf = null;
let editPill;
let imageToolsNode;
let maskEditor;
let maskColorsRow;
let editing = false;
let maskSized = false; // true once the mask canvas has been sized to a source image
let stageEmpty;
let maskCanvas;
let maskCtx;
let maskTools;
let toolButtons = {};
let summary;
let strip;
let generateButton;
let modeButtons = {};

// ------------------------------------------------------------------ helpers

function activeSource() {
  return state.image.source;
}

function isInpaint() {
  return state.image.mode === 'inpaint';
}

function outputSize() {
  return resolveOutputSize(activeSource(), imageParams());
}

function brushRadius() {
  return Math.max(2, Number(state.ui.brush) || 24);
}

/** Display colour of the mask (the exported mask is always white-alpha). */
function maskColor() {
  const value = String(state.ui.maskColor || '').trim();
  return /^#[0-9a-f]{6}$/i.test(value) ? value : '#00e0ff';
}

function maskOutlineColor() {
  const value = String(state.ui.maskOutlineColor || '').trim();
  return /^#[0-9a-f]{6}$/i.test(value) ? value : '#ffffff';
}

function hexToRgb(value) {
  const hex = value.replace('#', '');
  return [
    parseInt(hex.slice(0, 2), 16),
    parseInt(hex.slice(2, 4), 16),
    parseInt(hex.slice(4, 6), 16),
  ];
}

/**
 * The backend derives the inpaint mask from the image *luminance*
 * (``_decode_image(...).convert("L")``), so a coloured on-screen mask must be
 * normalised back to white ink before it is sent.
 */
function exportMaskDataUrl() {
  const out = document.createElement('canvas');
  out.width = maskCanvas.width;
  out.height = maskCanvas.height;
  const ctx = out.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.globalCompositeOperation = 'destination-in';
  ctx.drawImage(maskCanvas, 0, 0);
  return out.toDataURL('image/png');
}

function drawStroke(op) {
  maskCtx.save();
  maskCtx.globalCompositeOperation = op.erase ? 'destination-out' : 'source-over';
  maskCtx.strokeStyle = maskColor();
  maskCtx.fillStyle = maskColor();
  maskCtx.lineWidth = op.brush * 2;
  maskCtx.lineCap = 'round';
  maskCtx.lineJoin = 'round';

  const points = op.points;
  if (points.length === 1) {
    maskCtx.beginPath();
    maskCtx.arc(points[0][0], points[0][1], op.brush, 0, Math.PI * 2);
    maskCtx.fill();
  } else {
    maskCtx.beginPath();
    maskCtx.moveTo(points[0][0], points[0][1]);
    for (let index = 1; index < points.length; index += 1) {
      maskCtx.lineTo(points[index][0], points[index][1]);
    }
    maskCtx.stroke();
  }
  maskCtx.restore();
}

function samToWhiteMask(dataUrl, width, height) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, width, height);

      // The SAM extension answers with 1-bit bilevel masks (mode "1"): opaque, white =
      // selected, black = not selected. Alpha compositing such an image would keep the
      // whole picture, so the selection is taken from the luminance; RGBA masks (a real
      // alpha channel) are honoured as-is.
      const source = ctx.getImageData(0, 0, width, height);
      const data = source.data;
      let hasAlpha = false;
      for (let index = 3; index < data.length; index += 4) {
        if (data[index] < 250) {
          hasAlpha = true;
          break;
        }
      }
      const out = ctx.createImageData(width, height);
      const outData = out.data;
      const [red, green, blue] = hexToRgb(maskColor());
      for (let index = 0; index < data.length; index += 4) {
        const alpha = hasAlpha
          ? data[index + 3]
          : Math.max(data[index], data[index + 1], data[index + 2]);
        outData[index] = red;
        outData[index + 1] = green;
        outData[index + 2] = blue;
        outData[index + 3] = alpha;
      }
      ctx.putImageData(out, 0, 0);
      resolve(canvas);
    };
    img.onerror = () => resolve(null);
    img.src = dataUrl;
  });
}

async function replayMask() {
  maskCtx.clearRect(0, 0, maskCanvas.width, maskCanvas.height);
  for (const op of mask.ops) {
    if (op.type === 'stroke') {
      drawStroke(op);
    } else if (op.type === 'sam') {
      if (!op.canvas) op.canvas = await samToWhiteMask(op.dataUrl, maskCanvas.width, maskCanvas.height);
      if (op.canvas) {
        maskCtx.save();
        maskCtx.globalCompositeOperation = 'source-over';
        maskCtx.drawImage(op.canvas, 0, 0);
        maskCtx.restore();
      }
    }
  }
  updateMaskOutline();
}

function maskHasInk() {
  const sample = document.createElement('canvas');
  sample.width = 64;
  sample.height = 64;
  const ctx = sample.getContext('2d');
  ctx.drawImage(maskCanvas, 0, 0, 64, 64);
  const data = ctx.getImageData(0, 0, 64, 64).data;
  for (let index = 3; index < data.length; index += 4) {
    if (data[index] > 16) return true;
  }
  return false;
}

function clearMaskOps() {
  mask.ops = [];
  mask.lastPick = null;
  if (maskCtx) maskCtx.clearRect(0, 0, maskCanvas.width, maskCanvas.height);
  updateMaskOutline();
}

/* ------------------------------------------------------------------ mask outline
 *
 * The mask is a flat colour, so its boundary can be hard to read (white-on-white in the
 * worst case).  A cached silhouette of the mask is drawn on its own canvas and - when the
 * blink toggle is on - its opacity is toggled by a rAF loop (same idea as the desktop
 * inpaint panel's `.inpsam-outline` canvas).
 */

const OUTLINE_MAX_SIDE = 512;

function updateMaskOutline() {
  if (!maskOutline || !maskCanvas || !maskCanvas.width) return;
  maskOutline.width = maskCanvas.width;
  maskOutline.height = maskCanvas.height;
  const ctx = maskOutline.getContext('2d');
  ctx.clearRect(0, 0, maskOutline.width, maskOutline.height);
  if (!isInpaint() || !maskHasInk()) return;

  const scale = Math.min(1, OUTLINE_MAX_SIDE / Math.max(maskCanvas.width, maskCanvas.height));
  const width = Math.max(1, Math.round(maskCanvas.width * scale));
  const height = Math.max(1, Math.round(maskCanvas.height * scale));
  const scratch = document.createElement('canvas');
  scratch.width = width;
  scratch.height = height;
  const scratchCtx = scratch.getContext('2d');
  scratchCtx.drawImage(maskCanvas, 0, 0, width, height);

  const pixels = scratchCtx.getImageData(0, 0, width, height).data;
  const ink = new Uint8Array(width * height);
  for (let index = 0; index < ink.length; index += 1) {
    ink[index] = pixels[index * 4 + 3] > 128 ? 1 : 0;
  }
  const at = (x, y) => (x < 0 || y < 0 || x >= width || y >= height ? 0 : ink[y * width + x]);

  const [red, green, blue] = hexToRgb(maskOutlineColor());
  const outline = scratchCtx.createImageData(width, height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const here = at(x, y);
      const edge = here !== at(x - 1, y) || here !== at(x + 1, y)
        || here !== at(x, y - 1) || here !== at(x, y + 1);
      if (!edge) continue;
      // thicken by one pixel so the border survives the upscale to the full canvas
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          const px = x + dx;
          const py = y + dy;
          if (px < 0 || py < 0 || px >= width || py >= height) continue;
          const offset = (py * width + px) * 4;
          outline.data[offset] = red;
          outline.data[offset + 1] = green;
          outline.data[offset + 2] = blue;
          outline.data[offset + 3] = 255;
        }
      }
    }
  }
  scratchCtx.putImageData(outline, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(scratch, 0, 0, maskOutline.width, maskOutline.height);
}

function updateMaskBlink() {
  if (outlineRaf) {
    cancelAnimationFrame(outlineRaf);
    outlineRaf = null;
  }
  if (!maskOutline) return;
  const active = editing && isInpaint() && state.ui.maskBlink !== false;
  if (!active) {
    maskOutline.style.opacity = '1';
    return;
  }
  const step = () => {
    maskOutline.style.opacity = Math.floor(performance.now() / 520) % 2 ? '1' : '0.2';
    outlineRaf = requestAnimationFrame(step);
  };
  outlineRaf = requestAnimationFrame(step);
}

// ------------------------------------------------------------------ source loading

/** Adopt a gallery/result item's prompt and generation params (desktop "send to inpaint" parity). */
function applySourceMeta(meta) {
  if (!meta) return;
  const store = imageParams();
  const applied = [];
  if (meta.prompt) {
    prompt.positive = String(meta.prompt);
    applied.push('prompt');
  }
  if (meta.negative_prompt) {
    prompt.negative = String(meta.negative_prompt);
    applied.push('negative');
  }
  if (meta.steps) {
    setParam('steps', Math.max(1, Math.round(Number(meta.steps))), store);
    applied.push(`${Math.round(Number(meta.steps))} steps`);
  }
  if (meta.cfg) {
    setParam('cfg', Number(meta.cfg), store);
    applied.push(`CFG ${Number(meta.cfg)}`);
  }
  if (meta.sampler) {
    setParam('sampler', String(meta.sampler), store);
    applied.push(String(meta.sampler));
  }
  const seed = Number(meta.seed);
  if (Number.isFinite(seed) && seed >= 0) {
    // lock it so re-running the inpaint keeps the same noise (unlock in the params sheet)
    setParam('seed', seed, store);
    setParam('seedLock', true, store);
    applied.push(`seed ${seed} (locked)`);
  }
  if (applied.length) toast(`loaded ${applied.join(', ')}`, 'ok', 2800);
  updateSummary();
}

function setSource(source) {
  state.image.source = source;
  if (!source) {
    stageImg.hidden = true;
    stageEmpty.hidden = false;
    if (maskCanvas) maskCanvas.hidden = true;
    exitMaskEdit();
    return;
  }

  stageEmpty.hidden = true;
  stageImg.hidden = false;
  stageImg.src = source.dataUrl;
  fitStageFrame();
  stageImg.onload = () => {
    if (maskCanvas) {
      const sameSize = maskSized && maskCanvas.width === source.width && maskCanvas.height === source.height;
      if (sameSize) {
        // same picture dimensions - keep the painted mask (re-sending the same image keeps
        // the last mask area; a differently-sized picture starts clean)
        maskCtx = maskCanvas.getContext('2d');
        updateMaskOutline();
      } else {
        maskCanvas.width = source.width;
        maskCanvas.height = source.height;
        maskCtx = maskCanvas.getContext('2d');
        maskSized = true;
        clearMaskOps();
      }
      updateMaskVisibility();
      fitStageFrame();
    }
  };
  updateSummary();
}

/** Size the shared image frame (preview box or fullscreen editor) to fit its host. */
function fitStageFrame() {
  const source = activeSource();
  if (!source || !stageFrame) return;
  const host = editing ? maskEditor.querySelector('.mask-editor-body') : stage;
  const maxW = Math.max(80, (host.clientWidth || window.innerWidth) - 12);
  const maxH = editing
    ? Math.max(120, (host.clientHeight || window.innerHeight) - 12)
    : Math.max(80, Math.round(window.innerHeight * 0.3));
  const scale = Math.min(maxW / source.width, maxH / source.height);
  stageFrame.style.width = `${Math.max(1, Math.round(source.width * scale))}px`;
  stageFrame.style.height = `${Math.max(1, Math.round(source.height * scale))}px`;
  resetStageView(); // a (re)fit always returns to the un-zoomed view
}

/* The mask is only editable in the fullscreen editor: on the main screen the image stays a
   small non-interactive preview so the page keeps scrolling normally over long images. */
function enterMaskEdit() {
  if (editing || !isInpaint() || !activeSource()) return;
  editing = true;
  maskEditor.querySelector('.mask-editor-body').append(stageFrame);
  const foot = maskEditor.querySelector('.mask-editor-foot');
  foot.insertBefore(maskTools, maskColorsRow);
  maskEditor.hidden = false;
  document.body.classList.add('mask-editing');
  updateMaskVisibility();
  requestAnimationFrame(() => {
    fitStageFrame();
    updateMaskOutline();
  });
}

function exitMaskEdit() {
  if (!editing) return;
  editing = false;
  stage.insertBefore(stageFrame, stage.firstChild);
  if (stageCard && maskTools && imageToolsNode) stageCard.insertBefore(maskTools, imageToolsNode.nextSibling);
  maskEditor.hidden = true;
  document.body.classList.remove('mask-editing');
  updateMaskVisibility();
  requestAnimationFrame(() => fitStageFrame());
}

function updateMaskVisibility() {
  const inpaint = isInpaint();
  const hasSource = !!activeSource();
  if (maskCanvas) maskCanvas.hidden = !(inpaint && hasSource);
  if (maskOutline) maskOutline.hidden = !(inpaint && hasSource);
  // editing widgets live in the fullscreen editor only
  maskTools.hidden = !editing;
  if (editPill) editPill.hidden = !(inpaint && hasSource) || editing;
  for (const button of Object.values(toolButtons)) {
    button.classList.toggle('selected', button.dataset.tool === mask.tool);
  }
  updateMaskOutline();
  updateMaskBlink();
}

function updateSummary() {
  const params = imageParams();
  const size = outputSize();
  const input = planInputResize(activeSource(), params);
  summary.replaceChildren();
  const parts = [
    `denoise ${Number(params.denoise).toFixed(2)}`,
    input && input.mode !== 'off' ? `in ${input.width}\u00D7${input.height}` : '',
    `${size.width}×${size.height}`,
    `${params.steps} steps`,
    `CFG ${params.cfg}`,
    params.sampler || '-',
    params.batch > 1 ? `×${params.batch}` : '',
  ].filter(Boolean);
  if (isInpaint()) parts.splice(1, 0, params.inpaintFullRes ? 'only masked' : 'whole picture');
  for (const part of parts) summary.append(el('span', { text: part }));
  summary.append(el('span', { class: 'muted', text: '\u2699' }));

  generateButton.disabled = isJobActive() || !activeSource();
  generateButton.textContent = isInpaint() ? 'Generate inpaint' : 'Generate';
}

function renderResults() {
  const results = state.results.filter((item) => item.screen === 'img2img');
  strip.replaceChildren();
  const head = el('div', { class: 'card-head' }, [el('span', { text: `Results (${results.length})` })]);
  if (results.length) {
    head.append(el('button', {
      class: 'btn tiny ghost', type: 'button', text: 'clear',
      onClick: () => {
        state.results = state.results.filter((item) => item.screen !== 'img2img');
        renderResults();
      },
    }));
  }
  strip.append(head);

  if (!results.length) {
    strip.append(el('div', { class: 'empty-hint', text: 'Results of img2img/inpaint runs collect here.' }));
    return;
  }

  const grid = el('div', { class: 'results-strip' });
  for (const result of results.slice(0, 12)) {
    grid.append(el('button', {
      class: 'result', type: 'button', onClick: () => openResultViewer(result),
    }, [
      el('img', { src: result.thumb || result.url, alt: '', loading: 'lazy' }),
      result.seed !== undefined && result.seed !== null ? el('span', { class: 'seed-tag', text: `#${result.seed}` }) : null,
    ]));
  }
  strip.append(grid);
}

// ------------------------------------------------------------------ mask tools

function pushStroke(points, erase) {
  mask.ops.push({ type: 'stroke', erase, brush: brushRadius(), points });
  if (mask.ops.length > 60) mask.ops.shift();
}

// Paint gestures are fed from BOTH pointer and touch events: mobile WebKit does not
// always synthesize pointer events from touches (verified in the iPhone probe), while
// desktop/Chrome deliver pointer events for mouse and touch. The first source that
// starts a gesture owns it until it ends, so a browser that fires both never paints twice.
const gesture = { owner: null, ownerAt: 0 };

function claimGesture(owner) {
  const now = performance.now();
  if (gesture.owner && gesture.owner !== owner && now - gesture.ownerAt < 1500) return false;
  gesture.owner = owner;
  gesture.ownerAt = now;
  return true;
}

function releaseGesture(owner) {
  if (gesture.owner === owner) gesture.owner = null;
}

function pointFromClient(clientX, clientY) {
  const rect = maskCanvas.getBoundingClientRect();
  return {
    x: clamp((clientX - rect.left) * (maskCanvas.width / Math.max(1, rect.width)), 0, maskCanvas.width),
    y: clamp((clientY - rect.top) * (maskCanvas.height / Math.max(1, rect.height)), 0, maskCanvas.height),
  };
}

function strokeStart(point) {
  mask.drawing = true;
  mask.last = point;
  // op.points entries are [x, y] arrays (drawStroke reads points[i][0/1])
  pushStroke([[point.x, point.y]], mask.tool === 'erase');
  mask.currentOp = mask.ops[mask.ops.length - 1];
  drawStroke(mask.currentOp);
}

function strokeMove(point) {
  if (!mask.drawing || !mask.last) return;
  const previous = mask.last;
  if (Math.hypot(point.x - previous.x, point.y - previous.y) < 1.5) return;
  mask.last = point;
  const op = mask.ops[mask.ops.length - 1];
  op.points.push([point.x, point.y]);

  // draw only the new segment for speed
  maskCtx.save();
  maskCtx.globalCompositeOperation = op.erase ? 'destination-out' : 'source-over';
  maskCtx.strokeStyle = maskColor();
  maskCtx.lineWidth = op.brush * 2;
  maskCtx.lineCap = 'round';
  maskCtx.lineJoin = 'round';
  maskCtx.beginPath();
  maskCtx.moveTo(previous.x, previous.y);
  maskCtx.lineTo(point.x, point.y);
  maskCtx.stroke();
  maskCtx.restore();
}

function strokeEnd() {
  mask.drawing = false;
  mask.last = null;
  mask.currentOp = null;
  updateMaskOutline();
}

function gestureDown(owner, point) {
  if (mask.samBusy) return;
  if (mask.tool === 'sam') {
    if (claimGesture(owner)) samPick(point);
    return;
  }
  if (!claimGesture(owner)) return;
  strokeStart(point);
}

function gestureMove(owner, point) {
  if (gesture.owner !== owner) return;
  strokeMove(point);
}

function gestureUp(owner) {
  strokeEnd();
  releaseGesture(owner);
}

/* ---------------------------------------------------------------- editor zoom
 *
 * Two-finger pinch (and wheel) zoom/pan for the fullscreen mask editor. Painting maps
 * client coords through `getBoundingClientRect()`, which already includes this transform,
 * so strokes stay aligned at any zoom level. A pinch cancels the stroke the first finger
 * may have started, and painting is locked until all fingers are lifted again.
 */

const stageView = { scale: 1, x: 0, y: 0 };
const canvasPointers = new Map(); // pointerId -> { x, y } (client coords)
const canvasTouches = new Map(); // touch identifier -> { x, y }
let pinch = null; // { owner, dist, mid } while two fingers are down
let pinchLock = false; // ignore painting until every finger of a pinch has lifted

function applyStageView() {
  if (!stageFrame) return;
  stageFrame.style.transformOrigin = '0 0';
  stageFrame.style.transform = `translate(${stageView.x}px, ${stageView.y}px) scale(${stageView.scale})`;
}

function resetStageView() {
  stageView.scale = 1;
  stageView.x = 0;
  stageView.y = 0;
  applyStageView();
}

function pinchPoints(owner) {
  const map = owner === 'touch' ? canvasTouches : canvasPointers;
  return Array.from(map.values()).slice(0, 2);
}

function pinchDist(owner) {
  const [a, b] = pinchPoints(owner);
  return Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
}

function pinchMid(owner) {
  const [a, b] = pinchPoints(owner);
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

function pinchBegin(owner) {
  if (pinch || !editing) return;
  // the first finger may have started a stroke - drop it so a pinch leaves no stray dot
  if (mask.drawing && mask.currentOp) {
    const index = mask.ops.indexOf(mask.currentOp);
    if (index >= 0) mask.ops.splice(index, 1);
    replayMask();
  }
  mask.drawing = false;
  mask.last = null;
  mask.currentOp = null;
  pinchLock = true;
  pinch = { owner, dist: 0, mid: { x: 0, y: 0 }, origin: { x: 0, y: 0 } };
  const points = pinchPoints(owner);
  if (points.length >= 2 && stageFrame) {
    pinch.dist = pinchDist(owner);
    pinch.mid = pinchMid(owner);
    // the frame's untransformed layout origin (translate/scale happen around it)
    const rect = stageFrame.getBoundingClientRect();
    pinch.origin = { x: rect.left - stageView.x, y: rect.top - stageView.y };
  }
}

function pinchMove(owner) {
  if (!pinch || pinch.owner !== owner || !editing) return;
  const points = pinchPoints(owner);
  if (points.length < 2) return;
  const dist = pinchDist(owner);
  const mid = pinchMid(owner);
  const factor = pinch.dist > 0 ? dist / pinch.dist : 1;
  const next = clamp(stageView.scale * factor, 1, 8);
  const k = next / stageView.scale;
  // keep the map point that was under the old midpoint under the new one (pan + zoom)
  const ox = pinch.origin.x;
  const oy = pinch.origin.y;
  stageView.x = mid.x - ox - k * (pinch.mid.x - ox - stageView.x);
  stageView.y = mid.y - oy - k * (pinch.mid.y - oy - stageView.y);
  stageView.scale = next;
  applyStageView();
  pinch.dist = dist;
  pinch.mid = mid;
}

function pinchEnd(owner) {
  if (pinch && pinch.owner === owner && pinchPoints(owner).length < 2) {
    releaseGesture(owner); // a fresh single-finger gesture may start right away
    pinch = null;
  }
  if (canvasPointers.size === 0 && canvasTouches.size === 0) pinchLock = false;
}

function wheelZoom(clientX, clientY, deltaY) {
  if (!editing || !stageFrame) return;
  const rect = stageFrame.getBoundingClientRect();
  const layoutLeft = rect.left - stageView.x;
  const layoutTop = rect.top - stageView.y;
  const next = clamp(stageView.scale * Math.exp(-deltaY / 420), 1, 8);
  const k = next / stageView.scale;
  const ux = clientX - layoutLeft;
  const uy = clientY - layoutTop;
  stageView.x = ux - k * (ux - stageView.x);
  stageView.y = uy - k * (uy - stageView.y);
  stageView.scale = next;
  applyStageView();
}

function wireMaskPointer() {
  maskCanvas.addEventListener('pointerdown', (event) => {
    canvasPointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    try { maskCanvas.setPointerCapture(event.pointerId); } catch (_error) { /* capture is optional */ }
    if (canvasPointers.size >= 2) {
      pinchBegin('pointer');
      return;
    }
    if (pinchLock || pinch) return;
    gestureDown('pointer', pointFromClient(event.clientX, event.clientY));
  });
  maskCanvas.addEventListener('pointermove', (event) => {
    if (canvasPointers.has(event.pointerId)) {
      canvasPointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    }
    if (pinch && pinch.owner === 'pointer') {
      pinchMove('pointer');
      return;
    }
    gestureMove('pointer', pointFromClient(event.clientX, event.clientY));
  });
  const pointerEnd = (event) => {
    canvasPointers.delete(event.pointerId);
    pinchEnd('pointer');
    if (!pinch && !pinchLock) gestureUp('pointer');
  };
  maskCanvas.addEventListener('pointerup', pointerEnd);
  maskCanvas.addEventListener('pointercancel', pointerEnd);

  const syncTouches = (touches) => {
    canvasTouches.clear();
    for (const touch of touches) canvasTouches.set(touch.identifier, { x: touch.clientX, y: touch.clientY });
  };
  maskCanvas.addEventListener('touchstart', (event) => {
    syncTouches(event.touches);
    if (event.touches.length >= 2) {
      event.preventDefault();
      pinchBegin('touch');
      return;
    }
    if (pinchLock || pinch) return;
    if (!event.changedTouches || event.changedTouches.length !== 1) return;
    event.preventDefault();
    const touch = event.changedTouches[0];
    gestureDown('touch', pointFromClient(touch.clientX, touch.clientY));
  }, { passive: false });
  maskCanvas.addEventListener('touchmove', (event) => {
    syncTouches(event.touches);
    if (pinch && pinch.owner === 'touch') {
      event.preventDefault();
      pinchMove('touch');
      return;
    }
    if (!event.changedTouches || event.changedTouches.length !== 1) return;
    event.preventDefault();
    const touch = event.changedTouches[0];
    gestureMove('touch', pointFromClient(touch.clientX, touch.clientY));
  }, { passive: false });
  const touchEnd = (event) => {
    syncTouches(event.touches);
    pinchEnd('touch');
    if (pinch || pinchLock) return;
    if (event.changedTouches && event.changedTouches.length > 1) return;
    gestureUp('touch');
  };
  maskCanvas.addEventListener('touchend', touchEnd);
  maskCanvas.addEventListener('touchcancel', touchEnd);

  // desktop convenience + a deterministic way to exercise the zoom in tests
  maskCanvas.addEventListener('wheel', (event) => {
    if (!editing) return;
    event.preventDefault();
    wheelZoom(event.clientX, event.clientY, event.deltaY);
  }, { passive: false });
}

function snapshotForSam() {
  const source = activeSource();
  const scale = Math.min(1, SAM_MAX_SIDE / Math.max(source.width, source.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(source.width * scale));
  canvas.height = Math.max(1, Math.round(source.height * scale));
  canvas.getContext('2d').drawImage(stageImg, 0, 0, canvas.width, canvas.height);
  return { dataUrl: canvas.toDataURL('image/jpeg', 0.9), scale };
}

async function ensureSam() {
  if (mask.samAvailable !== null) return mask.samAvailable;
  try {
    const response = await fetch(`${ROOT}/sam/heartbeat`);
    mask.samAvailable = response.ok;
    if (response.ok) {
      try {
        const models = await (await fetch(`${ROOT}/sam/sam-model`)).json();
        mask.samModels = Array.isArray(models) ? models : [];
      } catch (_error) { mask.samModels = []; }
    }
  } catch (_error) {
    mask.samAvailable = false;
  }
  return mask.samAvailable;
}

async function samPick(point) {
  if (mask.samBusy) return;
  mask.samBusy = true;

  let overlay = null;
  try {
    const available = await ensureSam();
    if (!available) {
      toast('Segment Anything extension is not available', 'warn');
      return;
    }

    overlay = busy('segmenting…');
    const snapshot = snapshotForSam();
    const model = state.ui.samModel
      || (mask.samModels && mask.samModels.includes('mobile_sam.pt') ? 'mobile_sam.pt' : (mask.samModels || [])[0]);
    const result = await api('/sam/sam-predict', {
      method: 'POST',
      body: {
        sam_model_name: model,
        input_image: snapshot.dataUrl,
        sam_positive_points: [[point.x * snapshot.scale, point.y * snapshot.scale]],
        return_previews: false,
        max_side: SAM_MAX_SIDE,
      },
    });
    const masks = (result.masks || []).map((data) => `data:image/png;base64,${data}`);
    if (!masks.length) throw new Error(result.msg || 'no mask returned');

    if (mask.lastPick && mask.lastPick.applied) {
      mask.ops = mask.ops.filter((op) => op !== mask.lastPick.applied);
    }
    const dataUrl = masks[clamp(state.ui.samCandidate, 0, masks.length - 1)];
    const op = { type: 'sam', dataUrl };
    mask.ops.push(op);
    mask.lastPick = { point, masks, applied: op };
    await replayMask();
    overlay.setText(`segmented (${result.elapsed || '?'}s)`);
  } catch (error) {
    toast(`SAM failed: ${error.message}`, 'err', 4500);
  } finally {
    if (overlay) overlay.close();
    mask.samBusy = false;
  }
}

async function applySamCandidate() {
  if (!mask.lastPick) return;
  const masks = mask.lastPick.masks;
  const index = clamp(state.ui.samCandidate, 0, masks.length - 1);
  const op = { type: 'sam', dataUrl: masks[index] };
  const previous = mask.lastPick.applied;
  mask.ops = mask.ops.filter((entry) => entry !== previous);
  mask.ops.push(op);
  mask.lastPick.applied = op;
  await replayMask();
}

function buildToolsRow() {
  const make = (tool, label, title) => {
    const button = el('button', {
      class: 'btn tiny tool', type: 'button', text: label, title, dataset: { tool },
      onClick: () => {
        mask.tool = tool;
        updateMaskVisibility();
      },
    });
    toolButtons[tool] = button;
    return button;
  };

  const brushSlider = el('input', {
    type: 'range', min: 2, max: 160, step: 1, value: state.ui.brush,
    oninput: (event) => { state.ui.brush = Number(event.target.value); persist(); },
  });
  const brushLabel = el('span', { text: `${state.ui.brush}px` });
  brushSlider.addEventListener('input', (event) => { brushLabel.textContent = `${event.target.value}px`; });

  const candidateButtons = [1, 2, 3].map((number, index) => el('button', {
    class: `btn tiny ${state.ui.samCandidate === index ? 'on' : ''}`,
    type: 'button',
    text: String(number),
    title: `Use SAM candidate ${number} for the next tap`,
    onClick: () => {
      state.ui.samCandidate = index;
      candidateButtons.forEach((button, buttonIndex) => button.classList.toggle('on', buttonIndex === index));
      persist();
      applySamCandidate();
    },
  }));

  const row = el('div', { class: 'mask-tools' }, [
    make('paint', '\u{1F58C}'),
    make('erase', '\u{1F9F9}'),
    make('sam', '\u2728'),
    el('button', {
      class: 'btn tiny', type: 'button', text: '\u21B6', title: 'Undo',
      onClick: async () => { mask.ops.pop(); await replayMask(); },
    }),
    el('button', {
      class: 'btn tiny', type: 'button', text: '\u{1F5D1}', title: 'Clear mask',
      onClick: () => clearMaskOps(),
    }),
    el('div', { class: 'brush-slider' }, [brushSlider, brushLabel]),
    el('div', { class: 'row tight', style: { flex: '0 0 auto', gap: '4px' } }, candidateButtons),
  ]);

  ensureSam().then((available) => {
    toolButtons.sam.classList.toggle('hidden', !available);
    if (!available) {
      candidateButtons.forEach((button) => button.classList.add('hidden'));
    }
  });

  return row;
}

// ------------------------------------------------------------------ generate

async function generate() {
  if (isJobActive()) {
    toast('wait for the current job to finish', 'warn');
    return;
  }
  const source = activeSource();
  if (!source) {
    toast('load an image first', 'warn');
    return;
  }
  if (isInpaint() && !maskHasInk()) {
    toast('paint a mask first (inpaint mode)', 'warn');
    return;
  }

  const params = imageParams();
  const size = outputSize();
  const payload = {
    task_id: randomTaskId(),
    init_image: source.dataUrl,
    prompt: prompt.positive,
    negative_prompt: prompt.negative,
    steps: params.steps,
    cfg: params.cfg,
    sampler: params.sampler,
    scheduler: params.scheduler,
    seed: params.seedLock ? Number(params.seed) : -1,
    batch: params.batch,
    denoise: params.denoise,
    mask_blur: params.maskBlur,
    resize_mode: Number(params.fitMode) || 0,
    input_resize: params.inputResize,
    input_resize_scale: params.inputResizeScale,
    input_resize_w: params.inputResizeW,
    input_resize_h: params.inputResizeH,
    input_resize_fit: params.inputResizeFit,
    width: size.width,
    height: size.height,
  };
  if (isInpaint()) {
    payload.mask = exportMaskDataUrl();
    payload.fill = Number(params.fill) || 0;
    payload.inpaint_full_res = !!params.inpaintFullRes;
    payload.inpaint_full_res_padding = Number(params.inpaintPadding) || 0;
    payload.invert_mask = !!params.invertMask;
  }

  generateButton.disabled = true;
  try {
    await runJob('img2img', payload, { label: isInpaint() ? 'inpaint' : 'img2img', store: params });
  } catch (error) {
    toast(`could not start: ${error.message}`, 'err', 5000);
  } finally {
    generateButton.disabled = false;
    updateSummary();
  }
}

// ------------------------------------------------------------------ screen init

export function init(container) {
  root = container;
  prompt = createPromptEditor('image');

  stageImg = el('img', { class: 'stage-img', alt: '', hidden: true });
  maskCanvas = el('canvas', { id: 'maskCanvas', hidden: true });
  maskOutline = el('canvas', { id: 'maskOutline', hidden: true });
  stageEmpty = el('div', { class: 'stage-empty' }, [
    el('div', { text: 'No image loaded' }),
    el('div', { class: 'small', text: 'Upload, shoot or pick one from the gallery' }),
  ]);
  editPill = el('button', {
    class: 'stage-edit-pill', type: 'button', text: '\u270E Edit mask', hidden: true,
    title: 'Open the fullscreen mask editor',
    onClick: () => enterMaskEdit(),
  });
  stageFrame = el('div', { class: 'stage-frame' }, [stageImg, maskCanvas, maskOutline]);
  stage = el('div', { class: 'image-stage' }, [stageFrame, stageEmpty, editPill]);

  maskColorsRow = el('div', { class: 'mask-colors' });
  const maskColorInput = el('input', {
    type: 'color', value: maskColor(), title: 'Mask colour (display only - generated mask stays white)',
  });
  maskColorInput.addEventListener('input', async () => {
    state.ui.maskColor = maskColorInput.value;
    persist();
    // existing SAM ops cached their canvas with the old colour - rebuild them
    for (const op of mask.ops) {
      if (op.type === 'sam') delete op.canvas;
    }
    await replayMask();
  });
  const outlineColorInput = el('input', {
    type: 'color', value: maskOutlineColor(), title: 'Border colour of the mask outline',
  });
  outlineColorInput.addEventListener('input', () => {
    state.ui.maskOutlineColor = outlineColorInput.value;
    persist();
    updateMaskOutline();
  });
  const blinkButton = el('button', {
    class: 'btn tiny' + (state.ui.maskBlink !== false ? ' on' : ''),
    type: 'button',
    text: '\u2728 blink',
    title: 'Blink the mask border so dark or pale masks stay visible',
    onClick: () => {
      state.ui.maskBlink = state.ui.maskBlink === false;
      persist();
      blinkButton.classList.toggle('on', state.ui.maskBlink !== false);
      updateMaskBlink();
    },
  });
  maskColorsRow.append(
    el('label', { title: 'Mask colour' }, [el('span', { text: '\u{1F58C} mask' }), maskColorInput]),
    el('label', { title: 'Border colour' }, [el('span', { text: '\u2B1C border' }), outlineColorInput]),
    blinkButton,
  );

  maskEditor = el('div', { class: 'mask-editor', hidden: true }, [
    el('div', { class: 'mask-editor-head' }, [
      el('span', { class: 'mask-editor-title', text: 'Edit mask' }),
      el('button', { class: 'btn tiny', type: 'button', text: '\u2713 Done', onClick: () => exitMaskEdit() }),
    ]),
    el('div', { class: 'mask-editor-body' }),
    el('div', { class: 'mask-editor-foot' }, [maskColorsRow]),
  ]);
  document.body.append(maskEditor);
  window.addEventListener('resize', () => fitStageFrame());
  stage.addEventListener('dragover', (event) => { event.preventDefault(); stage.classList.add('drop'); });
  stage.addEventListener('dragleave', () => stage.classList.remove('drop'));
  stage.addEventListener('drop', async (event) => {
    event.preventDefault();
    stage.classList.remove('drop');
    const file = event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0];
    if (file) loadFile(file);
  });

  wireMaskPointer();
  maskTools = buildToolsRow();

  const uploadButton = el('button', {
    class: 'btn tiny', type: 'button', text: '\u{1F4C1} Upload',
    onClick: async () => { const file = await pickFile(); if (file) loadFile(file); },
  });
  const cameraButton = el('button', {
    class: 'btn tiny', type: 'button', text: '\u{1F4F7} Camera',
    onClick: async () => { const file = await pickFile({ capture: true }); if (file) loadFile(file); },
  });
  const galleryButton = el('button', {
    class: 'btn tiny', type: 'button', text: '\u{1F5BC} Gallery',
    onClick: async () => {
      const { openGalleryPicker } = await import('./screen-gallery.js');
      const picked = await openGalleryPicker();
      if (picked) {
        const { fetchImageData } = await import('./api.js');
        const overlay = busy('loading image…');
        try {
          const px = isInpaint() ? 2048 : 1536;
          const loaded = await fetchImageData({ path: picked.path, url: picked.url, px });
          const meta = metaFromItem(picked);
          setSource({ dataUrl: loaded.dataUrl, width: loaded.width, height: loaded.height, name: 'gallery', meta });
          applySourceMeta(meta);
        } catch (error) {
          toast(`could not load: ${error.message}`, 'err');
        } finally {
          overlay.close();
        }
      }
    },
  });
  const clearButton = el('button', {
    class: 'btn tiny', type: 'button', text: '\u2715', title: 'Clear image',
    onClick: () => setSource(null),
  });
  const imageTools = el('div', { class: 'image-tools' }, [uploadButton, cameraButton, galleryButton, clearButton]);
  imageToolsNode = imageTools;

  const makeMode = (mode, label) => {
    const button = el('button', {
      type: 'button', text: label, class: state.image.mode === mode ? 'on' : '',
      onClick: () => {
        state.image.mode = mode;
        if (mode !== 'inpaint') exitMaskEdit();
        modeButtons.img2img.classList.toggle('on', mode === 'img2img');
        modeButtons.inpaint.classList.toggle('on', mode === 'inpaint');
        updateMaskVisibility();
        updateSummary();
      },
    });
    modeButtons[mode] = button;
    return button;
  };
  const modeRow = el('div', { class: 'segmented' }, [makeMode('img2img', 'Image'), makeMode('inpaint', 'Inpaint')]);

  summary = el('button', { class: 'card summary-line', type: 'button', onClick: () => openParamsSheet('image') });
  strip = el('div', { class: 'card' });

  generateButton = el('button', { class: 'btn primary wide', type: 'button', text: 'Generate', onClick: generate });

  stageCard = el('div', { class: 'card' }, [stage, imageTools, maskTools]);
  const body = el('div', { class: 'scr-body' }, [
    modeRow,
    stageCard,
    prompt.root,
    summary,
    strip,
  ]);
  container.append(body, el('div', { class: 'scr-actions' }, [generateButton]));

  on('params', updateSummary);
  on('results', renderResults);
  on('job-finished', updateSummary);
  on('image-source', (event) => {
    setSource(event.detail);
    applySourceMeta(event.detail && event.detail.meta);
  });
  on('image-mode', () => {
    if (state.image.mode !== 'inpaint') exitMaskEdit();
    modeButtons.img2img.classList.toggle('on', state.image.mode === 'img2img');
    modeButtons.inpaint.classList.toggle('on', state.image.mode === 'inpaint');
    updateMaskVisibility();
    updateSummary();
  });

  setSource(state.image.source || null);
  // the image may have been sent here before this screen was ever initialized
  // (the event fires first, the screen boots on the tab switch) - adopt its meta now
  if (state.image.source && state.image.source.meta) applySourceMeta(state.image.source.meta);
  updateMaskVisibility();
  renderResults();
  updateSummary();
}

async function loadFile(file) {
  const overlay = busy('loading image…');
  try {
    const source = await fileToImageSource(file, { maxSide: 2048 });
    setSource(source);
    toast(`${source.width}×${source.height} loaded`, 'ok', 1600);
  } catch (error) {
    toast(`could not load: ${error.message}`, 'err');
  } finally {
    overlay.close();
  }
}

export function onShow() {
  fitStageFrame();
  updateSummary();
  renderResults();
  prompt.relayout();
}

/** Leaving the Image tab closes the fullscreen mask editor. */
export function onHide() {
  exitMaskEdit();
  prompt.onHide();
}
