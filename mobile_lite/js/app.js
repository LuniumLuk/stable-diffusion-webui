/* App bootstrap: nav, header, model picker, settings sheet. */

import { api_, ROOT } from './api.js';
import { wireJobStrip } from './job.js';
import { applyModel } from './params.js';
import { bootstrap, on, persist, state } from './state.js';
import { closeSheet, debounce, el, initViewer, openSheet, switchTab, toast } from './ui.js';
import * as screenCompose from './screen-compose.js';
import * as screenGallery from './screen-gallery.js';
import * as screenImage from './screen-image.js';
import * as screenKrea2 from './screen-krea2.js';
import * as screenQwen from './screen-qwen.js';
import * as screenText from './screen-text.js';
import * as screenVideo from './screen-video.js';

const SCREENS = {
  text: screenText,
  image: screenImage,
  krea2: screenKrea2,
  qwen: screenQwen,
  video: screenVideo,
  gallery: screenGallery,
  compose: screenCompose,
};

const initialized = new Set();
let currentScreen = null;

function applyTab(name) {
  const screenName = SCREENS[name] ? name : 'text';
  if (currentScreen && currentScreen !== screenName) {
    const previous = SCREENS[currentScreen];
    if (previous.onHide) previous.onHide();
  }
  // Boot applies the last-used tab directly (no switchTab) - keep the body attribute in
  // sync here, it is what the per-screen CSS visibility rules key off.
  if (document.body.dataset.tab !== screenName) document.body.dataset.tab = screenName;
  for (const button of document.querySelectorAll('#tabbar button')) {
    button.classList.toggle('on', button.dataset.tab === screenName);
  }
  const module = SCREENS[screenName];
  const container = document.getElementById(`screen-${screenName}`);
  if (!initialized.has(screenName)) {
    initialized.add(screenName);
    module.init(container);
  }
  if (module.onShow) module.onShow();
  currentScreen = screenName;
  state.ui.lastTab = screenName;
  persist();
}

function showTab(name) {
  switchTab(name);
}

function updateModelChip() {
  const chip = document.getElementById('modelChip');
  const model = state.boot && state.boot.model ? state.boot.model : 'no checkpoint';
  chip.textContent = model.replace(/\.(safetensors|ckpt)$/i, '');
  chip.title = model;
}

/** Global secure mode: style.css flattens every img/canvas/video under this body class. */
function applySecureMode() {
  document.body.classList.toggle('secure-mode-hide-images', !!state.boot.secure_mode_hide_images);
}

/** Apply a /mlite/api/models payload to the boot state (and the header chip). */
function syncBootModels(data) {
  if (!data) return;
  if (Array.isArray(data.models)) state.boot.models = data.models;
  if (typeof data.model === 'string') state.boot.model = data.model;
  updateModelChip();
}

function openModelSheet() {
  const list = el('div', { class: 'option-list' });
  const search = el('input', { type: 'search', placeholder: 'filter…', autocapitalize: 'off', spellcheck: false });
  const status = el('div', { class: 'small muted' });
  let models = state.boot.models || [];

  const renderList = (filter = '') => {
    list.replaceChildren();
    const matches = models.filter((model) => model.title.toLowerCase().includes(filter.toLowerCase()));
    for (const model of matches.slice(0, 400)) {
      const current = state.boot.model === model.title;
      list.append(el('button', {
        class: `option-item ${current ? 'on' : ''}`,
        type: 'button',
        onClick: async () => { closeSheet(); await applyModel(model.title); },
      }, [
        el('span', { text: model.title }),
        current ? el('span', { class: 'sub', text: 'current' }) : null,
      ]));
    }
    if (!matches.length) list.append(el('div', { class: 'empty-hint', text: 'no match' }));
    status.textContent = `${matches.length} of ${models.length} checkpoint(s)`;
  };

  const reload = el('button', {
    class: 'option-item', type: 'button', text: '\u21BB Reload checkpoint list',
    title: 'Rescan the models folder and drop checkpoints whose files were deleted',
    onClick: async () => {
      status.textContent = 'scanning the models folder\u2026';
      try {
        syncBootModels(await api_.models(true));
        models = state.boot.models || [];
        renderList(search.value);
        toast('checkpoint list reloaded', 'ok', 1800);
      } catch (error) {
        status.textContent = `reload failed: ${error.message}`;
      }
    },
  });

  search.addEventListener('input', debounce(() => renderList(search.value), 200));
  renderList();

  // pick up files deleted/added since the page booted; the server only rescans when a
  // listed checkpoint file is gone, so this stays cheap
  api_.models(false).then((data) => {
    syncBootModels(data);
    models = state.boot.models || [];
    renderList(search.value);
  }).catch(() => { status.textContent = `${models.length} checkpoint(s) \u00B7 list may be stale`; });

  openSheet({ title: 'Checkpoint', body: el('div', {}, [search, status, list, reload]) });
}

