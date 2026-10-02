/* Cross-screen helpers: send an image to the Image screen, endorse results. */

import { api_, fetchImageData, optimizedUrl } from './api.js';
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

/**
 * Viewer source: prefer the cached 480px webp preview, then an on-the-fly optimized
 * variant, and only fall back to the original file (bandwidth saver).
 */
export function viewerSrc(item) {
  if (!item) return '';
  if (item.preview) return item.preview;
  if (item.path) return optimizedUrl(item.path, 480, 85);
  return item.url || '';
}

/**
 * Apply a gallery item's parameters to the Text (txt2img) screen. The seed is recovered
 * AND locked so the exact picture can be re-run; the Image screen is not touched.
 */
export function useMetaInText(meta) {
  if (!meta) return false;
  state.textMeta = { ...meta };
  emit('text-meta', state.textMeta);
  switchTab('text');
  return true;
}

/** Qwen outputs are image-only: sent without any parameters and never rated. */
export function isQwenItem(item) {
  if (!item) return false;
  if (item.screen === 'qwen' || item.qwen) return true;
  return /(^|[\\/])outputs[\\/]qwen([\\/]|$)/i.test(String(item.path || ''));
}

/**
 * Fullscreen viewer for a finished result with the usual follow-up actions.
 * `list` + `index` make the viewer swipeable through the strip (left = next, right = prev);
 * `extraActions` is an array or a function of the current item.
 */
export function openResultViewer(result, { list = null, index = -1, extraActions = [] } = {}) {
  const items = Array.isArray(list) && list.length ? list : [result];
  let position = index >= 0 ? Math.min(index, items.length - 1) : items.indexOf(result);
  if (position < 0) position = 0;

  const show = () => {
    const item = items[position];
    const qwen = isQwenItem(item);
    const extras = typeof extraActions === 'function' ? extraActions(item) : extraActions;
    const actions = [
      ...extras,
      { label: 'Use as Image', accent: true, onClick: () => { openViewerImage(item, 'img2img', qwen ? null : undefined); } },
      { label: 'Use as Inpaint', onClick: () => { openViewerImage(item, 'inpaint', qwen ? null : undefined); } },
    ];

    if (item.path && !qwen) {
      const meta = metaFromResult(item);
      actions.push({
        label: '\u2B50 Endorse',
        onClick: async () => {
          await galleryAction('endorse', { path: item.path, meta });
        },
      });
    }
    if (item.seed !== undefined && item.seed !== null) {
      actions.push({
        label: 'Use seed',
        onClick: () => {
          import('./state.js').then(({ setSeedEverywhere }) => setSeedEverywhere(item.seed));
          toast(`seed ${item.seed}`, 'ok', 1600);
        },
      });
    }

    openViewer({
      src: viewerSrc(item),
      title: item.seed !== undefined && item.seed !== null ? `seed ${item.seed}` : '',
      meta: item.infotext ? makeMetaNode(item.infotext) : null,
      actions,
      onNavigate: move,
      canNavigate: canMove,
    });
  };

  const canMove = (direction) => {
    const next = position + (direction === 'next' ? 1 : -1);
    return next >= 0 && next < items.length;
  };

  const move = (direction) => {
    if (!canMove(direction)) return false;
    position += direction === 'next' ? 1 : -1;
    show();
    return true;
  };

  show();
}

async function openViewerImage(result, mode, meta = undefined) {
  await useAsImage(result, { mode, meta });
}

/** Info block below the viewer image; `folded` renders it as a collapsed <details>. */
export function makeMetaNode(text, { folded = false } = {}) {
  const content = String(text).slice(0, 4000);
  if (!folded) {
    const node = document.createElement('div');
    node.className = 'viewer-meta';
    node.textContent = content;
    return node;
  }
  const details = document.createElement('details');
  details.className = 'viewer-meta viewer-meta-fold';
  const summary = document.createElement('summary');
  summary.textContent = 'prompt & details';
  const body = document.createElement('div');
  body.className = 'viewer-meta-text';
  body.textContent = content;
  details.append(summary, body);
  return details;
}
