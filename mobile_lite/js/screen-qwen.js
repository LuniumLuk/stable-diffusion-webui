/* Qwen screen: Qwen-Image-2.1 (text to image + reference-image edits) via the sd-server. */

import { api_, blobToDataUrl, fetchImageData, imageSize, randomTaskId } from './api.js';
import { openCollectionPicker } from './collection.js';
import { isJobActive, runJob } from './job.js';
import { historyControls } from './history.js';
import { openParamsSheet } from './params.js';
import { createPromptEditor } from './prompt.js';
import { on, qwenParams, state } from './state.js';
import { busy, closeViewer, el, openViewer, switchTab, toast } from './ui.js';
import { openResultViewer } from './send.js';

const REF_LIMIT = 10;
const REF_MAX_SIDE = 1600; // client-side downscale: mobile uplink is the bottleneck

let prompt;
let summary;
let summaryMain;
let strip;
let generateButton;
let refsGrid;
let refsTitle;
let statusChip;

// references are transient on purpose - data URLs are way too big for localStorage
const refs = [];
let statusTimer = 0;

/* ---------------------------------------------------------------- references */

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('image decode failed'));
    img.src = src;
  });
}

/** Read a picked file into a reference entry; big files are downscaled (bandwidth). */
async function prepareRef(file) {
  const name = file.name || 'reference';
  const original = await blobToDataUrl(file);
  const dims = await imageSize(original);
  const maxSide = Math.max(dims.width, dims.height);
  const smallPng = /png/i.test(file.type || '') && file.size <= 1024 * 1024;
  if (maxSide <= REF_MAX_SIDE && (smallPng || /image\/(jpe?g|webp)/i.test(file.type || ''))) {
    return { dataUrl: original, width: dims.width, height: dims.height, name };
  }
  const scale = Math.min(1, REF_MAX_SIDE / maxSide);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(dims.width * scale));
  canvas.height = Math.max(1, Math.round(dims.height * scale));
  canvas.getContext('2d').drawImage(await loadImage(original), 0, 0, canvas.width, canvas.height);
  return {
    dataUrl: canvas.toDataURL('image/jpeg', 0.92),
    width: canvas.width,
    height: canvas.height,
    name,
  };
}

function renderRefs() {
  refsTitle.textContent = `References (${refs.length}/${REF_LIMIT}) - ${refs.length ? 'edit these' : 'text to image'}`;
  refsGrid.replaceChildren();
  refs.forEach((ref, index) => {
    refsGrid.append(el('div', { class: 'qwen-ref' }, [
      el('img', {
        src: ref.dataUrl,
        alt: '',
        onClick: () => openViewer({ src: ref.dataUrl, title: ref.name }),
      }),
      el('button', {
        class: 'qwen-ref-remove',
        type: 'button',
        text: '\u2715',
        title: 'Remove this reference',
        onClick: () => {
          refs.splice(index, 1);
          renderRefs();
          refreshSummary();
        },
      }),
    ]));
  });
  if (!refs.length) {
    refsGrid.append(el('div', { class: 'empty-hint', text: 'No references - the prompt generates a new picture.' }));
  }
}

function addRefs(entries) {
  for (const entry of entries) {
    if (refs.length >= REF_LIMIT) {
      toast(`max ${REF_LIMIT} reference images`, 'warn');
      break;
    }
    refs.push(entry);
  }
  renderRefs();
  refreshSummary();
}

async function addRefFromResult(result) {
  if (refs.length >= REF_LIMIT) {
    toast(`max ${REF_LIMIT} reference images`, 'warn');
    return;
  }
  const overlay = busy('adding reference\u2026');
  try {
    const loaded = await fetchImageData({ path: result.path, url: result.url, px: REF_MAX_SIDE });
    addRefs([{ dataUrl: loaded.dataUrl, width: loaded.width, height: loaded.height, name: 'result' }]);
    toast('reference added', 'ok', 1600);
  } catch (error) {
    toast(`could not load the image: ${error.message}`, 'err');
  } finally {
    overlay.close();
  }
}

