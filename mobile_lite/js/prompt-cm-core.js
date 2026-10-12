/**
 * CodeMirror 6 prompt-editor CORE — shared by the desktop prompt hosts
 * (`javascript/promptCM.mjs`) and Mobile Lite (`./prompt-cm.js`).
 *
 * The prompt is plain text and in CM the document IS the value, so the surrounding
 * apps keep their hidden textarea as the source of truth and this editor stays a view
 * over it.  On that base the module adds the prompt grammar both frontends share:
 *
 *   - ✨ inline suggestions — typing opens an autocomplete list fed by the caller's
 *                            `getSuggestions(query)` pool (MRU + endorsed + networks);
 *   - 💬 comments          — `# ...` lines and `# ---` markers are styled like the old
 *                            overlay; the token popup comments / uncomments a line, and
 *                            on a `# ---` marker it toggles the whole block;
 *   - drag to rearrange    — TOUCH: press a keyword and move it (ghost + drop bar at the
 *                            top-level comma slots; separators repaired).  MOUSE: left
 *                            drags stay native SELECTION; Alt+drag rearranges instead;
 *   - quick actions        — TOUCH: tap a keyword → popup.  MOUSE: the manipulation popup
 *                            is RIGHT-CLICK only — on a keyword, or inside a selection
 *                            to act on every selected keyword at once (batch weight /
 *                            ⛔).  Popup: weight −/＋, quick 0.8 / 1.1 / 1.2 / ⟲1.0,
 *                            ⛔/✅ disable, ⇦⇨ nudge, 💬 comment, 🗑 delete;
 *   - desktop hotkeys      — `desktopKeys: true` adds Ctrl+↑/↓ (weight of the tokens at
 *                            the cursor / selection, edit-attention parity) and Ctrl+/
 *                            (toggle the line comment).  Ctrl/Cmd+Enter is always
 *                            CONSUMED here (no blank line) and left to the page's global
 *                            generate shortcut (desktop `script.js`).
 *
 * The vendored bundle (`../vendor/codemirror6.js`, built by `vendor/cm6build/build.bat`)
 * loads lazily on first use; when that fails the caller keeps its plain textarea.
 */

import { classify, DEFAULT_WEIGHT, formatWeight, rebuild, splitSegments } from './prompt-parse.js';
import { lineCommentState, moveToken, removeToken, replaceToken, snapSlot, tokenAt, toggleCommentAt, tokensInRange } from './prompt-cm-ops.js';

const DRAG_THRESHOLD = 10;   // px of movement before a press becomes a drag
const TAP_MAX_MS = 700;      // press longer than this is never treated as a tap
const TAP_TOGGLE_MS = 800;   // second tap on the same token closes its popup again
const WEIGHT_STEP = 0.05;    // fallback when the caller does not provide a step
const MAX_WEIGHT = 10;

let bundlePromise = null;

/** Load the vendored CodeMirror bundle once (rejects keep the textarea fallback). */
function loadBundle() {
  if (!bundlePromise) {
    bundlePromise = import('../vendor/codemirror6.js').catch((error) => {
      bundlePromise = null;
      throw error;
    });
  }
  return bundlePromise;
}

export { loadBundle };

/** Minimal DOM helper (independent of any app's helper module). */
function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value === undefined || value === null) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'dataset' && typeof value === 'object') Object.assign(node.dataset, value);
    else if (key in node && key !== 'list') node[key] = value;
    else node.setAttribute(key, value);
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return node;
}

/**
 * Mount a CodeMirror prompt editor into `host`.
 *
 * @param {object} options
 * @param {HTMLElement} options.host            container to append the editor to
 * @param {string}  [options.text]              initial document text
 * @param {string}  [options.placeholder]       placeholder shown while empty
 * @param {Function} [options.getSuggestions]   (query) => string[]  autocomplete pool
 * @param {Function} [options.onChange]         (text) => void  fired on every user edit
 * @param {Function} [options.notify]           (message, kind) => void  small toasts
 * @param {Function} [options.onAccept]         (label) => void  suggestion accepted
 * @param {number|Function} [options.weightStep]  weight step (default 0.05)
 * @param {boolean} [options.desktopKeys]       enable Ctrl+↑/↓ and Ctrl+/
 * @param {'inline'|'full'} [options.variant]   structural styling variant
 * @returns {Promise<object>} instance { view, getText, setText, focus, requestMeasure, closePopups, destroy }
 */
