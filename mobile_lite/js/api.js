/* Thin API client for the /mlite backend. */

const match = location.pathname.match(/^(.*?)\/mlite(\/|$)/);
export const ROOT = match ? match[1] : '';

export function url(path) {
  return ROOT + path;
}

export function fileUrl(path, query = '') {
  const clean = String(path || '').replace(/\\/g, '/');
  const suffix = query ? `?${query}` : '';
  return `${ROOT}/file=${encodeURIComponent(clean)}${suffix}`;
}

/** Optimized variant route (works whenever image bandwidth is not disabled). */
export function optimizedUrl(path, px = 1536, quality = 88) {
  return `${ROOT}/sd_net/image?path=${encodeURIComponent(path)}&px=${px}&q=${quality}`;
}

export async function api(path, { method = 'GET', body = null } = {}) {
  const res = await fetch(url(path), {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let detail = `${res.status} ${res.statusText}`;
    try {
      const data = await res.json();
      if (data && data.detail) detail = typeof data.detail === 'string' ? data.detail : JSON.stringify(data.detail);
    } catch (_error) { /* non-JSON error body */ }
    throw new Error(detail);
  }
  return res.json();
}

/**
 * POST a JSON body through XMLHttpRequest so upload progress can be surfaced.
 * The generation calls carry multi-MB base64 init images / masks, and fetch()
 * cannot report upload progress. `onProgress` receives { loaded, total, done }.
 */
export function apiUpload(path, body, { onProgress = null } = {}) {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('POST', url(path));
    request.setRequestHeader('Content-Type', 'application/json');
    if (onProgress && request.upload) {
      request.upload.addEventListener('progress', (event) => {
        onProgress({ loaded: event.loaded, total: event.lengthComputable ? event.total : 0, done: false });
      });
      request.upload.addEventListener('load', () => onProgress({ loaded: 0, total: 0, done: true }));
    }
    request.addEventListener('load', () => {
      if (request.status >= 200 && request.status < 300) {
        try {
          resolve(request.responseText ? JSON.parse(request.responseText) : null);
        } catch (_error) {
          reject(new Error('invalid JSON response'));
        }
        return;
      }
      let detail = `${request.status} ${request.statusText}`;
      try {
        const data = JSON.parse(request.responseText);
        if (data && data.detail) detail = typeof data.detail === 'string' ? data.detail : JSON.stringify(data.detail);
      } catch (_error) { /* non-JSON error body */ }
      reject(new Error(detail));
    });
    request.addEventListener('error', () => reject(new Error('network error')));
    request.addEventListener('abort', () => reject(new Error('request aborted')));
    request.send(JSON.stringify(body));
  });
}

export function randomTaskId() {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let suffix = '';
  for (let i = 0; i < 7; i += 1) suffix += alphabet[Math.floor(Math.random() * alphabet.length)];
  return `task(mlite-${suffix})`;
}

export const api_ = {
  bootstrap: () => api('/mlite/api/bootstrap'),
  status: () => api('/mlite/api/status'),
  progress: (payload) => api('/mlite/api/progress', { method: 'POST', body: payload }),
  interrupt: (action = 'interrupt') => api('/mlite/api/interrupt', { method: 'POST', body: { action } }),
  result: (taskId) => api(`/mlite/api/result?id_task=${encodeURIComponent(taskId)}`),
  txt2img: (payload, options) => apiUpload('/mlite/api/txt2img', payload, options),
  img2img: (payload, options) => apiUpload('/mlite/api/img2img', payload, options),
  qwen: (payload, options) => apiUpload('/mlite/api/qwen', payload, options),
  qwenStatus: () => api('/mlite/api/qwen/status'),
  engine: (payload) => api('/mlite/api/engine', { method: 'POST', body: payload }),
  gallery: ({ view = 'all', q = '', page = 1, size = 48, album = 0 } = {}) =>
    api(`/mlite/api/gallery?view=${encodeURIComponent(view)}&q=${encodeURIComponent(q)}&page=${page}&size=${size}&album=${encodeURIComponent(album || 0)}`),
  galleryAction: (payload) => api('/mlite/api/gallery/action', { method: 'POST', body: payload }),
  albums: () => api('/mlite/api/albums'),
  suggestions: () => api('/mlite/api/suggestions'),
  saveImage: (payload) => api('/mlite/api/save-image', { method: 'POST', body: payload }),
  options: (payload) => api('/mlite/api/options', { method: 'POST', body: payload }),
};

/**
 * Load an image for editing (inpaint source, composer layer, ...).
 * Prefers the optimized variant, falls back to the raw file.
 *
 * Re-sending the same picture (e.g. to img2img and then to inpaint) reuses the
 * already-downloaded image instead of fetching it again - bandwidth saver. The
 * cache is keyed by path and capped; entries live for the session.
 */
const sourceCache = new Map(); // cache key -> { dataUrl, width, height }
const SOURCE_CACHE_MAX = 8;

export async function fetchImageData({ path, url: directUrl, px = 1536 }) {
  const key = String(path || directUrl || '').replace(/\\/g, '/');
  const cached = key ? sourceCache.get(key) : null;
  if (cached) return cached;

  const candidates = [];
  if (path) {
    candidates.push(optimizedUrl(path, px, 88));
  }
  if (directUrl) candidates.push(directUrl);
  if (path) candidates.push(fileUrl(path));

  let lastError = null;
  for (const candidate of candidates) {
    try {
      const response = await fetch(candidate);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const blob = await response.blob();
      const dataUrl = await blobToDataUrl(blob);
      const dims = await imageSize(dataUrl);
      const entry = { dataUrl, width: dims.width, height: dims.height };
      if (key) {
        sourceCache.set(key, entry);
        while (sourceCache.size > SOURCE_CACHE_MAX) sourceCache.delete(sourceCache.keys().next().value);
      }
      return entry;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error('image could not be loaded');
}

export function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error('read failed'));
    reader.readAsDataURL(blob);
  });
}

export function imageSize(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => reject(new Error('image decode failed'));
    img.src = src;
  });
}