/** Gallery "To Qwen" quick action: load a gallery item as an edit reference. */
export async function addImageAsQwenRef(item) {
  if (!refsGrid) {
    // The screen initializes lazily on its first visit - open it once so refsGrid exists.
    switchTab('qwen');
    await new Promise((resolve) => setTimeout(resolve, 60));
  }
  await addRefFromResult({ path: item.path, url: item.url });
}

/** Open ./data/collection and add the picked pictures as references. */
function openCollection() {
  openCollectionPicker({
    onPick: (entry) => {
      if (refs.length >= REF_LIMIT) {
        toast(`max ${REF_LIMIT} reference images`, 'warn');
        return false;
      }
      addRefs([entry]);
      toast('reference added', 'ok', 1600);
      return true;
    },
  });
}

/* ---------------------------------------------------------------- status chip */

function renderStatus(info) {
  if (!info) {
    statusChip.textContent = 'server: checking\u2026';
    statusChip.className = 'qwen-status';
    return;
  }
  if (info.available === false) {
    statusChip.textContent = 'server: files missing';
    statusChip.className = 'qwen-status err';
    return;
  }
  if (info.reachable) {
    statusChip.textContent = 'server: ready';
    statusChip.className = 'qwen-status ok';
  } else if (info.starting) {
    statusChip.textContent = 'server: starting\u2026';
    statusChip.className = 'qwen-status warn';
  } else {
    statusChip.textContent = 'server: offline - starts on generate';
    statusChip.className = 'qwen-status';
  }
}

async function pollStatus() {
  try {
    renderStatus(await api_.qwenStatus());
  } catch (_error) {
    renderStatus(null);
  }
}

function startStatusTimer() {
  stopStatusTimer();
  statusTimer = setInterval(pollStatus, 2500);
}

function stopStatusTimer() {
  clearInterval(statusTimer);
  statusTimer = 0;
}

/* ---------------------------------------------------------------- summary + results */

function refreshSummary() {
  summaryMain.replaceChildren();
  const params = qwenParams();
  const parts = [
    `${params.width}\u00D7${params.height}`,
    `${params.steps} steps`,
    `CFG ${Number(params.cfg).toFixed(1)}`,
    refs.length ? `${refs.length} ref${refs.length > 1 ? 's' : ''}` : 'text\u2192image',
    params.seedLock ? `\u{1F512} ${params.seed}` : '\u{1F3B2} random',
  ];
  for (const part of parts) summaryMain.append(el('span', { text: part }));
  summaryMain.append(el('span', { class: 'muted', text: '\u2699' }));

  generateButton.disabled = isJobActive();
  generateButton.textContent = refs.length ? 'Edit' : 'Generate';
}

function renderResults() {
  const results = state.results.filter((item) => item.screen === 'qwen');
  strip.replaceChildren();

  const head = el('div', { class: 'card-head' }, [
    el('span', { text: `Results (${results.length})` }),
  ]);
  if (results.length) {
    head.append(el('button', {
      class: 'btn tiny ghost',
      type: 'button',
      text: 'clear',
      onClick: () => {
        state.results = state.results.filter((item) => item.screen !== 'qwen');
        renderResults();
      },
    }));
  }
  strip.append(head);

  if (!results.length) {
    strip.append(el('div', { class: 'empty-hint', text: 'Nothing generated yet - results stay here for quick reuse.' }));
    return;
  }

  const grid = el('div', { class: 'results-strip' });
  const shown = results.slice(0, 12);
  shown.forEach((result, index) => {
    grid.append(el('button', {
      class: 'result',
      type: 'button',
      onClick: () => openResultViewer(result, {
        list: shown,
        index,
        extraActions: (item) => [{
          label: '\u21A9 Use as reference',
          onClick: () => { closeViewer(); addRefFromResult(item); },
        }],
      }),
    }, [
      el('img', { src: result.thumb || result.url, alt: '', loading: 'lazy' }),
      result.seed !== undefined && result.seed !== null ? el('span', { class: 'seed-tag', text: `#${result.seed}` }) : null,
    ]));
  });
  strip.append(grid);
}

