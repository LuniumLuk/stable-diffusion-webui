/* Shared app state + tiny pub/sub bus. */

import { api_ } from './api.js';
import { resolveInputSize, round8 } from './resize-plan.js';

const LS_KEY = 'mlite.state.v1';

export const state = {
  boot: null,
  params: {
    sampler: '',
    scheduler: 'Automatic',
    steps: 20,
    cfg: 7,
    width: 512,
    height: 512,
    batch: 1,
    seed: -1,
    seedLock: false,
    denoise: 0.75,
    maskBlur: 4,
    fill: 1, // masked content: 0 fill, 1 original, 2 latent noise, 3 latent nothing
    inpaintFullRes: false, // false = whole picture, true = only masked
    inpaintPadding: 32,
    invertMask: false, // mask mode: invert the painted mask
    imageSizeMode: 'auto', // auto = match input image, scale = input x sizeScale, custom = use width/height
    sizeScale: 1, // factor used by imageSizeMode 'scale' (img2img: output = input x factor)
    fitMode: 0, // 0 stretch, 1 crop-and-resize, 2 resize-and-fill
    inputResize: 'off', // off | scale | custom - pre-resize the init image before img2img/inpaint
    inputResizeScale: 1, // factor used by inputResize 'scale'
    inputResizeW: 0, // custom target; 0 = follow the source (seeded when the mode is chosen)
    inputResizeH: 0,
    inputResizeFit: 'fill', // fill = cover + center crop, stretch = ignore aspect
    hrEnabled: false, // txt2img: run the hires. fix second pass
    hrUpscaler: '', // '', latent mode name or traditional upscaler name
    hrScale: 2, // hires upscale factor (x base size)
    hrSteps: 0, // hires steps; 0 = same as the base pass
    hrDenoise: 0.7, // hires denoising strength
    hrStageConfig: '', // multi-stage hires text (one 'scale: .., steps: ..' entry per line)
    poseInpaintEnabled: false, // txt2img: detect face/hand/foot points and inpaint them
    poseInpaintParts: ['Face', 'Hands', 'Feet'], // selected point groups
    poseInpaintRadius: 40, // point mask radius, same default as the desktop accordion
    poseInpaintDenoise: 0.4,
    poseInpaintSteps: 0, // 0 = use the base generation steps
    poseInpaintSaveIntermediate: false, // keep the image before the pose inpaint pass
  },
  prompt: {
    text: '',
    textNegative: '',
    image: '',
    imageNegative: '',
    qwen: '',
    qwenNegative: '',
    krea2: '',
    krea2Negative: '',
  },
  image: {
    source: null, // { dataUrl, width, height, name, meta } - meta carries the prompt/params
    mode: 'img2img', // img2img | inpaint
  },
  // transient hand-off from the gallery to the Text screen (never persisted)
  textMeta: null,
  // img2img and inpaint keep their own parameter sets (like the desktop tabs), so
  // values set for one task never leak into the other. Each set is seeded from
  // `params` the first time that mode is used; null until then.
  imageParams: { img2img: null, inpaint: null },
  // Qwen-Image-2.1 keeps its own set too (it has no sampler / hires and uses 32px sizes)
  qwenParams: null,
  // Krea 2 keeps its own as well (turbo: 8 steps / CFG 1.0 / 32px sizes)
  krea2Params: null,
  // recent parameter sets per scope (newest first, max 10) - browsed with the ▲/▼ buttons
  // on the folded summary line; keyed like the stores: text / img2img / inpaint / qwen / krea2
  paramHistory: { text: [], img2img: [], inpaint: [], qwen: [], krea2: [] },
  ui: {
    brush: 28,
    samCandidate: 0,
    galleryView: 'all',
    galleryQuery: '',
    galleryAlbum: 0,
    galleryPromptVariant: 'source', // 'source' | 'compiled' - remembered
    lastTab: 'text',
    peditMode: 'chips',
    suggestionsOpen: false,
    maskColor: '#00e0ff', // display colour of the painted / SAM mask
    maskOutlineColor: '#ffffff', // blinking border drawn around the mask
    maskBlink: true,
    composeTool: 'move', // active Compose tool: move / brush / eraser
    composePaintColor: '#ff3366', // brush colour (desktop Composer default)
    composePaintSize: 40, // brush / eraser size in CSS px under the finger
  },
  results: [], // { url, thumb, seed, screen, width, height, infotext }
  mruKeywords: [],
};

export const bus = new EventTarget();

export function on(name, handler) {
  bus.addEventListener(name, handler);
  return () => bus.removeEventListener(name, handler);
}

export function emit(name, detail = null) {
  bus.dispatchEvent(new CustomEvent(name, { detail }));
}

const PERSIST_KEYS = ['params', 'prompt', 'ui', 'mruKeywords', 'imageParams', 'qwenParams', 'krea2Params', 'paramHistory'];

