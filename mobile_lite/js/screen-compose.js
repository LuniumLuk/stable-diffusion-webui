/* Compose screen: touch layer compositor (add/transform/reorder/save/send). */

import { api_, fetchImageData } from './api.js';
import {
  busy, clamp, el, fileToImageSource, openSheet, closeSheet, pickFile, toast,
} from './ui.js';
import { useSourceAsImage } from './send.js';
import { persist, state } from './state.js';

const CANVAS_PRESETS = [
  [512, 512],
  [768, 768],
  [1024, 1024],
  [832, 1216],
  [1216, 832],
];

const compose = {
  width: 1024,
  height: 1024,
  autoSized: true,
  layers: [], // top-first; each: {id, img, name, x, y, scale, rot, flip, opacity, paint?}
  active: null,
  gesture: null,
  paintLayer: null, // full-canvas brush/eraser overlay, kept on top and skipped by move hit-tests
};

let canvas;
let ctx;
let stage;
let layerCountLabel;
let activeNameLabel;

/* ------------------------------------------------------------------ rendering */

function requestRender() {
  if (requestRender.pending) return;
  requestRender.pending = true;
  requestAnimationFrame(() => {
    requestRender.pending = false;
    render();
  });
}

function render() {
  if (!ctx) return;
  ctx.clearRect(0, 0, compose.width, compose.height);

  // bottom-up
  for (let index = compose.layers.length - 1; index >= 0; index -= 1) {
    drawLayer(ctx, compose.layers[index]);
  }

  // the selection box would sit on the whole canvas while painting - only show it in move mode
  if (compose.active && paintTool() === 'move') {
    drawSelection(ctx, compose.active);
  }
}

function drawLayer(target, layer, withSelection = false) {
  target.save();
  target.translate(layer.x, layer.y);
  target.rotate((layer.rot * Math.PI) / 180);
  target.scale(layer.scale * (layer.flip ? -1 : 1), layer.scale);
  target.globalAlpha = layer.opacity;
  target.drawImage(layer.img, -layer.img.width / 2, -layer.img.height / 2);
  target.restore();
  void withSelection;
}

function drawSelection(target, layer) {
  const halfW = (layer.img.width * layer.scale) / 2;
  const halfH = (layer.img.height * layer.scale) / 2;
  target.save();
  target.translate(layer.x, layer.y);
  target.rotate((layer.rot * Math.PI) / 180);
  const lineWidth = Math.max(2, 2 / 1);
  target.setLineDash([8, 6]);
  target.lineWidth = lineWidth;
  target.strokeStyle = 'rgba(249,115,22,0.95)';
  target.strokeRect(-halfW, -halfH, halfW * 2, halfH * 2);
  target.restore();
}

/** Point in a layer's local image space (un-translate / un-rotate / un-scale). */
function layerLocalPoint(layer, point) {
  const dx = point.x - layer.x;
  const dy = point.y - layer.y;
  const cos = Math.cos((-layer.rot * Math.PI) / 180);
  const sin = Math.sin((-layer.rot * Math.PI) / 180);
  const rx = dx * cos - dy * sin;
  const ry = dx * sin + dy * cos;
  const scaleX = layer.scale * (layer.flip ? -1 : 1);
  return { x: rx / scaleX, y: ry / layer.scale };
}

function layerAt(point) {
  for (const layer of compose.layers) {
    if (layer.paint) continue; // the paint overlay is edited with the brush/eraser only
    const local = layerLocalPoint(layer, point);
    if (Math.abs(local.x) <= layer.img.width / 2 && Math.abs(local.y) <= layer.img.height / 2) return layer;
  }
  return null;
}

/* ------------------------------------------------------------------ brush + eraser */

function paintTool() {
  const tool = state.ui.composeTool;
  return tool === 'brush' || tool === 'eraser' ? tool : 'move';
}

