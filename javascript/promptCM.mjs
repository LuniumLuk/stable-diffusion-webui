/**
 * Desktop prompt editor — CodeMirror 6 text mode for the six/eight gradio prompt hosts
 * (`txt2img_prompt`, `txt2img_neg_prompt`, `img2img_prompt`, `img2img_neg_prompt`,
 * `qwen_prompt`, `qwen_neg_prompt`, `krea2_prompt`, `krea2_neg_prompt`).
 *
 * The chips editor (`javascript/promptEditor.js`) stays as it is; this module upgrades
 * the classic text mode the same way Mobile Lite did, sharing the editor core:
 *   - suggestions while typing    (the same MRU + endorsed + extra-network pool the
 *                                  chips editor uses, via window.promptEditorPool);
 *   - `#` comment + `# ---` block markers styled like the old backdrop overlay;
 *   - left-click / left-drag stay NATIVE (caret + text selection) — the manipulation
 *     popup opens on RIGHT-CLICK only: on a keyword, or inside a selection to apply
 *     weight / ⛔ to every selected keyword at once; Alt+drag rearranges a keyword;
 *   - desktop hotkeys: Ctrl+↑/↓ weight (edit-attention parity), Ctrl+/ comment toggle
 *     (cursor line, or every line in a multi-line selection), Ctrl+F find / replace
 *     panel (seeded with the selection) and Ctrl+D select-next-occurrence multi-editing;
 *   - line-number gutter: the first column shows line numbers; hovering a line swaps its
 *     number for the hover toggle — 💬 comments that single line, ▶/⏸ on a `# ---` section
 *     starter comments / uncomments the whole section.
 *
 * The gradio textarea stays the single source of truth and is only visually replaced
 * (the host gets `pedit-cm-mode`): every CM edit rewrites `textarea.value` and dispatches
 * input/change, so token counters, presets, extra-network insertion and the generation
 * payload are untouched.  External writes are picked up through a chained value setter,
 * an input listener and a poll.  If the bundle fails to load the textarea simply stays.
 */

// NOTE: the import must be an absolute /file= URL — module scripts are loaded through
// webpath() with WINDOWS backslashes ("file=javascript\promptCM.mjs"), and relative
// specifiers would then resolve against that single opaque segment.
import { createPromptCM } from '/file=mobile_lite/js/prompt-cm-core.js';

const HOST_IDS = ['txt2img_prompt', 'txt2img_neg_prompt', 'img2img_prompt', 'img2img_neg_prompt', 'qwen_prompt', 'qwen_neg_prompt', 'krea2_prompt', 'krea2_neg_prompt'];
const MAX_SUGGEST = 14;
const POLL_MS = 600;

const instances = new Map(); // host id -> CM instance (debug + tests)

/* ------------------------------------------------------------------ helpers */

function el(tag, props = {}) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value === undefined || value === null) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else node[key] = value;
  }
  return node;
}

let toastHost = null;
/** Minimal toast pill (this fork has no shared toast helper). */
function notify(message) {
  if (!message) return;
  if (!toastHost) {
    toastHost = el('div', { class: 'pedit-cm-toast-host' });
    document.body.append(toastHost);
  }
  const pill = el('div', { class: 'pedit-cm-toast', text: message });
  toastHost.append(pill);
  setTimeout(() => {
    pill.style.opacity = '0';
    setTimeout(() => pill.remove(), 300);
  }, 1400);
}

function readStep() {
  try {
    const value = parseFloat(localStorage.getItem('pedit.step') || '0.05');
    return Number.isNaN(value) || value <= 0 ? 0.05 : value;
  } catch (error) {
    return 0.05;
  }
}

