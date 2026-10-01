/* DOM helpers: elements, sheets, toasts, fullscreen viewer, file picking. */

export function switchTab(name) {
  document.body.dataset.tab = name;
  closeViewer();
  document.dispatchEvent(new CustomEvent('mlite-tab', { detail: name }));
}

export function activeTab() {
  return document.body.dataset.tab;
}

export function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value === undefined || value === null) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'html') node.innerHTML = value;
    else if (key === 'style' && typeof value === 'object') Object.assign(node.style, value);
    else if (key === 'dataset' && typeof value === 'object') Object.assign(node.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') {
      // event names are case-sensitive: onClick -> 'click', oninput -> 'input'
      node.addEventListener(key.slice(2).toLowerCase(), value);
    }
    else if (key in node && key !== 'list') node[key] = value;
    else node.setAttribute(key, value);
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

export function clamp(value, low, high) {
  return Math.min(high, Math.max(low, value));
}

export function debounce(fn, ms = 250) {
  let timer = 0;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

export function formatElapsed(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  if (total < 60) return `${total}s`;
  return `${Math.floor(total / 60)}m ${String(total % 60).padStart(2, '0')}s`;
}

export function formatBytes(bytes) {
  const value = Math.max(0, Number(bytes) || 0);
  if (value >= 1048576) return `${(value / 1048576).toFixed(1)} MB`;
  if (value >= 1024) return `${Math.round(value / 1024)} KB`;
  return `${Math.round(value)} B`;
}

/* ------------------------------------------------------------------ toasts */

const toastHost = () => document.getElementById('toasts');
const TOAST_ICONS = { info: '', ok: '✓ ', err: '✕ ', warn: '⚠ ' };

export function toast(message, kind = 'info', ms = 3000) {
  const node = el('div', { class: `toast ${kind}`, text: (TOAST_ICONS[kind] || '') + message });
  toastHost().append(node);
  setTimeout(() => {
    node.style.opacity = '0';
    setTimeout(() => node.remove(), 250);
  }, ms);
  return node;
}

/* ------------------------------------------------------------------ busy overlay */

export function busy(message = 'working…') {
  const text = el('span', { text: message });
  const overlay = el('div', { class: 'busy-overlay' }, [el('span', { class: 'spinner' }), text]);
  document.body.append(overlay);
  return {
    setText: (value) => { text.textContent = value; },
    close: () => overlay.remove(),
  };
}

/* ------------------------------------------------------------------ sheet */

const host = () => document.getElementById('sheetHost');
let sheetController = null;

export function closeSheet() {
  const existing = sheetController;
  sheetController = null;
  host().hidden = true;
  if (existing && existing.onClose) existing.onClose();
}

export function openSheet({ title, body, actions = [], onClose = null, replace = false }) {
  if (sheetController && !replace) closeSheet();

  document.getElementById('sheetTitle').textContent = title || '';
  const bodyNode = clear(document.getElementById('sheetBody'));
  if (body) bodyNode.append(body);

  const actionsNode = document.getElementById('sheetActions');
  clear(actionsNode);
  actionsNode.hidden = !actions.length;
  for (const action of actions) {
    actionsNode.append(el('button', {
      class: `btn ${action.primary ? 'primary' : ''} ${action.danger ? 'danger' : ''}`,
      type: 'button',
      text: action.label,
      onClick: () => action.onClick && action.onClick(),
    }));
  }

  host().hidden = false;
  sheetController = { onClose };
  return sheetController;
}

export function confirmSheet({ title = 'Are you sure?', message = '', confirmLabel = 'Confirm', danger = true }) {
  return new Promise((resolve) => {
    const finish = (value) => { closeSheet(); resolve(value); };
    openSheet({
      title,
      body: el('div', { text: message, class: 'small' }),
      actions: [
        { label: 'Cancel', onClick: () => finish(false) },
        { label: confirmLabel, danger, onClick: () => finish(true) },
      ],
      onClose: () => resolve(false),
    });
  });
}

/* ------------------------------------------------------------------ viewer */

const VIEWER = { scale: 1, x: 0, y: 0, pointers: new Map(), lastTap: 0, tag: '' };

export function closeViewer() {
  document.getElementById('viewer').hidden = true;
  const img = document.getElementById('viewerImg');
  img.src = '';
  VIEWER.scale = 1; VIEWER.x = 0; VIEWER.y = 0;
  VIEWER.pointers.clear();
  VIEWER.tag = '';
  applyViewerTransform();
}

function applyViewerTransform() {
  document.getElementById('viewerImg').style.transform =
    `translate(${VIEWER.x}px, ${VIEWER.y}px) scale(${VIEWER.scale})`;
}

export function openViewer({ src, title = '', meta = null, actions = [], tag = '' }) {
  document.getElementById('viewerTitle').textContent = title;
  const img = document.getElementById('viewerImg');
  img.src = src;

  const stage = document.getElementById('viewerStage');
  const oldMeta = stage.parentElement.querySelector('.viewer-meta');
  if (oldMeta) oldMeta.remove();
  if (meta) stage.parentElement.insertBefore(meta, document.getElementById('viewerBar'));

  const bar = clear(document.getElementById('viewerBar'));
  for (const action of actions) {
    bar.append(el('button', {
      class: `btn tiny ${action.accent ? 'accent' : ''} ${action.danger ? 'danger' : ''}`,
      type: 'button',
      text: action.label,
      onClick: () => action.onClick(),
    }));
  }

  VIEWER.scale = 1; VIEWER.x = 0; VIEWER.y = 0; VIEWER.pointers.clear();
  VIEWER.tag = tag;
  applyViewerTransform();
  document.getElementById('viewer').hidden = false;
}

/**
 * Refresh a viewer that is still open and was opened with this tag (live previews keep
 * repainting while the job runs). The zoom/pan state is deliberately left untouched.
 */
export function updateViewer(tag, { src = null, title = null } = {}) {
  const viewer = document.getElementById('viewer');
  if (!viewer || viewer.hidden || VIEWER.tag !== tag) return;
  if (src) document.getElementById('viewerImg').src = src;
  if (title !== null) document.getElementById('viewerTitle').textContent = title;
}

function viewerGestureInit() {
  const stage = document.getElementById('viewerStage');

  stage.addEventListener('pointerdown', (event) => {
    stage.setPointerCapture(event.pointerId);
    VIEWER.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (VIEWER.pointers.size === 1) {
      const now = Date.now();
      if (now - VIEWER.lastTap < 280) {
        VIEWER.scale = VIEWER.scale > 1.05 ? 1 : 2.4;
        VIEWER.x = 0; VIEWER.y = 0;
        applyViewerTransform();
      }
      VIEWER.lastTap = now;
    }
  });

  stage.addEventListener('pointermove', (event) => {
    const previous = VIEWER.pointers.get(event.pointerId);
    if (!previous) return;
    const current = { x: event.clientX, y: event.clientY };

    if (VIEWER.pointers.size === 1) {
      if (VIEWER.scale > 1.01) {
        VIEWER.x += current.x - previous.x;
        VIEWER.y += current.y - previous.y;
        applyViewerTransform();
      }
    } else if (VIEWER.pointers.size === 2) {
      const other = [...VIEWER.pointers.entries()].find(([id]) => id !== event.pointerId);
      if (other) {
        const [, otherPoint] = other;
        const before = Math.hypot(previous.x - otherPoint.x, previous.y - otherPoint.y) || 1;
        const after = Math.hypot(current.x - otherPoint.x, current.y - otherPoint.y) || 1;
        const factor = after / before;
        VIEWER.scale = clamp(VIEWER.scale * factor, 1, 8);
        applyViewerTransform();
      }
    }
    VIEWER.pointers.set(event.pointerId, current);
  });

  const release = (event) => VIEWER.pointers.delete(event.pointerId);
  stage.addEventListener('pointerup', release);
  stage.addEventListener('pointercancel', release);
  stage.addEventListener('wheel', (event) => {
    event.preventDefault();
    VIEWER.scale = clamp(VIEWER.scale * (event.deltaY < 0 ? 1.1 : 0.9), 1, 8);
    applyViewerTransform();
  }, { passive: false });
}

/* ------------------------------------------------------------------ files */

export function pickFile({ capture = false } = {}) {
  return new Promise((resolve) => {
    const input = el('input', { type: 'file', accept: 'image/*' });
    if (capture) input.setAttribute('capture', 'environment');
    input.style.display = 'none';
    document.body.append(input);
    input.addEventListener('change', () => {
      resolve(input.files && input.files[0] ? input.files[0] : null);
      input.remove();
    });
    input.click();
  });
}

export function fileToImageSource(file, { maxSide = 2048, quality = 0.9 } = {}) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error || new Error('file read failed'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('image decode failed'));
      img.onload = () => {
        const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
        const width = Math.max(1, Math.round(img.naturalWidth * scale));
        const height = Math.max(1, Math.round(img.naturalHeight * scale));
        if (scale === 1) {
          resolve({ dataUrl: reader.result, width, height, name: file.name || 'image' });
          return;
        }
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        canvas.getContext('2d').drawImage(img, 0, 0, width, height);
        resolve({
          dataUrl: canvas.toDataURL('image/jpeg', quality),
          width,
          height,
          name: file.name || 'image',
        });
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

export function initViewer() {
  viewerGestureInit();
  document.getElementById('viewerClose').addEventListener('click', closeViewer);
}

/* Sheet chrome (✕ button + backdrop) and viewer chrome are static markup, wired once. */
(function wireStaticChrome() {
  const sheetClose = document.getElementById('sheetClose');
  const sheetBackdrop = document.getElementById('sheetBackdrop');
  if (sheetClose) sheetClose.addEventListener('click', () => closeSheet());
  if (sheetBackdrop) sheetBackdrop.addEventListener('click', () => closeSheet());
  const viewer = document.getElementById('viewer');
  if (viewer) viewer.addEventListener('click', (event) => { if (event.target === viewer) closeViewer(); });
})();
