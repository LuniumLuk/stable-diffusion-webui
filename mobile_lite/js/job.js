/* Generation engine: submits jobs, polls progress, drives the job strip. */

import { api_ } from './api.js';
import { addResult, emit, pushMruKeywords, pushParamHistory, setParam, state } from './state.js';
import { formatBytes, formatElapsed, openViewer, toast, updateViewer } from './ui.js';

const job = {
  active: false,
  taskId: null,
  kind: null,
  startedAt: 0,
  pollTimer: 0,
  pollBusy: false,
  lastPreviewId: -1,
  label: '',
  phase: 'idle', // upload | sent | generating - controls what the strip shows
  upload: { loaded: 0, total: 0 },
  previewSrc: '', // last live-preview frame - kept between polls so the thumb never blinks
  percent: 0,
};

export function isJobActive() {
  return job.active;
}

export function currentJobKind() {
  return job.kind;
}

export function wireJobStrip() {
  document.getElementById('jobStop').addEventListener('click', async () => {
    try {
      await api_.interrupt('interrupt');
      toast('stopping…', 'warn');
    } catch (error) {
      toast(`stop failed: ${error.message}`, 'err');
    }
  });

  document.getElementById('jobPreview').addEventListener('click', () => {
    if (!job.previewSrc) return;
    openViewer({ src: job.previewSrc, title: previewTitle(), tag: 'job-preview' });
  });
}

function setStrip({ label, detail = '', eta = '', percent = 0, preview = null }) {
  document.getElementById('jobLabel').textContent = label;
  document.getElementById('jobDetail').textContent = detail;
  document.getElementById('jobEta').textContent = eta;
  document.getElementById('jobPercent').textContent = percent > 0 ? `${Math.round(percent * 100)}%` : '';
  document.getElementById('jobBarFill').style.width = `${Math.round(clamp01(percent) * 100)}%`;

  const previewButton = document.getElementById('jobPreview');
  const previewImg = document.getElementById('jobPreviewImg');
  if (preview) {
    previewImg.src = preview;
    previewButton.hidden = false;
  } else {
    previewButton.hidden = true;
  }
}

function clamp01(value) { return Math.min(1, Math.max(0, Number(value) || 0)); }

/** Title of the live-preview viewer - follows the running job. */
function previewTitle() {
  const percent = Math.round(clamp01(job.percent) * 100);
  return percent > 0 ? `live preview \u00B7 ${percent}%` : 'live preview';
}

/** "sent, waiting for the worker" message with an elapsed counter (server may still decode / load a model). */
function sentDetail() {
  const what = job.kind === 'img2img' ? 'image sent' : 'request sent';
  const waited = Math.round((Date.now() - job.startedAt) / 1000);
  return `${what} \u00B7 waiting for the worker\u2026${waited >= 2 ? ` (${waited}s)` : ''}`;
}

/** The upload phase has no server-side task yet, so it is reported from the XHR itself. */
function uploadDetail() {
  const label = job.kind === 'img2img' ? 'uploading image' : 'sending prompt';
  const { loaded, total } = job.upload;
  if (!total) return `${label}\u2026`;
  return `${label} ${formatBytes(loaded)} / ${formatBytes(total)}`;
}

function handleUploadProgress(event) {
  if (job.phase !== 'upload' && job.phase !== 'sent') return;
  if (event.done || (event.total && event.loaded >= event.total)) {
    // body fully sent - the server still has to decode/prepare before the task appears
    job.phase = 'sent';
    setStrip({ label: job.label, detail: sentDetail(), percent: 0 });
    return;
  }
  job.upload = { loaded: event.loaded, total: event.total };
  setStrip({
    label: job.label,
    detail: uploadDetail(),
    percent: event.total ? event.loaded / event.total : 0,
  });
}

async function poll() {
  if (!job.active || job.pollBusy) return;
  // While the body is still being uploaded the server has no task yet - polling
  // would only steal bandwidth from the upload; the XHR drives the display.
  if (job.phase === 'upload') return;
  job.pollBusy = true;
  try {
    const info = await api_.progress({
      task_id: job.taskId,
      id_live_preview: job.lastPreviewId,
      live_preview: true,
    });
    if (info.live_preview) {
      // keep the last frame: polls without a new one must not hide the thumbnail
      job.previewSrc = info.live_preview;
      job.lastPreviewId = info.id_live_preview;
    }
    if (info.active || info.queued) job.phase = 'generating';
    // keep the "sent" message until the worker actually picks the task up (elapsed keeps it alive)
    if (job.phase !== 'generating') {
      if (job.phase === 'sent') setStrip({ label: job.label, detail: sentDetail(), percent: 0 });
      return;
    }
    job.percent = info.progress || 0;
    const detail = info.textinfo || '';
    const eta = info.eta ? `~${formatElapsed(info.eta)} left` : '';
    const label = info.active ? job.label : (info.queued ? 'queued\u2026' : job.label);
    updateViewer('job-preview', {
      src: info.live_preview ? job.previewSrc : null,
      title: previewTitle(),
    });
    setStrip({
      label,
      detail,
      eta,
      percent: job.percent,
      preview: job.previewSrc || null,
    });
  } catch (_error) {
    /* transient network errors while polling are ignored */
  } finally {
    job.pollBusy = false;
  }
}

