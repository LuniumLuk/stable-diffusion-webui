/* Video screen: short anime clips (AnimateDiff / CogVideoX / SVD / LTX-Video) via /mlite/api/video. */

import { api_, blobToDataUrl, fileUrl, imageSize, randomTaskId } from './api.js';
import { isJobActive, runJob } from './job.js';
import { persist, videoParams } from './state.js';
import { el, toast } from './ui.js';

const ENGINES = [
  { id: 'animatediff', label: 'AnimateDiff', note: 'fast anime loops' },
  { id: 'cogvideox', label: 'CogVideoX', note: '480p · slow' },
  { id: 'svd', label: 'SVD', note: 'animate a still' },
  { id: 'ltx', label: 'LTX', note: 'still + prompt' },
];

const DEFAULTS = {
  animatediff: { width: 512, height: 512, frames: 16, fps: 8, steps: 4, guidance: 1.5 },
  cogvideox: { width: 720, height: 480, frames: 49, fps: 8, steps: 50, guidance: 6.0 },
  svd: { width: 1024, height: 576, frames: 25, fps: 7, steps: 25, guidance: 1.0 },
  ltx: { width: 512, height: 768, frames: 49, fps: 24, steps: 50, guidance: 3.0 },
};

let engineButtons = {};
let promptBox;
let negativeBox;
let svdBlock;
let refineBlock;
let initLabel;
let initInput;
let initPreview;
let initData = '';
let refineInput;
let sizeRow;
let widthInput;
let heightInput;
let framesInput;
let fpsInput;
let stepsInput;
let cfgInput;
let seedInput;
let seedLock;
let pingpong;
let statusLine;
let resultCard;
let resultImg;
let resultLinks;
let resultInfo;
let statusInfo = null;

const params = () => videoParams();

/* ------------------------------------------------------------------ helpers */

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('image decode failed'));
    img.src = src;
  });
}

/** Read a picked file into a data URL, downscaling big photos (mobile uplink). */
async function prepareImage(file) {
  const original = await blobToDataUrl(file);
  const dims = await imageSize(original);
  const maxSide = Math.max(dims.width, dims.height);
  if (maxSide <= 1600) return original;
  const scale = 1600 / maxSide;
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(dims.width * scale));
  canvas.height = Math.max(1, Math.round(dims.height * scale));
  canvas.getContext('2d').drawImage(await loadImage(original), 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', 0.92);
}

function numberInput(key, { min = 1, max = 999, step = 1, label } = {}) {
  const input = el('input', {
    type: 'number', inputmode: 'numeric', min, max, step,
    value: params()[key],
    onInput: () => {
      params()[key] = Number(input.value);
      persist();
    },
  });
  return el('div', { class: 'field' }, [el('label', { text: label }), input]);
}

function sizeChips(values) {
  sizeRow.replaceChildren();
  for (const [w, h] of values) {
    const on = Number(widthInput.value) === w && Number(heightInput.value) === h;
    sizeRow.append(el('button', {
      class: `btn tiny ${on ? 'on' : ''}`,
      type: 'button',
      text: `${w}\u00D7${h}`,
      onClick: () => {
        widthInput.value = w;
        heightInput.value = h;
        params().width = w;
        params().height = h;
        persist();
        sizeChips(values);
      },
    }));
  }
}

function engineSizePresets(engineId) {
  if (engineId === 'cogvideox') return [[720, 480], [480, 720], [384, 576]];
  if (engineId === 'svd') return [[1024, 576], [576, 1024]];
  if (engineId === 'ltx') return [[512, 768], [768, 512], [512, 512], [384, 576]];
  return [[512, 512], [512, 768], [768, 512], [384, 384]];
}

function selectEngine(engineId, { reset = true } = {}) {
  const store = params();
  store.engine = engineId;
  if (reset) {
    const defaults = DEFAULTS[engineId];
    Object.assign(store, defaults);
    widthInput.value = defaults.width;
    heightInput.value = defaults.height;
    framesInput.value = defaults.frames;
    fpsInput.value = defaults.fps;
    stepsInput.value = defaults.steps;
    cfgInput.value = defaults.guidance;
  }
  persist();
  for (const [id, button] of Object.entries(engineButtons)) {
    button.classList.toggle('on', id === engineId);
  }
  svdBlock.hidden = !['svd', 'ltx'].includes(engineId);
  initLabel.textContent = engineId === 'ltx'
    ? 'Init image (optional — LTX animates this still)'
    : 'Init image (SVD animates this picture)';
  refineBlock.hidden = engineId !== 'svd';
  sizeChips(engineSizePresets(engineId));
  if (statusInfo) renderStatus(statusInfo);
}