/** Same MRU + endorsed + extra-network pool the chips editor uses, filtered like it. */
function suggestionsFor(query) {
  const pool = typeof window.promptEditorPool === 'function' ? window.promptEditorPool() : [];
  const needle = String(query || '').trim().toLowerCase();
  const starts = [];
  const contains = [];
  for (const keyword of pool) {
    const lowered = String(keyword).toLowerCase();
    if (!needle) {
      starts.push(keyword);
      if (starts.length >= MAX_SUGGEST) break;
    } else if (lowered.startsWith(needle)) {
      starts.push(keyword);
    } else if (lowered.indexOf(needle) >= 0) {
      contains.push(keyword);
    }
  }
  if (!needle) return starts;
  return starts.concat(contains).slice(0, MAX_SUGGEST);
}

/* ------------------------------------------------------------------ host install */

function installHost(host) {
  if (!host || host.dataset.promptCmReady === '1') return;
  const hostId = host.id;
  const textarea = host.querySelector('textarea');
  if (!textarea) return;
  host.dataset.promptCmReady = '1';

  const wrap = el('div', { class: 'pedit-cm-wrap' });
  wrap.hidden = true;
  host.append(wrap);

  let instance = null;
  let creating = false;
  let active = false;

  function ensure() {
    if (instance || creating) return Promise.resolve(instance);
    creating = true;
    return createPromptCM({
      host: wrap,
      text: textarea.value || '',
      placeholder: '',
      variant: 'inline',
      desktopKeys: true,
      lineGutter: true,
      weightStep: readStep,
      getSuggestions: suggestionsFor,
      onAccept: (label) => {
        if (typeof window.promptEditorPushRecent === 'function') window.promptEditorPushRecent(label);
      },
      notify,
      onChange: onCmInput,
    }).then((created) => {
      instance = created;
      instances.set(hostId, created);
      return created;
    }).catch((error) => {
      creating = false; // bundle unavailable — the plain textarea stays usable
      console.warn('promptCM: CodeMirror failed to load, keeping the textarea', error);
      return null;
    });
  }

  /** CM → textarea (the gradio field stays canonical for everything else). */
  function onCmInput(text) {
    if (text === textarea.value) return;
    textarea.value = text;
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    textarea.dispatchEvent(new Event('change', { bubbles: true }));
  }

  /** textarea → CM (paste params, presets, extra networks, style application...). */
  function syncFromTextarea() {
    if (!instance) return;
    const value = textarea.value || '';
    if (value !== instance.getText()) instance.setText(value);
  }

  function applyMode(modeName) {
    const wantText = modeName !== 'chips';
    host.classList.toggle('pedit-cm-mode', wantText);
    if (!wantText) {
      active = false;
      wrap.hidden = true;
      if (instance) instance.closePopups();
      return;
    }
    ensure().then((created) => {
      if (!created) return;
      wrap.hidden = false;
      active = true;
      created.setText(textarea.value || '');
      queueMicrotask(() => created.requestMeasure());
    });
  }

  // external writes arrive through the textarea's value setter (chained with the one
  // promptEditor.js installed), through input events, or - as a safety net - the poll
  const current = Object.getOwnPropertyDescriptor(textarea, 'value') || Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value');
  if (current && current.get && current.set) {
    Object.defineProperty(textarea, 'value', {
      get() { return current.get.call(this); },
      set(value) {
        current.set.call(this, value);
        if (active) syncFromTextarea();
      },
      configurable: true,
    });
  }
  textarea.addEventListener('input', () => { if (active) syncFromTextarea(); });
  setInterval(() => { if (active) syncFromTextarea(); }, POLL_MS);

  host.addEventListener('pedit-mode', (event) => applyMode(event.detail));

  const initial = typeof window.promptEditorMode === 'function'
    ? (window.promptEditorMode() === 'chips' ? 'chips' : 'text')
    : (host.classList.contains('pedit-chips-mode') ? 'chips' : 'text');
  applyMode(initial);
}

function installAll() {
  const app = gradioApp();
  HOST_IDS.forEach((id) => {
    const host = app.querySelector('#' + id);
    if (host) installHost(host);
  });
}

onUiLoaded(installAll);
onAfterUiUpdate(installAll);

// small debug surface for tests / live probing
window.promptCMDebug = { installAll, instances, version: 'r4-2026-10-13' };