/** Create the paint overlay on first stroke: a full-canvas layer pinned on top. */
function ensurePaintLayer() {
  if (compose.paintLayer && compose.layers.includes(compose.paintLayer)) return compose.paintLayer;
  const surface = document.createElement('canvas');
  surface.width = compose.width;
  surface.height = compose.height;
  compose.paintLayer = {
    id: (layerId += 1),
    img: surface,
    name: '\u270F\uFE0F Paint',
    srcDataUrl: null,
    paint: true,
    x: compose.width / 2,
    y: compose.height / 2,
    scale: 1,
    rot: 0,
    flip: false,
    opacity: 1,
  };
  compose.layers.unshift(compose.paintLayer);
  return compose.paintLayer;
}

/** Stage point -> paint overlay pixel. */
function toLayerPoint(layer, point) {
  const local = layerLocalPoint(layer, point);
  return { x: local.x + layer.img.width / 2, y: local.y + layer.img.height / 2 };
}

/** Draw one stroke segment (or a dot for a tap) on the paint overlay; eraser cuts back out. */
function paintStroke(from, to, erase) {
  const layer = compose.paintLayer;
  if (!layer) return;
  const surface = layer.img.getContext('2d');
  const rect = canvas.getBoundingClientRect();
  const ratio = compose.width / Math.max(1, rect.width);
  const a = toLayerPoint(layer, from);
  const b = toLayerPoint(layer, to);
  surface.save();
  surface.globalCompositeOperation = erase ? 'destination-out' : 'source-over';
  surface.strokeStyle = state.ui.composePaintColor;
  surface.lineWidth = Math.max(1, (state.ui.composePaintSize * ratio) / Math.max(0.01, layer.scale));
  surface.lineCap = 'round';
  surface.lineJoin = 'round';
  surface.beginPath();
  surface.moveTo(a.x, a.y);
  surface.lineTo(b.x, b.y);
  surface.stroke();
  surface.restore();
}

/* ------------------------------------------------------------------ gestures */

function stagePoint(event) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: (event.clientX - rect.left) * (compose.width / Math.max(1, rect.width)),
    y: (event.clientY - rect.top) * (compose.height / Math.max(1, rect.height)),
  };
}

function wireGestures() {
  const pointers = new Map();

  canvas.addEventListener('pointerdown', (event) => {
    try { canvas.setPointerCapture(event.pointerId); } catch (_error) { /* synthetic events have no active pointer */ }
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });

    if (pointers.size === 1) {
      const point = stagePoint(event);
      const tool = paintTool();
      if (tool !== 'move') {
        // brush creates the overlay, eraser only edits an existing one
        const layer = tool === 'brush' ? ensurePaintLayer() : compose.paintLayer;
        if (!layer) {
          toast('nothing painted yet - paint something with the brush first', 'warn', 1800);
          compose.gesture = null;
        } else {
          compose.active = layer;
          updateActiveLabel();
          compose.gesture = {
            kind: 'paint',
            pointerId: event.pointerId,
            erase: tool === 'eraser',
            lastX: point.x,
            lastY: point.y,
          };
          paintStroke(point, { x: point.x + 0.01, y: point.y }, tool === 'eraser'); // a tap leaves a dot
          requestRender();
        }
        return;
      }
      const hit = layerAt(point);
      compose.active = hit || compose.active;
      updateActiveLabel();
      compose.gesture = {
        kind: hit ? 'move' : 'none',
        layer: hit,
        startX: point.x,
        startY: point.y,
        layerX: hit ? hit.x : 0,
        layerY: hit ? hit.y : 0,
        moved: false,
      };
      requestRender();
    } else if (pointers.size === 2 && compose.active && (!compose.gesture || compose.gesture.kind !== 'paint')) {
      const [a, b] = [...pointers.values()];
      compose.gesture = {
        kind: 'pinch',
        layer: compose.active,
        distance: Math.hypot(a.x - b.x, a.y - b.y) || 1,
        angle: Math.atan2(b.y - a.y, b.x - a.x),
        scale: compose.active.scale,
        rot: compose.active.rot,
        midX: (a.x + b.x) / 2,
        midY: (a.y + b.y) / 2,
        moved: true,
      };
    }
  });

  canvas.addEventListener('pointermove', (event) => {
    if (!pointers.has(event.pointerId)) return;
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const gesture = compose.gesture;
    if (!gesture) return;

    const point = stagePoint(event);
    if (gesture.kind === 'paint') {
      if (event.pointerId !== gesture.pointerId) return; // ignore extra fingers during a stroke
      paintStroke({ x: gesture.lastX, y: gesture.lastY }, point, gesture.erase);
      gesture.lastX = point.x;
      gesture.lastY = point.y;
      requestRender();
    } else if (gesture.kind === 'move' && gesture.layer) {
      gesture.layer.x = gesture.layerX + (point.x - gesture.startX);
      gesture.layer.y = gesture.layerY + (point.y - gesture.startY);
      gesture.moved = true;
      requestRender();
    } else if (gesture.kind === 'pinch' && pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const distance = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      const angle = Math.atan2(b.y - a.y, b.x - a.x);
      const rect = canvas.getBoundingClientRect();
      const ratio = compose.width / Math.max(1, rect.width);
      const midX = (a.x + b.x) / 2;
      const midY = (a.y + b.y) / 2;

      gesture.layer.scale = clamp(gesture.scale * (distance / gesture.distance), 0.05, 8);
      gesture.layer.rot = gesture.rot + ((angle - gesture.angle) * 180) / Math.PI;
      gesture.layer.x += (midX - gesture.midX) * ratio;
      gesture.layer.y += (midY - gesture.midY) * ratio;
      gesture.midX = midX;
      gesture.midY = midY;
      requestRender();
      updateLayerSheetValues();
    }
  });

  const release = (event) => {
    pointers.delete(event.pointerId);
    if (pointers.size < 2 && compose.gesture && compose.gesture.kind === 'pinch') {
      compose.gesture = null;
    }
    if (pointers.size === 0) compose.gesture = null;
  };
  canvas.addEventListener('pointerup', release);
  canvas.addEventListener('pointercancel', release);
}

