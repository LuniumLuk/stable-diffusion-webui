/* Text screen (txt2img). */

import { randomTaskId } from './api.js';
import { isJobActive, runJob } from './job.js';
import { openParamsSheet } from './params.js';
import { createPromptEditor } from './prompt.js';
import { on, state } from './state.js';
import { el, toast } from './ui.js';
import { openResultViewer } from './send.js';

let prompt;
let summary;
let strip;
let generateButton;

function refreshSummary() {
  summary.replaceChildren();
  const params = state.params;
  const parts = [
    `${params.width}×${params.height}`,
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
  for (const result of results.slice(0, 12)) {
    grid.append(el('button', {
      class: 'result',
      type: 'button',
      onClick: () => openResultViewer(result),
    }, [
      el('img', { src: result.thumb || result.url, alt: '', loading: 'lazy' }),
      result.seed !== undefined && result.seed !== null ? el('span', { class: 'seed-tag', text: `#${result.seed}` }) : null,
    ]));
  }
  strip.append(grid);
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
  };

  generateButton.disabled = true;
  await runJob('txt2img', payload, { label: 'txt2img' });
  generateButton.disabled = false;
  refreshSummary();
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
  renderResults();
  refreshSummary();
}

export function onShow() {
  renderResults();
  refreshSummary();
}