export function loadPersisted() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw);
    for (const key of PERSIST_KEYS) {
      if (saved[key] === undefined || saved[key] === null) continue;
      if (Array.isArray(saved[key]) && !Array.isArray(state[key])) continue;
      if (typeof saved[key] === 'object' && !Array.isArray(saved[key])) {
        Object.assign(state[key], saved[key]);
      } else {
        state[key] = saved[key];
      }
    }
  } catch (_error) { /* ignore corrupt state */ }
}

let saveTimer = 0;

export function flushPersist() {
  clearTimeout(saveTimer);
  saveTimer = 0;
  try {
    const payload = {};
    for (const key of PERSIST_KEYS) payload[key] = state[key];
    localStorage.setItem(LS_KEY, JSON.stringify(payload));
  } catch (_error) { /* storage full/blocked - state stays in memory */ }
}

export function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushPersist, 250);
}

// iOS can kill the page from a swipe; make sure the newest state (e.g. the active tab)
// is on disk before the page goes away.
window.addEventListener('pagehide', flushPersist);
window.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') flushPersist();
});

export function setParam(name, value, store = state.params) {
  store[name] = value;
  const scope = storeKey(store);
  if (scope) historyCursors.delete(scope); // editing a value ends any history browsing
  persist();
  emit('params', store);
}

/**
 * Parameter set of an image mode ('img2img' / 'inpaint'). The two tasks are independent
 * (like the desktop tabs) - a set is seeded from the shared `state.params` on first use,
 * so upgrades and first switches keep the values the user already sees.
 */
export function imageParams(mode = state.image.mode) {
  const key = mode === 'inpaint' ? 'inpaint' : 'img2img';
  let store = state.imageParams[key];
  if (!store) {
    store = { ...state.params };
    state.imageParams[key] = store;
  } else {
    // a set persisted by an older build may lack freshly added keys - fill from the shared set
    for (const name of Object.keys(state.params)) {
      if (store[name] === undefined) store[name] = state.params[name];
    }
  }
  return store;
}

/** Qwen-Image-2.1 parameter set (kept apart from the SDXL stores; no sampler / hires). */
export function qwenParams() {
  if (!state.qwenParams) {
    state.qwenParams = { steps: 20, cfg: 6, width: 1024, height: 1024, batch: 1, seed: -1, seedLock: false };
  }
  return state.qwenParams;
}

/** Krea 2 (turbo) parameter set - like Qwen's, with the turbo defaults (8 steps, CFG 1.0). */
export function krea2Params() {
  if (!state.krea2Params) {
    state.krea2Params = { steps: 8, cfg: 1, width: 1024, height: 1024, batch: 1, seed: -1, seedLock: false };
  }
  return state.krea2Params;
}

/** Apply a seed to the shared set and to every image mode set already in use ("Use seed"). */
export function setSeedEverywhere(seed) {
  setParam('seed', seed);
  for (const store of Object.values(state.imageParams)) {
    if (store) setParam('seed', seed, store);
  }
}

/**
 * Resolved img2img output size - the single source of truth for the params sheet preview and the
 * generation payload. It follows the *effective* input (after the optional input pre-resize):
 * 'auto' matches it, 'scale' multiplies it by `sizeScale`, 'custom' uses the W/H fields.
 * Dimensions snap to multiples of 8 and stay within 64-2048.
 */
export function resolveOutputSize(source = state.image.source, params = imageParams()) {
  const input = resolveInputSize(source, params);
  if (input && params.imageSizeMode === 'scale') {
    const factor = Math.min(4, Math.max(0.1, Number(params.sizeScale) || 1));
    return { width: round8(input.width * factor), height: round8(input.height * factor) };
  }
  if (input && params.imageSizeMode === 'auto') {
    return { width: input.width, height: input.height };
  }
  return { width: round8(params.width), height: round8(params.height) };
}

export function addResult(result) {
  state.results = [result, ...state.results].slice(0, 30);
  emit('results', state.results);
}