/* ------------------------------------------------------------------ layers */

let layerId = 0;

function addLayerFromImage(img, name, source) {
  const fit = Math.min(1.6, (Math.min(compose.width, compose.height) * 0.8) / Math.max(img.width, img.height));
  const layer = {
    id: (layerId += 1),
    img,
    name: name || `layer ${layerId}`,
    srcDataUrl: source || img.src,
    x: compose.width / 2,
    y: compose.height / 2,
    scale: Number.isFinite(fit) && fit > 0 ? fit : 1,
    rot: 0,
    flip: false,
    opacity: 1,
  };
  compose.layers.unshift(layer);
  compose.active = layer;
  updateActiveLabel();
  requestRender();
  return layer;
}

function loadImageElement(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('image decode failed'));
    img.src = src;
  });
}

function maybeAutoSize() {
  if (!compose.autoSized || compose.layers.length !== 1) return;
  compose.autoSized = false;
  const img = compose.layers[0].img;
  compose.width = clamp(Math.round(img.width / 8) * 8, 256, 1536);
  compose.height = clamp(Math.round(img.height / 8) * 8, 256, 1536);
  applyCanvasSize();
}

function applyCanvasSize() {
  canvas.width = compose.width;
  canvas.height = compose.height;
  canvas.style.aspectRatio = `${compose.width} / ${compose.height}`;
  const paint = compose.paintLayer;
  if (paint && compose.layers.includes(paint)) {
    // keep the painted pixels, re-anchor the overlay to the new canvas
    const surface = document.createElement('canvas');
    surface.width = compose.width;
    surface.height = compose.height;
    surface.getContext('2d').drawImage(paint.img, 0, 0);
    paint.img = surface;
    paint.x = compose.width / 2;
    paint.y = compose.height / 2;
  }
  for (const layer of compose.layers) {
    layer.x = clamp(layer.x, 0, compose.width);
    layer.y = clamp(layer.y, 0, compose.height);
  }
  requestRender();
}