function openSettingsSheet() {
  const modeOptions = [
    { value: 'Auto (mobile devices)', label: 'Auto' },
    { value: 'Always', label: 'Always' },
    { value: 'Disabled', label: 'Desktop only' },
  ];
  const modeButtons = modeOptions.map((option) => el('button', {
    type: 'button',
    class: state.boot.mode === option.value ? 'on' : '',
    text: option.label,
    onClick: () => {
      modeButtons.forEach((button, index) => button.classList.toggle('on', modeOptions[index].value === option.value));
      api_.options({ mobile_lite_mode: option.value })
        .then(() => {
          state.boot.mode = option.value;
          toast(`mobile lite mode: ${option.label}`, 'ok', 2000);
        })
        .catch((error) => toast(`could not save: ${error.message}`, 'err'));
    },
  }));

  const secureOptions = [
    { value: true, label: 'On' },
    { value: false, label: 'Off' },
  ];
  const secureButtons = secureOptions.map((option) => el('button', {
    type: 'button',
    class: !!state.boot.secure_mode_hide_images === option.value ? 'on' : '',
    text: option.label,
    onClick: () => {
      secureButtons.forEach((button, index) => button.classList.toggle('on', secureOptions[index].value === option.value));
      api_.options({ secure_mode_hide_images: option.value })
        .then(() => {
          state.boot.secure_mode_hide_images = option.value;
          applySecureMode();
          toast(`secure mode: ${option.label}`, 'ok', 2000);
        })
        .catch((error) => toast(`could not save: ${error.message}`, 'err'));
    },
  }));

  const statusLine = el('div', { class: 'small muted', text: 'checking server…' });
  api_.status().then((info) => {
    statusLine.textContent = info.active
      ? `server busy: ${info.textinfo || 'generating'} (${Math.round((info.progress || 0) * 100)}%)`
      : `server idle${info.vram_used_gb ? ` · VRAM ${info.vram_used_gb}/${info.vram_total_gb} GB` : ''}`;
  }).catch(() => { statusLine.textContent = 'server status unavailable'; });

  openSheet({
    title: 'Lite settings',
    body: el('div', {}, [
      el('div', { class: 'field' }, [
        el('label', { text: 'Default UI (mobile lite redirect)' }),
        el('div', { class: 'segmented' }, modeButtons),
        el('div', { class: 'small muted', text: 'Auto sends phones/tablets that open / here; "Desktop only" turns the redirect off; "Always" sends every browser.' }),
      ]),
      el('div', { class: 'field' }, [
        el('label', { text: 'Global secure mode' }),
        el('div', { class: 'segmented' }, secureButtons),
        el('div', { class: 'small muted', text: 'Blanks every image (results, gallery thumbnails, previews, editor canvases) with a placeholder. Shared with the desktop UI.' }),
      ]),
      statusLine,
      el('div', { class: 'option-list' }, [
        el('a', { class: 'option-item', href: `${ROOT}/?desktop=1`, style: { textDecoration: 'none' }, text: '\u{1F5A5} Open the desktop (Gradio) UI' }),
        el('button', {
          class: 'option-item', type: 'button', text: '\u21BB Reload lite UI',
          onClick: () => location.reload(),
        }),
        el('button', {
          class: 'option-item', type: 'button', text: '\u{1F9F9} Clear local settings',
          onClick: () => {
            localStorage.removeItem('mlite.state.v1');
            location.reload();
          },
        }),
      ]),
      el('div', { class: 'small muted', text: `SD Lite v${state.boot.version || 1} · server: ${location.host}` }),
    ]),
    actions: [{ label: 'Close', primary: true, onClick: () => closeSheet() }],
  });
}

function showBootError(error) {
  document.body.classList.remove('booting');
  const container = document.getElementById('screen-text');
  container.append(el('div', { class: 'scr-body' }, [
    el('div', { class: 'lite-error' }, [
      el('div', { text: 'Could not reach the lite API.' }),
      el('div', { class: 'small muted', style: { margin: '8px 0' }, text: String(error && error.message || error) }),
      el('button', {
        class: 'btn primary', type: 'button', text: 'Retry',
        onClick: () => location.reload(),
      }),
    ]),
  ]));
}

async function main() {
  initViewer();
  wireJobStrip();

  document.getElementById('btnSettings').addEventListener('click', openSettingsSheet);
  document.getElementById('modelChip').addEventListener('click', openModelSheet);
  for (const button of document.querySelectorAll('#tabbar button')) {
    button.addEventListener('click', () => showTab(button.dataset.tab));
  }
  document.addEventListener('mlite-tab', (event) => applyTab(event.detail));
  on('model', updateModelChip);

  try {
    await bootstrap();
  } catch (error) {
    showBootError(error);
    return;
  }

  updateModelChip();
  applySecureMode();
  document.body.classList.remove('booting');
  applyTab(state.ui.lastTab || 'text');
}

main();