function renderStatus(info) {
  statusInfo = info;
  const missing = (info.engines || []).filter((entry) => !entry.installed);
  const lines = [];
  if (missing.length) {
    for (const entry of missing) {
      lines.push(`${entry.title}: ${entry.hint || 'files missing'}`);
    }
  }
  const vram = info.vram || {};
  if (vram.free_mb) {
    lines.push(`VRAM ${Math.round(vram.free_mb / 102.4) / 10} / ${Math.round(vram.total_mb / 102.4) / 10} GB free`);
  }
  if (info.loaded) lines.push(`loaded: ${info.loaded}`);
  statusLine.textContent = lines.join(' · ') || 'all engines ready';
  statusLine.className = `small ${missing.length ? 'muted' : 'muted'}`;
}

async function refreshStatus() {
  try {
    renderStatus(await api_.videoStatus());
  } catch (error) {
    statusLine.textContent = `status unavailable: ${error.message}`;
  }
}

function renderResult(response) {
  const gif = response.gif ? fileUrl(response.gif) : '';
  const mp4 = response.mp4 ? fileUrl(response.mp4) : '';
  resultCard.hidden = false;
  resultImg.src = gif;
  resultLinks.replaceChildren(
    gif ? el('a', { class: 'btn tiny', href: gif, download: '', text: 'GIF' }) : null,
    mp4 ? el('a', { class: 'btn tiny', href: mp4, download: '', text: 'MP4' }) : null,
  );
  const info = response.info || {};
  resultInfo.textContent = `${info.frames || 0} frames · ${info.width}\u00D7${info.height} · ${info.fps} fps · seed ${info.seed} · ${info.seconds}s`;
}

async function generate() {
  if (isJobActive()) {
    toast('another job is running', 'warn');
    return;
  }
  const store = params();
  if (store.engine === 'svd' && !initData) {
    toast('choose an init image first', 'warn');
    return;
  }
  if (store.engine !== 'svd' && !promptBox.value.trim()) {
    toast('a prompt is required', 'warn');
    return;
  }
  const payload = {
    task_id: randomTaskId(),
    engine: store.engine,
    prompt: promptBox.value.trim(),
    negative_prompt: negativeBox.value.trim(),
    width: Number(widthInput.value),
    height: Number(heightInput.value),
    frames: Number(framesInput.value),
    fps: Number(fpsInput.value),
    steps: Number(stepsInput.value),
    guidance: Number(cfgInput.value),
    seed: seedLock.checked ? Number(seedInput.value) : -1,
    base: (statusInfo && statusInfo.bases && statusInfo.bases[0] && statusInfo.bases[0].path) || '',
    lightning: store.lightning || 'auto',
    offload: store.offload || 'auto',
    init_image: initData,
    refine: Number(store.refine ?? 0.25),
    pingpong: !!store.pingpong,
  };

  const response = await runJob('video', payload, { label: 'video' });
  if (response && response.ok !== false) renderResult(response);
  refreshStatus();
}

/* -------------------------------------------------------------------- screen */