async function addFromGallery() {
  const { openGalleryPicker } = await import('./screen-gallery.js');
  const picked = await openGalleryPicker();
  if (!picked) return;
  const overlay = busy('loading image…');
  try {
    const loaded = await fetchImageData({ path: picked.path, url: picked.url, px: 1600 });
    const img = await loadImageElement(loaded.dataUrl);
    addLayerFromImage(img, picked.path ? picked.path.split(/[\\/]/).pop() : 'gallery', loaded.dataUrl);
    maybeAutoSize();
  } catch (error) {
    toast(`could not load: ${error.message}`, 'err');
  } finally {
    overlay.close();
  }
}

async function addFromFile(file) {
  const overlay = busy('loading image…');
  try {
    const source = await fileToImageSource(file, { maxSide: 2048 });
    const img = await loadImageElement(source.dataUrl);
    addLayerFromImage(img, source.name, source.dataUrl);
    maybeAutoSize();
  } catch (error) {
    toast(`could not load: ${error.message}`, 'err');
  } finally {
    overlay.close();
  }
}

function addColorLayer(color) {
  const size = Math.round(Math.min(compose.width, compose.height) * 0.7);
  const offscreen = document.createElement('canvas');
  offscreen.width = size;
  offscreen.height = size;
  const off = offscreen.getContext('2d');
  off.fillStyle = color;
  off.fillRect(0, 0, size, size);
  const dataUrl = offscreen.toDataURL('image/png');
  loadImageElement(dataUrl).then((img) => {
    addLayerFromImage(img, `color ${color}`, dataUrl);
  });
}

function deleteActive() {
  if (!compose.active) return;
  compose.layers = compose.layers.filter((layer) => layer !== compose.active);
  compose.active = compose.layers[0] || null;
  updateActiveLabel();
  requestRender();
}

function moveActive(delta) {
  const index = compose.layers.indexOf(compose.active);
  if (index < 0) return;
  const target = clamp(index + delta, 0, compose.layers.length - 1);
  if (target === index) return;
  compose.layers.splice(index, 1);
  compose.layers.splice(target, 0, compose.active);
  requestRender();
}

/* ------------------------------------------------------------------ export */

function flatten({ background = null } = {}) {
  const offscreen = document.createElement('canvas');
  offscreen.width = compose.width;
  offscreen.height = compose.height;
  const off = offscreen.getContext('2d');
  if (background) {
    off.fillStyle = background;
    off.fillRect(0, 0, compose.width, compose.height);
  }
  for (let index = compose.layers.length - 1; index >= 0; index -= 1) {
    drawLayer(off, compose.layers[index]);
  }
  return offscreen;
}

function exportState() {
  return {
    width: compose.width,
    height: compose.height,
    layers: compose.layers.map((layer) => ({
      name: layer.name,
      x: layer.x,
      y: layer.y,
      scale: layer.scale,
      rot: layer.rot,
      flip: layer.flip,
      opacity: layer.opacity,
    })),
  };
}

async function saveComposite() {
  if (!compose.layers.length) {
    toast('add at least one layer', 'warn');
    return;
  }
  const overlay = busy('saving…');
  try {
    const dataUrl = flatten().toDataURL('image/png');
    const response = await api_.saveImage({ image: dataUrl, state: exportState() });
    toast(`saved to ${response.path}`, 'ok', 3200);
    import('./state.js').then(({ emit }) => emit('gallery-refresh'));
  } catch (error) {
    toast(`save failed: ${error.message}`, 'err');
  } finally {
    overlay.close();
  }
}

function sendComposite(mode) {
  if (!compose.layers.length) {
    toast('add at least one layer', 'warn');
    return;
  }
  const offscreen = flatten({ background: '#ffffff' });
  useSourceAsImage({
    dataUrl: offscreen.toDataURL('image/png'),
    width: compose.width,
    height: compose.height,
    name: 'composition',
  }, { mode });
}

/* ------------------------------------------------------------------ UI */

function updateActiveLabel() {
  if (activeNameLabel) {
    activeNameLabel.textContent = compose.active ? compose.active.name : 'no layer selected';
  }
  if (layerCountLabel) {
    layerCountLabel.textContent = `${compose.layers.length} layer${compose.layers.length === 1 ? '' : 's'}`;
  }
}