export async function createPromptCM({
  host, text = '', placeholder = '', getSuggestions, onChange, notify, onAccept,
  weightStep, desktopKeys = false, variant = 'inline',
} = {}) {
  const {
    EditorState, StateEffect, StateField,
    EditorView, Decoration, keymap, placeholder: placeholderExt, dropCursor,
    autocompletion, completionKeymap, closeBrackets, closeBracketsKeymap,
    history, historyKeymap, defaultKeymap,
  } = await loadBundle();

  const toast = typeof notify === 'function' ? notify : () => {};
  const stepValue = () => {
    const raw = typeof weightStep === 'function' ? weightStep() : weightStep;
    const value = Number(raw);
    return Number.isFinite(value) && value > 0 ? value : WEIGHT_STEP;
  };

  /* ------------------------------------------------------------ state plumbing */

  const setActiveToken = StateEffect.define();
  const activeTokenField = StateField.define({
    create: () => Decoration.none,
    update(value, tr) {
      let next = value.map(tr.changes);
      for (const effect of tr.effects) {
        if (effect.is(setActiveToken)) {
          const ranges = effect.value || [];
          next = ranges.length
            ? Decoration.set(ranges.map((range) => Decoration.mark({ class: 'pedit-cm-tok-active' }).range(range.from, range.to)))
            : Decoration.none;
        }
      }
      return next;
    },
    provide: (field) => EditorView.decorations.from(field),
  });

  /** Comment lines, `# ---` markers and disabled `#(...)` groups, from the document. */
  function buildDecorations(state) {
    const marks = [];
    for (let lineNumber = 1; lineNumber <= state.doc.lines; lineNumber += 1) {
      const line = state.doc.line(lineNumber);
      const lineText = line.text;
      if (/^\s*#(?!\()/.test(lineText)) {
        marks.push(Decoration.line({ class: /^\s*#\s*-{3,}/.test(lineText) ? 'pedit-cm-commentline pedit-cm-blockmark' : 'pedit-cm-commentline' }).range(line.from));
        const hash = lineText.indexOf('#');
        if (hash >= 0) marks.push(Decoration.mark({ class: 'pedit-cm-comment-hash' }).range(line.from + hash, line.from + hash + 1));
        continue;
      }
      // disabled keyword groups (#(...) / #[...] / #<...>) get a struck-through mark;
      // offsets come from the same segment walk the ops module uses
      let cursor = 0;
      for (const segment of splitSegments(lineText)) {
        const bodyStart = cursor + segment.lead.length;
        const core = segment.body.trim();
        if (core && classify(segment.body).disabled) {
          const coreLead = segment.body.length - segment.body.trimStart().length;
          marks.push(Decoration.mark({ class: 'pedit-cm-tok-off' }).range(line.from + bodyStart + coreLead, line.from + bodyStart + coreLead + core.length));
        }
        cursor = bodyStart + segment.body.length + segment.tail.length;
      }
    }
    return Decoration.set(marks, true);
  }

  const decorationField = StateField.define({
    create: (state) => buildDecorations(state),
    update(value, tr) {
      if (tr.docChanged) return buildDecorations(tr.state);
      return value.map(tr.changes);
    },
    provide: (field) => EditorView.decorations.from(field),
  });

  /* ------------------------------------------------------------ completion */

  function completionSource(context) {
    if (!getSuggestions) return null;
    const line = context.state.doc.lineAt(context.pos);
    const before = line.text.slice(0, context.pos - line.from);
    const match = /[^,\n]*$/.exec(before);
    if (!match) return null;
    const lead = /^\s*/.exec(match[0])[0].length;
    const query = match[0].slice(lead);
    const from = context.pos - query.length;
    if (!query && !context.explicit) return null;
    const keywords = getSuggestions(query) || [];
    if (!keywords.length) return null;
    return {
      from,
      options: keywords.map((label) => (onAccept
        ? {
          label,
          apply: (view, completion, applyFrom, applyTo) => {
            view.dispatch({ changes: { from: applyFrom, to: applyTo, insert: completion.label } });
            onAccept(completion.label);
          },
        }
        : { label })),
      validFor: /^[^,\n]*$/,
    };
  }

  /* ------------------------------------------------------------ interaction */

  let active = null;        // currently highlighted/actioned token
  let popup = null;         // open quick-action popup element
  let lastClosed = null;    // { from, to, at } — makes a second tap close the popup
  let drag = null;          // in-flight press / drag bookkeeping
  let selfEdit = false;     // true while a popup action edits the document
  let applying = false;     // true while an external setText runs
  let destroyed = false;

  const dom = el('div', { class: `pedit-cm pedit-cm-${variant}` });
  host.append(dom);

  function tokenFromPoint(x, y) {
    const pos = view.posAtCoords({ x, y });
    if (pos == null) return null;
    return tokenAt(view.state.doc.toString(), pos);
  }

  /** Tokens a right-click popup should act on: the keyword under the cursor, or the
   *  whole selection when the right-click lands inside it (batch manipulation). */
  function popupTargetsAt(x, y) {
    const selection = view.state.selection.main;
    const docText = view.state.doc.toString();
    const selectionTokens = selection.empty ? [] : tokensInRange(docText, selection.from, selection.to);
    const pos = view.posAtCoords({ x, y });
    const token = pos == null ? null : tokenAt(docText, pos);
    if (token && selectionTokens.length && token.from >= selection.from && token.to <= selection.to) {
      return selectionTokens;
    }
    if (token) return [token];
    return selectionTokens;
  }

  /* ---------------------------------------------------------- quick actions */

  function closePopup() {
    if (!popup) return;
    if (active && active.tokens.length) {
      const first = active.tokens[0];
      const last = active.tokens[active.tokens.length - 1];
      lastClosed = { from: first.from, to: last.to, at: Date.now() };
    }
    popup.remove();
    popup = null;
    active = null;
    document.removeEventListener('pointerdown', onDocumentPointerDown, true);
    // the highlight effect may be cleared from inside an update cycle (typing while
    // the popup is open) — dispatch is not allowed there, so defer it a microtask
    queueMicrotask(() => {
      if (destroyed || active) return;
      try {
        view.dispatch({ effects: setActiveToken.of(null) });
      } catch (error) {
        void error;
      }
    });
  }

  function onDocumentPointerDown(event) {
    if (popup && popup.contains(event.target)) return;
    closePopup();
  }

  function renderPopupContent() {
    if (!active || !active.tokens.length) return;
    const tokens = active.tokens;
    const multi = active.multi;
    const t = tokens[0];
    const weightOf = (token) => (token.token.weight == null ? DEFAULT_WEIGHT : token.token.weight);
    const firstWeight = weightOf(t);
    const commonWeight = tokens.every((token) => Math.abs(weightOf(token) - firstWeight) < 1e-9) ? firstWeight : null;
    const allDisabled = tokens.every((token) => token.token.disabled);
    const row = (...children) => el('div', { class: 'pedit-cm-pop-row' }, children);
    const button = (label, title, act, extra = {}) => el('button', {
      class: 'pedit-cm-pop-btn' + (extra.on ? ' is-on' : ''),
      type: 'button',
      text: label,
      title,
      dataset: { act },
    });
    const actionRow = [
      button(allDisabled ? '\u2705' : '\u26D4',
        multi
          ? 'Disable every selected keyword (or enable them all when already disabled)'
          : (t.token.disabled ? 'Enable this keyword' : 'Disable (stripped when generating)'),
        'toggle', { on: allDisabled }),
    ];
    if (!multi) {
      actionRow.push(
        button('\u21E6', 'Move one keyword left', 'move-left'),
        button('\u21E8', 'Move one keyword right', 'move-right'),
        button('\uD83D\uDCAC', lineCommentState(view.state.doc.toString(), t.line) ? 'Uncomment this line' : 'Comment this line', 'comment'),
        button('\uD83D\uDDD1', 'Delete this keyword', 'delete'),
      );
    }
    actionRow.push(button('\u2715', 'Close', 'close'));
    popup.replaceChildren(
      el('div', { class: 'pedit-cm-pop-title', text: multi ? `${tokens.length} keywords selected` : t.text }),
      row(
        button('\u2212', `Lower weight by ${stepValue()}`, 'w-minus'),
        el('span', { class: 'pedit-weight', text: commonWeight == null ? '\u00b1' : formatWeight(commonWeight) }),
        button('\uFF0B', `Raise weight by ${stepValue()}`, 'w-plus'),
      ),
      row(
        button('0.8', 'Set weight 0.8', 'w-0.8'),
        button('1.1', 'Set weight 1.1', 'w-1.1'),
        button('1.2', 'Set weight 1.2', 'w-1.2'),
        button('\u27F2', 'Back to weight 1 (brackets removed)', 'w-reset'),
      ),
      row(...actionRow),
    );
  }

  function positionPopup() {
    if (!popup || !active) return;
    const first = active.tokens[0];
    const last = active.tokens[active.tokens.length - 1];
    const start = view.coordsAtPos(first.from);
    const end = view.coordsAtPos(last.to);
    if (!start || !end) {
      closePopup();
      return;
    }
    const rect = popup.getBoundingClientRect();
    let left = (start.left + end.right) / 2 - rect.width / 2;
    left = Math.min(Math.max(8, left), Math.max(8, window.innerWidth - rect.width - 8));
    let top = start.top - rect.height - 10;
    if (top < 8) top = Math.min(end.bottom + 10, window.innerHeight - rect.height - 8);
    popup.style.left = `${Math.round(left)}px`;
    popup.style.top = `${Math.round(top)}px`;
  }

  function openTokenPopup(tokens) {
    closePopup();
    lastClosed = null;
    active = { tokens: tokens.slice(), multi: tokens.length > 1 };
    view.dispatch({ effects: setActiveToken.of(active.tokens.map((t) => ({ from: t.from, to: t.to }))) });
    popup = el('div', { class: 'pedit-cm-pop' });
    renderPopupContent();
    document.body.append(popup);
    positionPopup();
    popup.addEventListener('click', onPopupClick);
    document.addEventListener('pointerdown', onDocumentPointerDown, true);
  }

  /** Dispatch one of our popup edits; refresh (or close) the popup afterwards. */
  function applyEdit(plan, { close = false } = {}) {
    if (!plan || !plan.changes.length) {
      if (close) closePopup();
      return;
    }
    selfEdit = true;
    try {
      view.dispatch({
        changes: plan.changes,
        selection: plan.caret == null ? undefined : { anchor: plan.caret },
        userEvent: 'pedit.action',
      });
    } finally {
      selfEdit = false;
    }
    if (close) {
      closePopup();
      return;
    }
    if (active && active.multi) {
      // batch mode: the token list re-derives from the (auto-mapped) selection
      const docText = view.state.doc.toString();
      const selection = view.state.selection.main;
      const tokens = selection.empty ? [] : tokensInRange(docText, selection.from, selection.to);
      if (!tokens.length) {
        closePopup();
        return;
      }
      active = { tokens, multi: tokens.length > 1 };
      view.dispatch({ effects: setActiveToken.of(active.tokens.map((t) => ({ from: t.from, to: t.to }))) });
      renderPopupContent();
      positionPopup();
      return;
    }
    const caret = plan.caret == null ? view.state.selection.main.head : plan.caret;
    const refreshed = tokenAt(view.state.doc.toString(), Math.max(0, caret - 1));
    if (!refreshed) {
      closePopup();
      return;
    }
    active = { tokens: [refreshed], multi: false };
    view.dispatch({ effects: setActiveToken.of(active.tokens.map((t) => ({ from: t.from, to: t.to }))) });
    renderPopupContent();
    positionPopup();
  }

  function onPopupClick(event) {
    const target = event.target.closest('[data-act]');
    if (!target || !popup || !popup.contains(target) || !active) return;
    const action = target.dataset.act;
    const docText = view.state.doc.toString();
    const tokens = active.tokens;
    const multi = active.multi;
    const t = tokens[0];
    const weightOf = (token) => (token.token.weight == null ? DEFAULT_WEIGHT : token.token.weight);

    if (action === 'close') {
      closePopup();
      return;
    }
    if (!multi && action === 'comment') {
      applyEdit(toggleCommentAt(docText, t.line), { close: true });
      return;
    }
    if (!multi && action === 'delete') {
      applyEdit(removeToken(docText, t), { close: true });
      return;
    }
    if (!multi && (action === 'move-left' || action === 'move-right')) {
      const slot = action === 'move-left' ? t.seg - 1 : t.seg + 2;
      applyEdit(moveToken(docText, t, t.line, slot));
      return;
    }
    if (action === 'toggle') {
      const targetDisabled = !tokens.every((token) => token.token.disabled);
      if (multi) {
        const changes = tokens.map((token) => ({
          from: token.from,
          to: token.to,
          insert: rebuild(token.token, weightOf(token), targetDisabled),
        }));
        applyEdit({ changes, caret: null });
        toast(`${tokens.length} keywords ${targetDisabled ? 'disabled' : 'enabled'}`, 'ok', 1400);
      } else {
        applyEdit(replaceToken(docText, t, rebuild(t.token, weightOf(t), targetDisabled)));
        toast(targetDisabled ? `disabled ${t.token.text}` : `enabled ${t.token.text}`, 'ok', 1400);
      }
      return;
    }
    const step = stepValue();
    const wantsStep = action === 'w-minus' || action === 'w-plus';
    let fixedWeight = null;
    if (action === 'w-reset') fixedWeight = DEFAULT_WEIGHT;
    else if (!wantsStep && action.indexOf('w-') === 0) {
      const parsed = parseFloat(action.slice(2));
      if (!Number.isNaN(parsed)) fixedWeight = parsed;
    }
    if (wantsStep || fixedWeight != null) {
      const changes = tokens.map((token) => {
        const current = weightOf(token);
        const next = wantsStep
          ? (action === 'w-plus'
            ? Math.min(MAX_WEIGHT, Math.round((current + step) * 1000) / 1000)
            : Math.max(0, Math.round((current - step) * 1000) / 1000))
          : fixedWeight;
        return { from: token.from, to: token.to, insert: rebuild(token.token, next, token.token.disabled) };
      });
      if (multi) {
        applyEdit({ changes, caret: null });
      } else {
        applyEdit(replaceToken(docText, t, changes[0].insert));
      }
    }
  }

  /* ---------------------------------------------------------- desktop hotkeys */

  /** Ctrl+↑/↓ — weight step for the tokens at the cursor / inside the selection. */
  function adjustWeights(view, direction) {
    const selection = view.state.selection.main;
    const docText = view.state.doc.toString();
    const targets = selection.empty
      ? [tokenAt(docText, selection.head)].filter(Boolean)
      : tokensInRange(docText, selection.from, selection.to);
    if (!targets.length) return false;
    const step = stepValue();
    const changes = targets.map((t) => {
      const current = t.token.weight == null ? DEFAULT_WEIGHT : t.token.weight;
      const next = Math.min(MAX_WEIGHT, Math.max(0, Math.round((current + direction * step) * 1000) / 1000));
      return { from: t.from, to: t.to, insert: rebuild(t.token, next, t.token.disabled) };
    });
    selfEdit = true;
    try {
      view.dispatch({ changes, userEvent: 'pedit.weight' });
    } finally {
      selfEdit = false;
    }
    return true;
  }

  /** Ctrl+/ — toggle the comment on the line at the cursor. */
  function toggleCommentAtCursor(view) {
    const lineNumber = view.state.doc.lineAt(view.state.selection.main.head).number - 1;
    const plan = toggleCommentAt(view.state.doc.toString(), lineNumber);
    if (!plan || !plan.changes.length) return false;
    selfEdit = true;
    try {
      view.dispatch({ changes: plan.changes, userEvent: 'pedit.comment' });
    } finally {
      selfEdit = false;
    }
    return true;
  }

  const hotkeyEntries = desktopKeys
    ? [
      { key: 'Ctrl-ArrowUp', run: (viewA) => adjustWeights(viewA, 1), preventDefault: true },
      { key: 'Ctrl-ArrowDown', run: (viewA) => adjustWeights(viewA, -1), preventDefault: true },
      { key: 'Ctrl-/', run: toggleCommentAtCursor, preventDefault: true },
    ]
    : [];

  /* ---------------------------------------------------------- press / drag / tap */

  function resetPointer() {
    window.removeEventListener('pointermove', onPointerMove, true);
    window.removeEventListener('pointerup', onPointerUp, true);
    window.removeEventListener('pointercancel', onPointerCancel, true);
  }

  function cancelPress() {
    resetPointer();
    drag = null;
  }

  function onPointerDown(event) {
    if (event.button !== undefined && event.button !== 0) return; // right-click -> contextmenu
    // MOUSE: selection and caret stay fully native; the manipulation popup is
    // RIGHT-CLICK only (contextmenu).  Alt+drag still rearranges a keyword.
    // TOUCH: keep the tap-popup + drag-to-rearrange grammar.
    const isMouse = event.pointerType === 'mouse';
    if (isMouse && !event.altKey) return;
    if (popup) closePopup();
    if (!view.contentDOM.contains(event.target)) return;
    const token = tokenFromPoint(event.clientX, event.clientY);
    if (!token) return;
    drag = {
      token,
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      at: Date.now(),
      active: false,
      ghost: null,
      indicator: null,
      drop: null,
      allowTap: !isMouse,
    };
    window.addEventListener('pointermove', onPointerMove, true);
    window.addEventListener('pointerup', onPointerUp, true);
    window.addEventListener('pointercancel', onPointerCancel, true);
  }

  function onPointerMove(event) {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    if (!drag.active) {
      const distance = Math.hypot(dx, dy);
      if (distance < DRAG_THRESHOLD) return;
      if (Math.abs(dy) > Math.abs(dx) * 1.25) {
        cancelPress(); // clearly a scroll gesture — leave it to the browser
        return;
      }
      startDrag();
    }
    if (drag.active) {
      event.preventDefault();
      moveGhost(event.clientX, event.clientY);
      updateDropTarget(event.clientX, event.clientY);
    }
  }

  function startDrag() {
    drag.active = true;
    view.dom.classList.add('pedit-cm-dragging');
    drag.ghost = el('div', { class: 'pedit-cm-ghost', text: drag.token.text });
    drag.indicator = el('div', { class: 'pedit-cm-dropbar', hidden: true });
    document.body.append(drag.ghost, drag.indicator);
    const selection = window.getSelection();
    if (selection) selection.removeAllRanges();
    if (navigator.vibrate) navigator.vibrate(8);
  }

  function moveGhost(x, y) {
    if (!drag.ghost) return;
    drag.ghost.style.transform = `translate3d(${x + 12}px, ${y + 16}px, 0)`;
  }

  function updateDropTarget(x, y) {
    if (!drag.indicator) return;
    const pos = view.posAtCoords({ x, y });
    if (pos == null) {
      drag.drop = null;
      drag.indicator.hidden = true;
      return;
    }
    const snap = snapSlot(view.state.doc.toString(), pos);
    drag.drop = snap;
    const coords = view.coordsAtPos(snap.at);
    if (!coords) {
      drag.indicator.hidden = true;
      return;
    }
    drag.indicator.hidden = false;
    drag.indicator.style.left = `${Math.round(coords.left - 1)}px`;
    drag.indicator.style.top = `${Math.round(coords.top)}px`;
    drag.indicator.style.height = `${Math.max(18, Math.round(coords.bottom - coords.top))}px`;
  }

  function finishDrag() {
    const state = drag;
    drag = null;
    resetPointer();
    view.dom.classList.remove('pedit-cm-dragging');
    if (state.ghost) state.ghost.remove();
    if (state.indicator) state.indicator.remove();
    if (state.drop) {
      const docText = view.state.doc.toString();
      const plan = moveToken(docText, state.token, state.drop.line, state.drop.slot);
      if (plan && plan.changes.length) {
        selfEdit = true;
        try {
          view.dispatch({ changes: plan.changes, selection: { anchor: plan.caret }, userEvent: 'pedit.drag' });
        } finally {
          selfEdit = false;
        }
        // let the page settle a frame, then make sure the moved keyword is on screen
        requestAnimationFrame(() => {
          try {
            view.dispatch({ effects: EditorView.scrollIntoView(plan.caret, { y: 'center' }) });
          } catch (error) {
            void error;
          }
        });
      }
    }
  }

  function onPointerUp(event) {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const state = drag;
    if (state.active) {
      finishDrag();
      return;
    }
    cancelPress();
    const smallMove = Math.hypot(event.clientX - state.x, event.clientY - state.y) < DRAG_THRESHOLD;
    if (!smallMove || Date.now() - state.at > TAP_MAX_MS) return;
    if (!state.allowTap) return; // mouse + Alt was a rearrange-only gesture
    if (lastClosed && lastClosed.from === state.token.from && lastClosed.to === state.token.to && Date.now() - lastClosed.at < TAP_TOGGLE_MS) {
      lastClosed = null; // second tap on the same keyword: stay closed, keep the caret
      return;
    }
    openTokenPopup([state.token]);
  }

  function onPointerCancel(event) {
    if (!drag || event.pointerId !== drag.pointerId) return;
    if (drag.active) finishDrag();
    else cancelPress();
  }

  // stop touch scrolling while a drag is in flight (and for clearly horizontal
  // token gestures before the threshold), so the browser does not steal the gesture
  function onTouchMove(event) {
    if (!drag) return;
    if (drag.active) {
      event.preventDefault();
      return;
    }
    const touch = event.touches && event.touches[0];
    if (!touch) return;
    const dx = touch.clientX - drag.x;
    const dy = touch.clientY - drag.y;
    if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 6) event.preventDefault();
  }

  /* ------------------------------------------------------------ editor */

  const instance = {};

  const view = new EditorView({
    parent: dom,
    state: EditorState.create({
      doc: text,
      extensions: [
        history(),
        keymap.of([
          // Ctrl/Cmd+Enter is the app-wide "generate" shortcut (the desktop page's
          // script.js handles it on document level) - consume the key here so the
          // default keymap cannot insert a blank line into the prompt.
          { key: 'Mod-Enter', run: () => true },
          ...hotkeyEntries,
          ...closeBracketsKeymap,
          ...completionKeymap,
          ...defaultKeymap,
          ...historyKeymap,
          { key: 'Escape', run: () => { if (popup) { closePopup(); return true; } return false; } },
        ]),
        closeBrackets({ brackets: ['(', '['] }),
        autocompletion({
          override: [completionSource],
          activateOnTyping: true,
          closeOnBlur: true,
          maxRenderedOptions: 8,
          interactionDelay: 90,
        }),
        placeholderExt(placeholder),
        EditorView.lineWrapping,
        EditorView.contentAttributes.of({
          autocapitalize: 'off',
          autocorrect: 'off',
          spellcheck: 'false',
          enterkeyhint: 'enter',
        }),
        activeTokenField,
        decorationField,
        dropCursor(),
        EditorView.updateListener.of((update) => {
          if (!update.docChanged || applying) return;
          if (!selfEdit) closePopup();
          if (onChange) onChange(view.state.doc.toString());
        }),
        EditorView.domEventHandlers({
          contextmenu(event) {
            if (popup) {
              event.preventDefault();
              return true;
            }
            const targets = popupTargetsAt(event.clientX, event.clientY);
            if (!targets.length) return false;
            event.preventDefault();
            openTokenPopup(targets);
            return true;
          },
        }),
      ],
    }),
  });

  view.contentDOM.addEventListener('pointerdown', onPointerDown);
  view.dom.addEventListener('touchmove', onTouchMove, { passive: false });
  // scrolling moves the anchor out from under the popup — keep it glued (positionPopup
  // closes the popup itself when the anchor scrolls out of view).  Capture phase, so
  // scrolling of any ancestor (including the mobile keyboard shifting the page) counts.
  let scrollRaf = 0;
  const onAnyScroll = () => {
    if (!popup || scrollRaf) return;
    scrollRaf = requestAnimationFrame(() => {
      scrollRaf = 0;
      if (popup) positionPopup();
    });
  };
  window.addEventListener('scroll', onAnyScroll, { capture: true, passive: true });
  window.addEventListener('resize', onAnyScroll, { passive: true });

  Object.assign(instance, {
    view,
    getText: () => view.state.doc.toString(),
    setText(next) {
      const current = view.state.doc.toString();
      if (current === next) return;
      applying = true;
      try {
        view.dispatch({ changes: { from: 0, to: current.length, insert: next } });
      } finally {
        applying = false;
      }
    },
    focus: () => view.focus(),
    requestMeasure: () => view.requestMeasure(),
    closePopups: () => closePopup(),
    destroy() {
      destroyed = true;
      closePopup();
      window.removeEventListener('scroll', onAnyScroll, { capture: true });
      window.removeEventListener('resize', onAnyScroll);
      view.destroy();
      dom.remove();
    },
  });
  return instance;
}
