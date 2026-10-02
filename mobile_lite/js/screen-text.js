/* Text screen (txt2img). */

import { randomTaskId } from './api.js';
import { hrFinalSize } from './hires.js';
import { isJobActive, runJob } from './job.js';
import { openParamsSheet } from './params.js';
import { createPromptEditor } from './prompt.js';
import { on, setParam, state } from './state.js';
import { el, toast } from './ui.js';
import { openResultViewer } from './send.js';

let prompt;
let summary;
let strip;
let generateButton;

function refreshSummary() {
  summary.replaceChildren();
  const params = state.params;
  const hires = params.hrEnabled ? hrFinalSize(params) : null;
  const parts = [
    `${params.width}\u00D7${params.height}`,
    hires ? `Hires \u00D7${params.hrScale} \u2192 ${hires.width}\u00D7${hires.height}` : '',
    `${params.steps} steps`,
    `CFG ${params.cfg}`,
    params.sampler || '-',
    params.batch > 1 ? `×${params.batch}` : '',
    params.seedLock ? `\u{1F512} ${params.seed}` : '\u{1F3B2} random',
  ].filter(Boolean);
  for (const part of parts) summary.append(el('span', { text: part }));
  summary.append(el('span', { class: 'muted', text: '\u2699' }));

  generateButton.disabled = isJobActive();
  generateButton.textContent = params.batch > 1 ? `Generate · ${params.batch}` : 'Generate';
}

function renderResults() {
  const results = state.results.filter((item) => item.screen === 'txt2img');
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
        state.results = state.results.filter((item) => item.screen !== 'txt2img');
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
      onClick: () => openResultViewer(result, { list: shown, index }),
    }, [
      el('img', { src: result.thumb || result.url, alt: '', loading: 'lazy' }),
      result.seed !== undefined && result.seed !== null ? el('span', { class: 'seed-tag', text: `#${result.seed}` }) : null,
    ]));
  });
  strip.append(grid);
}

/**
 * Adopt a gallery item's prompt and parameters (desktop "send to txt2img" parity).
 * The seed is recovered AND locked so the exact picture can be re-run; the other
 * screens keep their own seed (a random seed stays random there).
 */
function applyMeta(meta) {
  if (!meta) return;
  const store = state.params;
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
    const steps = Math.max(1, Math.round(Number(meta.steps)));
    setParam('steps', steps, store);
    applied.push(`${steps} steps`);
  }
  if (meta.cfg) {
    setParam('cfg', Number(meta.cfg), store);
    applied.push(`CFG ${Number(meta.cfg)}`);
  }
  if (meta.sampler) {
    setParam('sampler', String(meta.sampler), store);
    applied.push(String(meta.sampler));
  }
  const width = Math.round(Number(meta.width));
  const height = Math.round(Number(meta.height));
  if (Number.isFinite(width) && Number.isFinite(height) && width >= 64 && height >= 64) {
    setParam('width', width, store);
    setParam('height', height, store);
    applied.push(`${width}\u00D7${height}`);
  }
  const seed = Number(meta.seed);
  if (Number.isFinite(seed) && seed >= 0) {
    setParam('seed', seed, store);
    setParam('seedLock', true, store);
    applied.push(`seed ${seed} (locked)`);
  }
  if (applied.length) toast(`text params: ${applied.join(', ')}`, 'ok', 3000);
  refreshSummary();
}

async function generate() {
  if (isJobActive()) {
    toast('wait for the current job to finish', 'warn');
    return;
  }
  if (!prompt.positive.trim()) {
    toast('prompt is empty', 'warn');
    return;
  }

  const params = state.params;
  const payload = {
    task_id: randomTaskId(),
    prompt: prompt.positive,
    negative_prompt: prompt.negative,
    steps: params.steps,
    cfg: params.cfg,
    width: params.width,
    height: params.height,
    sampler: params.sampler,
    scheduler: params.scheduler,
    seed: params.seedLock ? Number(params.seed) : -1,
    batch: params.batch,
    enable_hr: Boolean(params.hrEnabled),
    hr_upscaler: params.hrUpscaler,
    hr_scale: params.hrScale,
    hr_steps: params.hrSteps,
    hr_denoise: params.hrDenoise,
    hr_stage_config: params.hrStageConfig,
  };

  generateButton.disabled = true;
  try {
    await runJob('txt2img', payload, { label: 'txt2img' });
  } catch (error) {
    toast(`could not start: ${error.message}`, 'err', 5000);
  } finally {
    generateButton.disabled = false;
    refreshSummary();
  }
}

export function init(container) {
  prompt = createPromptEditor('text');
  summary = el('button', { class: 'card summary-line', type: 'button', onClick: () => openParamsSheet('text') });
  strip = el('div', { class: 'card' });
  generateButton = el('button', { class: 'btn primary wide', type: 'button', text: 'Generate', onClick: generate });

  container.append(
    el('div', { class: 'scr-body' }, [prompt.root, summary, strip]),
    el('div', { class: 'scr-actions' }, [generateButton]),
  );

  on('params', refreshSummary);
  on('results', renderResults);
  on('job-finished', refreshSummary);
  on('text-meta', (event) => {
    applyMeta(event.detail);
    state.textMeta = null;
  });
  // a hand-off that arrived before this screen was first opened
  if (state.textMeta) {
    applyMeta(state.textMeta);
    state.textMeta = null;
  }
  renderResults();
  refreshSummary();
}

export function onShow() {
  renderResults();
  refreshSummary();
  prompt.relayout();
}

export function onHide() {
  prompt.onHide();
}