function openLayerSheet() {
  const body = el('div');
  const list = el('div');

  const renderList = () => {
    clear(list);
    for (const layer of compose.layers) {
      const row = el('button', {
        class: `layer-thumb ${layer === compose.active ? 'on' : ''}`,
        type: 'button',
        onClick: () => {
          compose.active = layer;
          renderList();
          updateActiveLabel();
          updateLayerSheetValues();
          requestRender();
        },
      }, [
        layer.srcDataUrl ? el('img', { src: layer.srcDataUrl, alt: '' }) : el('div', { class: 'name', text: '■' }),
        el('div', { class: 'name', text: layer.name }),
        el('span', { class: 'small muted', text: layer === compose.active ? 'selected' : '' }),
      ]);
      list.append(row);
    }
    if (!compose.layers.length) list.append(el('div', { class: 'empty-hint', text: 'no layers yet' }));
  };
  renderList();

  const opacityRange = el('input', { type: 'range', min: 5, max: 100, step: 1, value: Math.round((compose.active ? compose.active.opacity : 1) * 100) });
  const scaleRange = el('input', { type: 'range', min: 5, max: 400, step: 1, value: Math.round((compose.active ? compose.active.scale : 1) * 100) });
  const rotRange = el('input', { type: 'range', min: -180, max: 180, step: 1, value: compose.active ? Math.round(compose.active.rot) : 0 });

  opacityRange.addEventListener('input', () => {
    if (!compose.active) return;
    compose.active.opacity = Number(opacityRange.value) / 100;
    requestRender();
  });
  scaleRange.addEventListener('input', () => {
    if (!compose.active) return;
    compose.active.scale = Number(scaleRange.value) / 100;
    requestRender();
  });
  rotRange.addEventListener('input', () => {
    if (!compose.active) return;
    compose.active.rot = Number(rotRange.value);
    requestRender();
  });

  body.append(
    list,
    el('div', { class: 'field' }, [el('label', { text: 'Opacity' }), opacityRange]),
    el('div', { class: 'field' }, [el('label', { text: 'Scale %' }), scaleRange]),
    el('div', { class: 'field' }, [el('label', { text: 'Rotation °' }), rotRange]),
    el('div', { class: 'row tight' }, [
      el('button', { class: 'btn tiny', type: 'button', text: '↑ Up', onClick: () => { moveActive(-1); renderList(); } }),
      el('button', { class: 'btn tiny', type: 'button', text: '↓ Down', onClick: () => { moveActive(1); renderList(); } }),
      el('button', {
        class: 'btn tiny', type: 'button', text: '\u21BB Flip',
        onClick: () => { if (compose.active) { compose.active.flip = !compose.active.flip; requestRender(); } },
      }),
    ]),
    el('div', { class: 'row tight' }, [
      el('button', {
        class: 'btn tiny', type: 'button', text: '\u{1F535} Center',
        onClick: () => { if (compose.active) { compose.active.x = compose.width / 2; compose.active.y = compose.height / 2; requestRender(); } },
      }),
      el('button', {
        class: 'btn tiny', type: 'button', text: '\u29C9 Duplicate',
        onClick: () => {
          if (!compose.active) return;
          if (compose.active.paint) {
            toast('the paint layer cannot be duplicated', 'warn', 1600);
            return;
          }
          const source = compose.active;
          const copy = { ...source, id: (layerId += 1), x: source.x + 24, y: source.y + 24 };
          compose.layers.splice(compose.layers.indexOf(source), 0, copy);
          compose.active = copy;
          renderList();
          updateActiveLabel();
          requestRender();
        },
      }),
      el('button', {
        class: 'btn tiny danger', type: 'button', text: '\u{1F5D1} Delete',
        onClick: () => { deleteActive(); renderList(); updateActiveLabel(); },
      }),
    ]),
  );

  updateLayerSheetValues = () => {
    if (compose.active) {
      opacityRange.value = Math.round(compose.active.opacity * 100);
      scaleRange.value = Math.round(compose.active.scale * 100);
      rotRange.value = Math.round(compose.active.rot);
    }
    renderList();
  };

  openSheet({ title: 'Layers', body, onClose: () => { updateLayerSheetValues = () => {}; } });
}

