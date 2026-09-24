/* Cross-screen helpers: send an image to the Image screen, endorse results. */

import { api_, fetchImageData } from './api.js';
import { emit, state } from './state.js';
import { busy, openViewer, switchTab, toast } from './ui.js';

/** Push an already-materialized image into the Image screen and switch to it. */
export function useSourceAsImage({ dataUrl, width, height, name = 'image', meta = null }, { mode = 'img2img' } = {}) {
  state.image.source = { dataUrl, width, height, name, meta };
  state.image.mode = mode;
  emit('image-source', state.image.source);
  emit('image-mode', mode);
  switchTab('image');
  toast(`loaded ${width}×${height} into ${mode === 'inpaint' ? 'inpaint' : 'img2img'}`, 'ok');
}
/** Prompt/parameter snapshot of a gallery item (travels with it to the Image screen). */
export function metaFromItem(item) {
  if (!item) return null;
  return {
    prompt: item.prompt || '',
    negative_prompt: item.negative_prompt || '',
    seed: item.seed,
    steps: item.steps,
    sampler: item.sampler,
    cfg: item.cfg,
    width: item.width,
    height: item.height,
  };
}
/** Load a gallery/result image into the Image screen (and switch to it). */
export async function useAsImage(item, { mode = 'img2img', meta = undefined } = {}) {
  const overlay = busy(`loading into ${mode === 'inpaint' ? 'inpaint' : 'img2img'}\u2026`);
  try {
    const px = mode === 'inpaint' ? 2048 : 1536;
    const loaded = await fetchImageData({ path: item.path, url: item.url, px });
    useSourceAsImage({
      dataUrl: loaded.dataUrl,
      width: loaded.width,
      height: loaded.height,
      name: item.path ? item.path.split(/[\\/]/).pop() : 'image',
      meta: meta === undefined ? metaFromItem(item) : meta,
    }, { mode });
    return true;
  } catch (error) {
    toast(`could not load image: ${error.message}`, 'err');
    return false;
  } finally {
    overlay.close();
  }
}

/** Endorse/dislike/archive a gallery item or a generated result. */
export async function galleryAction(action, { key = '', path = '', meta = {}, reload = true } = {}) {
  try {
    await api_.galleryAction({ action, key, path, meta });
    toast(`${action} ok`, 'ok', 1600);
    if (reload) emit('gallery-refresh');
    return true;
  } catch (error) {
    toast(`${action} failed: ${error.message}`, 'err');
    return false;
  }
}

export function metaFromResult(result) {
  const params = result.params || {};
  return {
    prompt: params.prompt || '',
    negative_prompt: params.negative_prompt || '',
    seed: result.seed,
    steps: params.steps,
    sampler: params.sampler,
    cfg: params.cfg,
    width: result.width || params.width,
    height: result.height || params.height,
    model: state.boot ? state.boot.model : '',
    infotext: result.infotext || '',
  };
}

/** Fullscreen viewer for a finished result with the usual follow-up actions. */
export function openResultViewer(result) {
  const actions = [
    { label: 'Use as Image', accent: true, onClick: () => { openViewerImage(result, 'img2img'); } },
    { label: 'Use as Inpaint', onClick: () => { openViewerImage(result, 'inpaint'); } },
  ];

  if (result.path) {
    const meta = metaFromResult(result);
    actions.push({
      label: '\u2B50 Endorse',
      onClick: async () => {
        await galleryAction('endorse', { path: result.path, meta });
      },
    });
  }
  if (result.seed !== undefined && result.seed !== null) {
    actions.push({
      label: 'Use seed',
      onClick: () => {
        import('./state.js').then(({ setParam }) => setParam('seed', result.seed));
        toast(`seed ${result.seed}`, 'ok', 1600);
      },
    });
  }

  openViewer({
    src: result.preview || result.url,
    title: result.seed !== undefined ? `seed ${result.seed}` : '',
    meta: result.infotext ? makeMetaNode(result.infotext) : null,
    actions,
  });
}

async function openViewerImage(result, mode) {
  await useAsImage(result, { mode });
}

export function makeMetaNode(text) {
  const node = document.createElement('div');
  node.className = 'viewer-meta';
  node.textContent = String(text).slice(0, 4000);
  return node;
}