export function init(container) {
  const store = params();
  promptBox = el('textarea', {
    class: 'prompt-input', rows: 4, spellcheck: false,
    placeholder: 'anime girl on a rooftop, wind in her hair, night city\u2026',
    value: store.prompt || '',
    onInput: () => { store.prompt = promptBox.value; persist(); },
  });
  negativeBox = el('textarea', {
    class: 'prompt-input', rows: 2, spellcheck: false,
    placeholder: 'blurry, extra limbs, watermark\u2026',
    value: store.negative || '',
    onInput: () => { store.negative = negativeBox.value; persist(); },
  });

  const segmented = el('div', { class: 'segmented' });
  for (const engine of ENGINES) {
    const button = el('button', {
      type: 'button',
      class: engine.id === store.engine ? 'on' : '',
      text: engine.label,
      title: engine.note,
      onClick: () => selectEngine(engine.id),
    });
    engineButtons[engine.id] = button;
    segmented.append(button);
  }

  statusLine = el('div', { class: 'small muted', text: 'checking engines\u2026' });

  widthInput = el('input', { type: 'number', min: 256, max: 1024, step: 8, value: store.width, onInput: () => { store.width = Number(widthInput.value); persist(); } });
  heightInput = el('input', { type: 'number', min: 256, max: 1024, step: 8, value: store.height, onInput: () => { store.height = Number(heightInput.value); persist(); } });
  framesInput = numberInput('frames', { min: 9, max: 49, label: 'Frames' });
  fpsInput = numberInput('fps', { min: 1, max: 30, label: 'FPS (playback)' });
  stepsInput = numberInput('steps', { min: 1, max: 60, label: 'Steps' });
  cfgInput = numberInput('guidance', { min: 1, max: 20, step: 0.5, label: 'CFG' });
  seedInput = numberInput('seed', { min: -1, max: 2147483647, label: 'Seed' });
  seedLock = el('input', {
    type: 'checkbox', checked: !!store.seedLock,
    onChange: () => { store.seedLock = seedLock.checked; persist(); },
  });

  sizeRow = el('div', { class: 'row tight video-sizes' });

  initInput = el('input', {
    type: 'file', accept: 'image/*',
    onChange: async () => {
      const file = initInput.files && initInput.files[0];
      if (!file) return;
      try {
        initData = await prepareImage(file);
        initPreview.src = initData;
        initPreview.hidden = false;
      } catch (error) {
        toast(`could not load the image: ${error.message}`, 'err');
      }
    },
  });
  initPreview = el('img', { class: 'video-init', alt: '', hidden: true });
  refineInput = el('input', {
    type: 'range', min: 0, max: 0.8, step: 0.05, value: store.refine ?? 0.25,
    onInput: () => { store.refine = Number(refineInput.value); refineValue.textContent = Number(refineInput.value).toFixed(2); persist(); },
  });
  const refineValue = el('span', { class: 'small muted', text: Number(store.refine ?? 0.25).toFixed(2) });
  initLabel = el('label', { text: 'Init image (SVD animates this picture)' });
  refineBlock = el('div', { class: 'field', hidden: store.engine !== 'svd' }, [
    el('label', { text: 'Prompt guidance (img2img refine before animating)' }),
    el('div', { class: 'row' }, [refineInput, refineValue]),
  ]);
  svdBlock = el('div', { class: 'field', hidden: !['svd', 'ltx'].includes(store.engine) }, [
    initLabel,
    initPreview,
    initInput,
  ]);

  pingpong = el('input', {
    type: 'checkbox', checked: !!store.pingpong,
    onChange: () => { store.pingpong = pingpong.checked; persist(); },
  });

  resultImg = el('img', { alt: 'generated clip' });
  resultLinks = el('div', { class: 'row tight' });
  resultInfo = el('div', { class: 'small muted' });
  resultCard = el('div', { class: 'card video-result', hidden: true }, [resultImg, resultLinks, resultInfo]);

  const generateButton = el('button', {
    class: 'btn primary wide', type: 'button', text: 'Generate clip', onClick: generate,
  });
  const unloadButton = el('button', {
    class: 'btn tiny', type: 'button', text: 'Unload video models',
    onClick: async () => {
      try {
        await api_.videoUnload();
        toast('video models unloaded', 'ok');
        refreshStatus();
      } catch (error) {
        toast(error.message, 'err');
      }
    },
  });

  container.append(
    el('div', { class: 'scr-body' }, [
      el('div', { class: 'card' }, [
        segmented,
        statusLine,
      ]),
      el('div', { class: 'card' }, [
        el('div', { class: 'field' }, [el('label', { text: 'Prompt' }), promptBox]),
        el('div', { class: 'field' }, [el('label', { text: 'Negative prompt (CFG > 1)' }), negativeBox]),
        el('div', { class: 'field' }, [el('label', { text: 'Size' }), sizeRow]),
        el('div', { class: 'row' }, [el('div', { class: 'field' }, [el('label', { text: 'Width' }), widthInput]), el('div', { class: 'field' }, [el('label', { text: 'Height' }), heightInput])]),
        el('div', { class: 'row' }, [framesInput, fpsInput, stepsInput]),
        el('div', { class: 'row' }, [cfgInput, seedInput, el('div', { class: 'field' }, [el('label', { text: 'Lock seed' }), seedLock])]),
        svdBlock,
        refineBlock,
        el('div', { class: 'field' }, [el('label', { text: 'Ping-pong loop (palindrome GIF)' }), pingpong]),
        el('p', { class: 'small muted', text: 'Local generation, no safety checker and no prompt filter. Starting a clip unloads the SD checkpoint and any sd-server sidecar.' }),
      ]),
      resultCard,
    ]),
    el('div', { class: 'scr-actions' }, [unloadButton, generateButton]),
  );

  selectEngine(store.engine, { reset: false });
  sizeChips(engineSizePresets(store.engine));
  if (store.prompt) promptBox.value = store.prompt;
  if (store.negative) negativeBox.value = store.negative;
  refreshStatus();
}

export function onShow() {
  refreshStatus();
}

export function onHide() {}
