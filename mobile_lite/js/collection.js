/* Reference collection picker: browse ./data/collection and add pictures as references. */

import { api_, fetchImageData } from './api.js';
import { busy, closeSheet, el, openSheet, toast } from './ui.js';

const REF_PX = 1600; // server-side downscale on fetch (matches the client-side upload cap)

let cache = null; // one listing per session; the ⟳ button refreshes it

async function loadList(refresh = false) {
  if (!cache || refresh) cache = await api_.collection();
  return cache;
}

/**
 * Open the collection sheet for the Qwen / Krea 2 reference cards.
 * `onPick(entry)` receives { dataUrl, width, height, name }; returning false
 * (e.g. reference limit reached) leaves the tile unmarked.
 */
export async function openCollectionPicker({ onPick }) {
  const grid = el('div', { class: 'collection-grid' });
  const folderChips = el('div', { class: 'chips' });
  const subtitle = el('span', { class: 'small muted' });
  const added = new Set();
  let folder = '';
  let data = null;
  let images = [];

  const describe = () => {
    subtitle.textContent = `${images.length} picture${images.length === 1 ? '' : 's'} in ${(data && data.root) || 'data/collection'} - tap to add as a reference`;
  };

  const pick = async (image, tile) => {
    const overlay = busy('loading reference\u2026');
    try {
      const loaded = await fetchImageData({ path: image.path, px: REF_PX });
      const taken = onPick({
        dataUrl: loaded.dataUrl,
        width: loaded.width,
        height: loaded.height,
        name: image.name,
      });
      if (taken === false) return;
      added.add(image.path);
      tile.classList.add('on');
      if (!tile.querySelector('.tick')) tile.append(el('span', { class: 'tick', text: '\u2713' }));
    } catch (error) {
      toast(`could not load the image: ${error.message}`, 'err');
    } finally {
      overlay.close();
    }
  };

  const tileFor = (image) => {
    const isAdded = added.has(image.path);
    return el('button', {
      class: `collection-item${isAdded ? ' on' : ''}`,
      type: 'button',
      title: image.folder ? `${image.folder}/${image.name}` : image.name,
      onClick: (event) => pick(image, event.currentTarget),
    }, [
      el('img', { src: image.thumb || image.url, alt: '', loading: 'lazy' }),
      el('span', { class: 'name', text: image.name }),
      isAdded ? el('span', { class: 'tick', text: '\u2713' }) : null,
    ]);
  };

  const renderGrid = () => {
    grid.replaceChildren();
    const list = folder
      ? images.filter((image) => image.folder === folder || image.folder.startsWith(`${folder}/`))
      : images;
    for (const image of list) grid.append(tileFor(image));
    if (!list.length) grid.append(el('div', { class: 'empty-hint', text: 'No pictures in this folder.' }));
  };

  const renderChips = () => {
    folderChips.replaceChildren();
    const options = [['', 'All'], ...(data.folders || []).map((name) => [name, name])];
    for (const [value, label] of options) {
      folderChips.append(el('button', {
        class: `chip${folder === value ? ' on' : ''}`,
        type: 'button',
        text: label,
        onClick: () => {
          folder = value;
          renderChips();
          renderGrid();
        },
      }));
    }
  };

  const refresh = async () => {
    const overlay = busy('rescanning collection\u2026');
    try {
      data = await loadList(true);
      images = data.images || [];
      describe();
      renderChips();
      renderGrid();
    } catch (error) {
      toast(`could not load data/collection: ${error.message}`, 'err');
    } finally {
      overlay.close();
    }
  };

  const overlay = busy('loading collection\u2026');
  try {
    data = await loadList();
    images = data.images || [];
  } catch (error) {
    overlay.close();
    toast(`could not load data/collection: ${error.message}`, 'err');
    return;
  }
  overlay.close();

  describe();
  renderChips();
  renderGrid();

  openSheet({
    title: 'Collection',
    body: el('div', {}, [
      el('div', { class: 'card-head' }, [
        subtitle,
        el('button', { class: 'btn tiny', type: 'button', text: '\u21BB', title: 'Rescan the folder', onClick: refresh }),
      ]),
      folderChips,
      grid,
    ]),
    actions: [{ label: 'Done', primary: true, onClick: () => closeSheet() }],
  });
}
