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

const VIEWER = {
  scale: 1, x: 0, y: 0, rotY: 0, pointers: new Map(), lastTap: 0, tag: '',
  onNavigate: null, canNavigate: null, swipe: null, flipToken: 0, flipAnim: null,
};

export function closeViewer() {
  document.getElementById('viewer').hidden = true;
  const img = document.getElementById('viewerImg');
  img.src = '';
  VIEWER.scale = 1; VIEWER.x = 0; VIEWER.y = 0; VIEWER.rotY = 0;
  VIEWER.pointers.clear();
  VIEWER.tag = '';
  VIEWER.onNavigate = null;
  VIEWER.canNavigate = null;
  VIEWER.swipe = null;
  cancelViewerFlip();
  setViewerLoading(false);
  applyViewerTransform();
}

function applyViewerTransform() {
  const rotate = VIEWER.rotY ? ` rotateY(${VIEWER.rotY.toFixed(2)}deg)` : '';
  document.getElementById('viewerImg').style.transform =
    `translate(${VIEWER.x}px, ${VIEWER.y}px) scale(${VIEWER.scale})${rotate}`;
}

/**
 * Loading placeholder: while a (new) viewer image downloads, the element would keep showing
 * the previous bitmap - hide it and show a spinner instead until the new image arrives.
 */
let viewerLoadingNode = null;

function setViewerLoading(active) {
  if (!viewerLoadingNode) {
    viewerLoadingNode = el('div', { class: 'viewer-loading', hidden: true }, [el('span', { class: 'spinner' })]);
    document.getElementById('viewer').append(viewerLoadingNode);
  }
  viewerLoadingNode.hidden = !active;
  document.getElementById('viewerImg').classList.toggle('is-loading', active);
}

/** Stop a running flip animation (a new gesture always wins). */
function cancelViewerFlip() {
  VIEWER.flipToken += 1;
  if (VIEWER.flipAnim) {
    try { VIEWER.flipAnim.cancel(); } catch (_error) { /* already gone */ }
    VIEWER.flipAnim = null;
  }
}

/** Glide the dragged image back to its resting place (swipe too short / not a flip). */
function springBackViewer() {
  const img = document.getElementById('viewerImg');
  const from = getComputedStyle(img).transform;
  VIEWER.x = 0; VIEWER.rotY = 0;
  applyViewerTransform();
  try {
    img.animate([{ transform: from }, { transform: getComputedStyle(img).transform }], {
      duration: 180,
      easing: 'ease-out',
    });
  } catch (_error) { /* no Web Animations: snap back */ }
}

/**
 * Flip-book transition: the current image turns away, the next one turns in from the other
 * side. `onNavigate` is only called once the outgoing image has left the screen.
 */
function startViewerFlip(direction) {
  const img = document.getElementById('viewerImg');
  const stage = document.getElementById('viewerStage');
  const width = (stage && stage.clientWidth) || 360;
  const sign = direction === 'next' ? -1 : 1;

  if (VIEWER.canNavigate && !VIEWER.canNavigate(direction)) {
    playViewerBoundary(direction);
    return;
  }

  const token = ++VIEWER.flipToken;
  const startX = VIEWER.x;
  const startRot = VIEWER.rotY;
  VIEWER.x = 0; VIEWER.rotY = 0;
  applyViewerTransform(); // base style for the incoming image

  let out = null;
  try {
    out = img.animate([
      { transform: `translateX(${startX}px) rotateY(${startRot}deg)`, opacity: 1 },
      { transform: `translateX(${sign * width * 0.55}px) rotateY(${sign * 20}deg)`, opacity: 0.1 },
    ], { duration: 150, easing: 'ease-in', fill: 'forwards' });
  } catch (_error) { out = null; }
  VIEWER.flipAnim = out;

  const proceed = () => {
    if (token !== VIEWER.flipToken) return;
    if (out) out.cancel();
    VIEWER.flipAnim = null;
    const navigated = VIEWER.onNavigate ? VIEWER.onNavigate(direction) : false;
    if (navigated !== true) {
      if (!out) playViewerBoundary(direction);
      return;
    }
    // the incoming image may still be downloading: the placeholder covers that, and the
    // turn-in flip only starts once it has actually arrived
    const beginEntry = () => {
      if (token !== VIEWER.flipToken) return;
      let incoming = null;
      try {
        incoming = img.animate([
          { transform: `translateX(${-sign * width * 0.45}px) rotateY(${-sign * 16}deg) scale(0.985)`, opacity: 0.15 },
          { transform: 'none', opacity: 1 },
        ], { duration: 230, easing: 'cubic-bezier(.2,.7,.3,1)' });
      } catch (_error) { return; }
      VIEWER.flipAnim = incoming;
      incoming.finished.then(() => {
        if (VIEWER.flipAnim === incoming) {
          incoming.cancel();
          VIEWER.flipAnim = null;
        }
      }).catch(() => { /* canceled by a new gesture */ });
    };
    if (img.complete && img.naturalWidth > 0) beginEntry();
    else img.addEventListener('load', beginEntry, { once: true });
  };

  if (out) out.finished.then(proceed).catch(() => { /* canceled by a new gesture */ });
  else proceed();
}