let updateLayerSheetValues = () => {};

function openCanvasSheet() {
  const widthInput = el('input', { type: 'number', value: compose.width, min: 256, max: 1536, step: 8 });
  const heightInput = el('input', { type: 'number', value: compose.height, min: 256, max: 1536, step: 8 });
  const apply = () => {
    compose.autoSized = false;
    compose.width = clamp(Math.round(Number(widthInput.value) / 8) * 8, 256, 1536);
    compose.height = clamp(Math.round(Number(heightInput.value) / 8) * 8, 256, 1536);
    widthInput.value = compose.width;
    heightInput.value = compose.height;
    applyCanvasSize();
  };
  widthInput.addEventListener('change', apply);
  heightInput.addEventListener('change', apply);

  openSheet({
    title: 'Canvas size',
    body: el('div', {}, [
      el('div', { class: 'chips' }, CANVAS_PRESETS.map(([width, height]) => el('button', {
        class: 'chip', type: 'button', text: `${width}×${height}`,
        onClick: () => { widthInput.value = width; heightInput.value = height; apply(); },
      }))),
      el('div', { class: 'field' }, [el('label', { text: 'Width × Height' }), el('div', { class: 'row tight' }, [widthInput, el('span', { text: '×' }), heightInput])]),
      el('div', { class: 'small muted', text: 'The first image added adopts its own size (up to 1536 px) until you set a size here.' }),
    ]),
    actions: [{ label: 'Done', primary: true, onClick: () => closeSheet() }],
  });
}

function openAddSheet() {
  openSheet({
    title: 'Add layer',
    body: el('div', { class: 'option-list' }, [
      el('button', { class: 'option-item', type: 'button', onClick: async () => { closeSheet(); await addFromGallery(); } }, [
        el('span', { text: '\u{1F5BC} From gallery' }),
      ]),
      el('button', { class: 'option-item', type: 'button', onClick: async () => { closeSheet(); const file = await pickFile(); if (file) addFromFile(file); } }, [
        el('span', { text: '\u{1F4C1} Upload image' }),
      ]),
      el('button', { class: 'option-item', type: 'button', onClick: async () => { closeSheet(); const file = await pickFile({ capture: true }); if (file) addFromFile(file); } }, [
        el('span', { text: '\u{1F4F7} Camera' }),
      ]),
      (() => {
        const colorInput = el('input', { type: 'color', value: '#ffffff', style: { width: '46px', minHeight: '32px' } });
        return el('div', { class: 'option-item' }, [
          el('span', { text: '\u{1F3A8} Color layer' }),
          el('div', { class: 'row tight', style: { flex: '0 0 auto' } }, [
            colorInput,
            el('button', { class: 'btn tiny', type: 'button', text: 'Add', onClick: () => { closeSheet(); addColorLayer(colorInput.value); } }),
          ]),
        ]);
      })(),
    ]),
  });
}

/* ------------------------------------------------------------------ screen */

