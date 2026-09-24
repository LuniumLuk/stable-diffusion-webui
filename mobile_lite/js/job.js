/* Generation engine: submits jobs, polls progress, drives the job strip. */

import { api_ } from './api.js';
import { addResult, emit, pushMruKeywords, setParam } from './state.js';
import { formatElapsed, openViewer, toast } from './ui.js';

const job = {
  active: false,
  taskId: null,
  kind: null,
  startedAt: 0,
  pollTimer: 0,
  pollBusy: false,
  lastPreviewId: -1,
  label: '',
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
    const img = document.getElementById('jobPreviewImg');
    if (img && img.src) openViewer({ src: img.src, title: 'live preview' });
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

async function poll() {
  if (!job.active || job.pollBusy) return;
  job.pollBusy = true;
  try {
    const info = await api_.progress({
      task_id: job.taskId,
      id_live_preview: job.lastPreviewId,
      live_preview: true,
    });
    if (info.live_preview) job.lastPreviewId = info.id_live_preview;
    const detail = info.textinfo || '';
    const eta = info.eta ? `~${formatElapsed(info.eta)} left` : '';
    const label = info.active ? job.label : (info.queued ? 'queued…' : job.label);
    setStrip({
      label,
      detail,
      eta,
      percent: info.progress || 0,
      preview: info.live_preview || null,
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
        if (!status.active && !status.queued_count) return null;
      }
    } catch (_error) {
      /* transient network errors while recovering are ignored */
    }
  }
  return null;
}

export function registerResult(result, kind, payload = null) {
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
    setParam('seed', result.seeds[0]);
  }
}

export async function runJob(kind, payload, { label = 'generating' } = {}) {
  if (job.active) {
    toast('another job is already running', 'warn');
    return null;
  }

  job.active = true;
  job.taskId = payload.task_id;
  job.kind = kind;
  job.label = label;
  job.startedAt = Date.now();
  job.lastPreviewId = -1;

  document.body.classList.add('job-running');
  document.getElementById('jobstrip').hidden = false;
  setStrip({ label, detail: 'starting…', percent: 0 });

  startPolling();
  try {
    const response = kind === 'img2img' ? await api_.img2img(payload) : await api_.txt2img(payload);
    setStrip({ label: 'saving…', percent: 1 });
    registerResult(response, kind, payload);
    const count = (response.images || []).length;
    toast(`${count} image${count === 1 ? '' : 's'} · ${formatElapsed(response.elapsed || (Date.now() - job.startedAt) / 1000)}`, 'ok');
    return response;
  } catch (error) {
    const recovered = await recoverResult(job.taskId);
    if (recovered) {
      registerResult(recovered, kind, payload);
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
    document.body.classList.remove('job-running');
    document.getElementById('jobstrip').hidden = true;
    emit('job-finished');
  }
}