export function pushMruKeywords(promptText) {
  const tokens = String(promptText || '')
    .split(',')
    .map((token) => token.trim())
    .filter((token) => token && token.length < 60 && !token.startsWith('#'));
  if (!tokens.length) return;
  const merged = [...tokens.reverse(), ...state.mruKeywords];
  const seen = new Set();
  state.mruKeywords = merged.filter((token) => {
    const key = token.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 40);
  persist();
  emit('mru', state.mruKeywords);
}

export async function bootstrap() {
  loadPersisted();
  const boot = await api_.bootstrap();
  state.boot = boot;

  // First run: adopt the desktop UI's current values.
  const defaults = boot.defaults || {};
  const firstRun = !localStorage.getItem(LS_KEY);
  if (firstRun) {
    state.params.sampler = defaults.sampler || state.params.sampler;
    state.params.scheduler = defaults.scheduler || state.params.scheduler;
    state.params.steps = defaults.steps ?? state.params.steps;
    state.params.cfg = defaults.cfg ?? state.params.cfg;
    state.params.width = defaults.width ?? state.params.width;
    state.params.height = defaults.height ?? state.params.height;
    state.params.batch = defaults.batch ?? state.params.batch;
    state.params.denoise = defaults.denoise ?? state.params.denoise;
    state.params.maskBlur = defaults.mask_blur ?? state.params.maskBlur;
    state.params.fill = defaults.fill ?? state.params.fill;
    state.params.inpaintFullRes = defaults.inpaint_full_res ?? state.params.inpaintFullRes;
    state.params.inpaintPadding = defaults.inpaint_full_res_padding ?? state.params.inpaintPadding;
    state.params.invertMask = defaults.invert_mask ?? state.params.invertMask;
    state.params.hrEnabled = defaults.hr_enabled ?? state.params.hrEnabled;
    state.params.hrUpscaler = defaults.hr_upscaler || state.params.hrUpscaler;
    state.params.hrScale = defaults.hr_scale ?? state.params.hrScale;
    state.params.hrSteps = defaults.hr_steps ?? state.params.hrSteps;
    state.params.hrDenoise = defaults.hr_denoise ?? state.params.hrDenoise;
  }
  if (!state.params.sampler) state.params.sampler = defaults.sampler || 'Euler a';
  if (!state.params.hrUpscaler) state.params.hrUpscaler = defaults.hr_upscaler || 'Latent';
  return boot;
}

export function summarizeParams(kind = 'text') {
  const p = state.params;
  if (kind === 'image') {
    return [
      ['denoise', `${Number(p.denoise).toFixed(2)}`],
      ['steps', p.steps],
      ['CFG', p.cfg],
      ['sampler', p.sampler],
      ['batch', p.batch],
    ];
  }
  return [
    [`${p.width}×${p.height}`, ''],
    ['steps', p.steps],
    ['CFG', p.cfg],
    ['sampler', p.sampler],
    ['batch', p.batch],
  ];
}

/* ---------------------------------------------------------------- parameter history */

const HISTORY_LIMIT = 10;
const historyCursors = new Map(); // scope -> { index, draft }: transient browsing position

/** History scope of a parameter set (used by the ▲/▼ controls on the summary line). */
export function storeKey(store) {
  if (store === state.params) return 'text';
  if (store === state.qwenParams) return 'qwen';
  if (store === state.krea2Params) return 'krea2';
  if (store === state.imageParams.img2img) return 'img2img';
  if (store === state.imageParams.inpaint) return 'inpaint';
  return null;
}

/** Remember a parameter set when a generation starts (newest first, deduped, max 10). */
export function pushParamHistory(key, store) {
  if (!key || !store) return;
  const snapshot = JSON.parse(JSON.stringify(store));
  const list = state.paramHistory[key] || (state.paramHistory[key] = []);
  if (list.length && JSON.stringify(list[0]) === JSON.stringify(snapshot)) return;
  list.unshift(snapshot);
  if (list.length > HISTORY_LIMIT) list.length = HISTORY_LIMIT;
  historyCursors.delete(key);
  persist();
}

/**
 * Browse the stored parameter sets. `direction` -1 = older (▲), 1 = newer (▼).
 * The first ▲ stashes the live set as a draft so ▼ can always return to it.
 * Returns null when there is nothing to step through, else { applied, position, total }.
 */
export function stepParamHistory(key, store, direction) {
  const list = state.paramHistory[key] || [];
  const cursor = historyCursors.get(key);
  if (direction < 0) {
    if (!list.length) return null;
    if (cursor && cursor.index >= list.length - 1) {
      return { applied: false, position: list.length, total: list.length };
    }
    const draft = cursor ? cursor.draft : JSON.parse(JSON.stringify(store));
    const index = cursor ? cursor.index + 1 : 0;
    historyCursors.set(key, { index, draft });
    applyHistorySnapshot(store, list[index]);
    return { applied: true, position: index + 1, total: list.length };
  }
  if (!cursor) return null;
  if (cursor.index <= 0) {
    historyCursors.delete(key);
    applyHistorySnapshot(store, cursor.draft);
    return { applied: true, position: 0, total: list.length };
  }
  const index = cursor.index - 1;
  historyCursors.set(key, { index, draft: cursor.draft });
  applyHistorySnapshot(store, list[index]);
  return { applied: true, position: index + 1, total: list.length };
}

function applyHistorySnapshot(store, snapshot) {
  for (const name of Object.keys(snapshot)) store[name] = snapshot[name];
  persist();
  emit('params', store);
}