/** Start/end of the list: bounce against the edge, flash it and show a short hint. */
function playViewerBoundary(direction) {
  const img = document.getElementById('viewerImg');
  const sign = direction === 'next' ? -1 : 1;
  VIEWER.x = 0; VIEWER.rotY = 0;
  applyViewerTransform();
  try {
    img.animate([
      { transform: 'translateX(0px)' },
      { transform: `translateX(${sign * 20}px)` },
      { transform: `translateX(${sign * -9}px)` },
      { transform: 'translateX(0px)' },
    ], { duration: 340, easing: 'ease-out' });
  } catch (_error) { /* no Web Animations */ }
  flashViewerEdge(direction);
  showViewerHint(direction === 'next' ? 'end of list' : 'start of list');
}

let viewerEdgeNode = null;

function flashViewerEdge(direction) {
  if (!viewerEdgeNode) {
    viewerEdgeNode = el('div', { class: 'viewer-edge' });
    document.getElementById('viewer').append(viewerEdgeNode);
  }
  viewerEdgeNode.classList.remove('left', 'right', 'show');
  viewerEdgeNode.classList.add(direction === 'next' ? 'right' : 'left');
  void viewerEdgeNode.offsetWidth; // restart the CSS animation
  viewerEdgeNode.classList.add('show');
}

let viewerHintNode = null;

function showViewerHint(text) {
  if (!viewerHintNode) {
    viewerHintNode = el('div', { class: 'viewer-hint' });
    document.getElementById('viewer').append(viewerHintNode);
  }
  viewerHintNode.textContent = text;
  viewerHintNode.classList.remove('show');
  void viewerHintNode.offsetWidth; // restart the CSS animation
  viewerHintNode.classList.add('show');
}

export function openViewer({ src, title = '', meta = null, actions = [], tag = '', onNavigate = null, canNavigate = null }) {
  document.getElementById('viewerTitle').textContent = title;
  const img = document.getElementById('viewerImg');
  let sameSrc = false;
  try {
    sameSrc = !!src && img.src === new URL(src, location.href).href;
  } catch (_error) {
    sameSrc = false;
  }
  if (sameSrc && img.complete && img.naturalWidth > 0) {
    setViewerLoading(false);
  } else {
    setViewerLoading(true);
    img.src = src;
    // a cached image can be ready synchronously - no placeholder flash for those
    if (img.complete && img.naturalWidth > 0) setViewerLoading(false);
  }

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
      title: action.title || '',
      onClick: () => action.onClick(),
    }));
  }

  VIEWER.scale = 1; VIEWER.x = 0; VIEWER.y = 0; VIEWER.rotY = 0; VIEWER.pointers.clear();
  VIEWER.tag = tag;
  VIEWER.onNavigate = onNavigate;
  VIEWER.canNavigate = canNavigate;
  VIEWER.swipe = null;
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
    // a new touch always wins over a running flip animation
    cancelViewerFlip();
    // synthetic pointer events (tests) have no active pointer to capture - never throw
    try { stage.setPointerCapture(event.pointerId); } catch (_error) { /* not capturable */ }
    VIEWER.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (VIEWER.pointers.size === 1) {
      VIEWER.swipe = { id: event.pointerId, x: event.clientX, y: event.clientY, at: Date.now() };
      const now = Date.now();
      if (now - VIEWER.lastTap < 280) {
        VIEWER.scale = VIEWER.scale > 1.05 ? 1 : 2.4;
        VIEWER.x = 0; VIEWER.y = 0; VIEWER.rotY = 0;
        applyViewerTransform();
      }
      VIEWER.lastTap = now;
    } else {
      // a second finger means pinch-zoom - not a swipe
      VIEWER.swipe = null;
      if (VIEWER.rotY) {
        VIEWER.rotY = 0;
        applyViewerTransform();
      }
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
      } else if (VIEWER.swipe && VIEWER.onNavigate) {
        // follow the finger: the image tracks the drag (slightly damped, with a page turn)
        const dx = current.x - VIEWER.swipe.x;
        const dy = current.y - VIEWER.swipe.y;
        if (Math.abs(dx) >= 6 && Math.abs(dx) > Math.abs(dy) * 0.5) {
          const width = stage.clientWidth || 360;
          VIEWER.x = dx * 0.5;
          VIEWER.rotY = clamp((dx / width) * -14, -14, 14);
          applyViewerTransform();
        }
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

  const release = (event) => {
    const tracked = VIEWER.swipe;
    VIEWER.pointers.delete(event.pointerId);
    if (!tracked || tracked.id !== event.pointerId) return;
    VIEWER.swipe = null;
    const dx = event.clientX - tracked.x;
    const dy = event.clientY - tracked.y;
    const quick = Date.now() - tracked.at < 900;
    const flick = VIEWER.scale <= 1.01 && quick
      && Math.abs(dx) >= 60 && Math.abs(dy) <= Math.abs(dx) * 0.6;
    if (flick && VIEWER.onNavigate) {
      // a swipe must never pair with the next tap into a double-tap zoom
      VIEWER.lastTap = 0;
      startViewerFlip(dx < 0 ? 'next' : 'prev');
      return;
    }
    if (VIEWER.scale <= 1.01 && (Math.abs(VIEWER.x) > 0.5 || Math.abs(VIEWER.rotY) > 0.2)) {
      springBackViewer();
    }
  };
  stage.addEventListener('pointerup', release);
  stage.addEventListener('pointercancel', (event) => {
    VIEWER.swipe = null;
    VIEWER.pointers.delete(event.pointerId);
  });
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
  const img = document.getElementById('viewerImg');
  img.addEventListener('load', () => setViewerLoading(false));
  img.addEventListener('error', () => {
    const wasLoading = !!(viewerLoadingNode && !viewerLoadingNode.hidden);
    setViewerLoading(false);
    if (wasLoading) showViewerHint('could not load the image');
  });
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