function startPolling() {
  stopPolling();
  job.pollTimer = setInterval(poll, 800);
  poll();
}

function stopPolling() {
  clearInterval(job.pollTimer);
  job.pollTimer = 0;
}

async function recoverResult(taskId) {
  // The job keeps running server-side even when the HTTP response is lost (phone slept,
  // tunnel dropped). Poll the result ring for as long as something is still running;
  // give up early only when nothing is active, nothing is queued and there is no result.
  for (let attempt = 0; attempt < 150; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, attempt < 5 ? 800 : 2000));
    try {
      const data = await api_.result(taskId);
      if (data && data.status === 'done') return data;

      if (attempt >= 3) {
        const status = await api_.status();
        if (!status.active && !status.queued_count && !status.qwen_active) return null;
      }
    } catch (_error) {
      /* transient network errors while recovering are ignored */
    }
  }
  return null;
}

export function registerResult(result, kind, payload = null, store = state.params) {
  const lightPayload = payload ? { ...payload } : null;
  if (lightPayload) {
    delete lightPayload.init_image;
    delete lightPayload.mask;
    delete lightPayload.alwayson;
  }
  for (const image of result.images || []) {
    addResult({
      url: image.url,
      path: image.path,
      thumb: image.thumb || image.url,
      preview: image.preview || image.url,
      seed: image.seed,
      infotext: image.infotext || '',
      screen: kind,
      width: lightPayload ? lightPayload.width : undefined,
      height: lightPayload ? lightPayload.height : undefined,
      params: lightPayload,
    });
  }
  if (lightPayload && lightPayload.prompt) pushMruKeywords(lightPayload.prompt);
  if (result.seeds && result.seeds.length) {
    setParam('seed', result.seeds[0], store);
  }
}

export async function runJob(kind, payload, { label = 'generating', store = state.params, history = null } = {}) {
  if (job.active) {
    toast('another job is already running', 'warn');
    return null;
  }

  if (history) pushParamHistory(history, store); // remember the settings this run uses
  job.active = true;
  job.taskId = payload.task_id;
  job.kind = kind;
  job.label = label;
  job.startedAt = Date.now();
  job.lastPreviewId = -1;
  job.previewSrc = '';
  job.percent = 0;
  job.phase = 'upload';
  job.upload = { loaded: 0, total: 0 };

  document.body.classList.add('job-running');
  document.getElementById('jobstrip').hidden = false;
  setStrip({ label, detail: uploadDetail(), percent: 0 });

  startPolling();
  try {
    const progress = { onProgress: handleUploadProgress };
    const response = await (kind === 'img2img'
      ? api_.img2img(payload, progress)
      : kind === 'qwen'
        ? api_.qwen(payload, progress)
        : api_.txt2img(payload, progress));
    setStrip({ label: 'saving…', percent: 1, preview: job.previewSrc || null });
    registerResult(response, kind, payload, store);
    const count = (response.images || []).length;
    toast(`${count} image${count === 1 ? '' : 's'} · ${formatElapsed(response.elapsed || (Date.now() - job.startedAt) / 1000)}`, 'ok');
    return response;
  } catch (error) {
    setStrip({ label: job.label, detail: 'connection lost \u00B7 checking for the result\u2026', percent: 1 });
    const recovered = await recoverResult(job.taskId);
    if (recovered) {
      registerResult(recovered, kind, payload, store);
      toast(`recovered ${(recovered.images || []).length} image(s) after a lost connection`, 'warn', 4200);
      return recovered;
    }
    const message = error && error.message ? error.message : 'generation failed';
    toast(message, 'err', 5200);
    return null;
  } finally {
    stopPolling();
    job.active = false;
    job.taskId = null;
    job.kind = null;
    job.phase = 'idle';
    updateViewer('job-preview', { title: 'live preview \u00B7 finished' });
    document.body.classList.remove('job-running');
    document.getElementById('jobstrip').hidden = true;
    emit('job-finished');
  }
}