/* ---------------------------------------------------------------- generate */

async function generate() {
  if (isJobActive()) {
    toast('wait for the current job to finish', 'warn');
    return;
  }
  if (!prompt.positive.trim()) {
    toast('prompt is empty', 'warn');
    return;
  }

  const params = qwenParams();
  const payload = {
    task_id: randomTaskId(),
    prompt: prompt.positive,
    negative_prompt: prompt.negative,
    steps: params.steps,
    cfg: params.cfg,
    width: params.width,
    height: params.height,
    seed: params.seedLock ? Number(params.seed) : -1,
    batch: params.batch,
    refs: refs.map((ref) => ref.dataUrl),
  };

  generateButton.disabled = true;
  try {
    await runJob('qwen', payload, { label: refs.length ? 'qwen edit' : 'qwen-2.1', store: params, history: 'qwen' });
  } catch (error) {
    toast(`could not start: ${error.message}`, 'err', 5000);
  } finally {
    generateButton.disabled = false;
    refreshSummary();
    pollStatus();
  }
}

/* ---------------------------------------------------------------- screen */

export function init(container) {
  prompt = createPromptEditor('qwen');
  summaryMain = el('button', {
    class: 'summary-main', type: 'button', onClick: () => openParamsSheet('qwen'),
  });
  summary = el('div', { class: 'card summary-line' }, [summaryMain, historyControls('qwen', () => qwenParams())]);
  strip = el('div', { class: 'card' });

  statusChip = el('span', { class: 'qwen-status', text: 'server: checking\u2026' });
  refsTitle = el('span', { text: 'References (0/10) - text to image' });
  refsGrid = el('div', { class: 'qwen-refs' });

  const upload = el('input', {
    type: 'file',
    accept: 'image/*',
    multiple: true,
    hidden: true,
  });
  upload.addEventListener('change', async () => {
    const files = Array.from(upload.files || []);
    upload.value = '';
    if (!files.length) return;
    const overlay = busy(`preparing ${files.length} reference${files.length > 1 ? 's' : ''}\u2026`);
    try {
      const entries = [];
      for (const file of files) entries.push(await prepareRef(file));
      addRefs(entries);
    } catch (error) {
      toast(`could not read the image: ${error.message}`, 'err');
    } finally {
      overlay.close();
    }
  });

  const refsCard = el('div', { class: 'card' }, [
    el('div', { class: 'card-head' }, [
      refsTitle,
      el('button', {
        class: 'btn tiny',
        type: 'button',
        text: '\uFF0B Add',
        onClick: () => upload.click(),
      }),
      el('button', {
        class: 'btn tiny',
        type: 'button',
        text: '\u{1F4C1} Collection',
        title: 'Pick from data/collection',
        onClick: openCollection,
      }),
    ]),
    refsGrid,
    el('div', { class: 'small muted', text: 'Add up to 10 pictures - the prompt then edits them (say what to change). No references = plain text to image.' }),
    upload,
  ]);

  generateButton = el('button', { class: 'btn primary wide', type: 'button', text: 'Generate', onClick: generate });

  container.append(
    el('div', { class: 'scr-body' }, [prompt.root, refsCard, summary, strip]),
    el('div', { class: 'scr-actions' }, [statusChip, generateButton]),
  );

  on('params', refreshSummary);
  on('results', renderResults);
  on('job-finished', refreshSummary);
  renderRefs();
  renderResults();
  refreshSummary();
}

export function onShow() {
  renderResults();
  refreshSummary();
  prompt.relayout();
  // switching to this screen frees the SDXL checkpoint and pre-loads the qwen server
  api_.engine({ engine: 'qwen' })
    .then((response) => renderStatus(response && response.qwen))
    .catch(() => {});
  startStatusTimer();
  pollStatus();
}

export function onHide() {
  stopStatusTimer();
  prompt.onHide();
}
