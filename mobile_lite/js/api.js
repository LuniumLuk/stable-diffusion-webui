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
  txt2img: (payload) => api('/mlite/api/txt2img', { method: 'POST', body: payload }),
  img2img: (payload) => api('/mlite/api/img2img', { method: 'POST', body: payload }),
  gallery: ({ view = 'all', q = '', page = 1, size = 48 } = {}) =>
    api(`/mlite/api/gallery?view=${encodeURIComponent(view)}&q=${encodeURIComponent(q)}&page=${page}&size=${size}`),
  galleryAction: (payload) => api('/mlite/api/gallery/action', { method: 'POST', body: payload }),
  suggestions: () => api('/mlite/api/suggestions'),
  saveImage: (payload) => api('/mlite/api/save-image', { method: 'POST', body: payload }),
  options: (payload) => api('/mlite/api/options', { method: 'POST', body: payload }),
};

/** Load an image for editing (inpaint source, composer layer, ...).
 *  Prefers the optimized variant, falls back to the raw file. */
export async function fetchImageData({ path, url: directUrl, px = 1536 }) {
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
      return { dataUrl, width: dims.width, height: dims.height };
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