export function init(container) {
  canvas = el('canvas', { id: 'composeCanvas' });
  ctx = canvas.getContext('2d');
  stage = el('div', { class: 'compose-stage' }, [canvas]);

  stage.addEventListener('dragover', (event) => { event.preventDefault(); });
  stage.addEventListener('drop', (event) => {
    event.preventDefault();
    const file = event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0];
    if (file) addFromFile(file);
  });

  wireGestures();
  layerCountLabel = el('span', { class: 'small muted', text: '0 layers' });
  activeNameLabel = el('span', { class: 'small muted', text: 'no layer selected' });

  const addButton = el('button', { class: 'btn tiny', type: 'button', text: '\uFF0B Add', onClick: openAddSheet });
  const layersButton = el('button', { class: 'btn tiny', type: 'button', text: '\u2630 Layers', onClick: openLayerSheet });
  const canvasButton = el('button', { class: 'btn tiny', type: 'button', text: '\u2B1C Canvas', onClick: openCanvasSheet });
  const flipButton = el('button', {
    class: 'btn tiny', type: 'button', text: '\u21BB',
    onClick: () => { if (compose.active) { compose.active.flip = !compose.active.flip; requestRender(); } },
  });
  const deleteButton = el('button', {
    class: 'btn tiny', type: 'button', text: '\u{1F5D1}',
    onClick: () => { deleteActive(); updateActiveLabel(); },
  });

  // brush / eraser tools - they paint on a full-canvas overlay pinned above the layers
  const sizePreview = el('span', { class: 'small muted', text: `${state.ui.composePaintSize}px`, style: { flex: '0 0 auto' } });
  const sizeInput = el('input', {
    type: 'range', min: 6, max: 120, step: 2, value: state.ui.composePaintSize,
    style: { flex: '1 1 auto', minWidth: '0' },
  });
  sizeInput.addEventListener('input', () => {
    state.ui.composePaintSize = Number(sizeInput.value);
    sizePreview.textContent = `${state.ui.composePaintSize}px`;
    persist();
  });
  const colorInput = el('input', {
    type: 'color', value: state.ui.composePaintColor,
    style: { width: '46px', minHeight: '30px', padding: '0', flex: '0 0 auto' },
  });
  colorInput.addEventListener('input', () => {
    state.ui.composePaintColor = colorInput.value;
    persist();
  });
  const paintSettings = el('div', {
    class: 'row tight', style: { marginTop: '6px' }, hidden: true,
  }, [
    el('span', { class: 'small muted', text: 'Size', style: { flex: '0 0 auto' } }),
    sizeInput,
    sizePreview,
    colorInput,
  ]);

  const toolButtons = new Map();
  const toolRow = el('div', { class: 'chips' });
  const setTool = (tool) => {
    state.ui.composeTool = tool;
    persist();
    toolButtons.forEach((button, key) => button.classList.toggle('on', key === tool));
    paintSettings.hidden = tool === 'move';
    requestRender();
  };
  for (const [tool, label] of [['move', '\u2725 Move'], ['brush', '\u270F\uFE0F Brush'], ['eraser', '\u{1F9FD} Erase']]) {
    const button = el('button', { class: 'chip', type: 'button', text: label, onClick: () => setTool(tool) });
    toolButtons.set(tool, button);
    toolRow.append(button);
  }

  const saveButton = el('button', { class: 'btn tiny', type: 'button', text: '\u{1F4BE} Save', onClick: saveComposite });
  const toImageButton = el('button', { class: 'btn tiny', type: 'button', text: '\u2192 Image', onClick: () => sendComposite('img2img') });
  const toInpaintButton = el('button', { class: 'btn tiny', type: 'button', text: '\u2192 Inpaint', onClick: () => sendComposite('inpaint') });

  container.append(
    el('div', { class: 'scr-body' }, [
      el('div', { class: 'card' }, [
        el('div', { class: 'card-head' }, [el('span', { text: 'Canvas' }), el('span', { class: 'row tight', style: { flex: '0 0 auto', gap: '6px' } }, [layerCountLabel, activeNameLabel])]),
        stage,
        toolRow,
        paintSettings,
        el('div', { class: 'image-tools' }, [addButton, layersButton, canvasButton, flipButton, deleteButton]),
      ]),
      el('div', { class: 'card' }, [
        el('div', { class: 'card-head' }, [el('span', { text: 'Output' })]),
        el('div', { class: 'image-tools' }, [saveButton, toImageButton, toInpaintButton]),
        el('div', { class: 'small muted', style: { marginTop: '6px' }, text: 'Move: drag a layer, pinch to scale/rotate. Brush/eraser draw on the top Paint layer. Save writes into outputs/composition.' }),
      ]),
    ]),
  );

  applyCanvasSize();
  updateActiveLabel();
  setTool(paintTool());
}

export function onShow() {
  requestRender();
}

export function onHide() {
  const active = document.activeElement;
  if (active && active.blur) active.blur();
}
