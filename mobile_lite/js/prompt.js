/**
 * Prompt card for the Mobile Lite UI.
 *
 * Chips editor ported from the desktop feature (`javascript/promptEditor.js`):
 *   - text is parsed into keyword chips (top-level commas separate them);
 *   - tap a chip        -> selects it and shows the action bar
 *   - action bar        -> weight -/+ (plus quick 0.8/1.1/1.2 and reset),
 *                          rename (✎), disable (#(word)), duplicate, delete
 *   - gutter button     -> comment / uncomment that line (the pipeline strips '# ' lines)
 *   - ＋ per line        -> inline keyword input with suggestions; on a line without
 *                          keywords it also offers '#—', which inserts a
 *                          '# --- name ---' block divider above the line
 *   - [⌨ Text] toggle   -> plain textarea mode (the textarea stays the source of truth);
 *                          the area grows with the content and ⤢ opens a fullscreen editor
 *
 * The MRU + endorsed keyword suggestions live in a fold that is COLLAPSED by default
 * (state.ui.suggestionsOpen persists the user's choice).
 */

import { api_ } from './api.js';
import { el, toast } from './ui.js';
import { on, persist, state } from './state.js';
import { DEFAULT_WEIGHT, blockBounds, blockIsOff, blockMarker, classify, formatWeight, joinSegments, rebuild, splitSegments, toggleBlockLines } from './prompt-parse.js';

const WEIGHT_STEP = 0.05;
const MAX_SUGGEST = 8;

let suggestionPool = null;
let suggestionPromise = null;

function loadSuggestions() {
  if (suggestionPromise) return suggestionPromise;
  suggestionPromise = api_.suggestions()
    .then((data) => {
      suggestionPool = { positive: data.prompt || [], negative: data.negative || [] };
      return suggestionPool;
    })
    .catch(() => {
      suggestionPool = { positive: [], negative: [] };
      return suggestionPool;
    });
  return suggestionPromise;
}

/* ------------------------------------------------------------------ chips field */

function createChipsField(key, placeholder, title) {
  const textarea = el('textarea', {
    class: 'pedit-textarea prompt-input',
    placeholder,
    rows: 3,
    autocapitalize: 'off',
    autocomplete: 'off',
    spellcheck: false,
  });
  textarea.value = state.prompt[key] || '';
  textarea.addEventListener('input', () => {
    state.prompt[key] = textarea.value;
    persist();
    fitTextarea();
  });

  const modeButton = el('button', { class: 'btn tiny', type: 'button' });
  const addLineButton = el('button', { class: 'btn tiny', type: 'button', text: '\uFF0B line', title: 'Add a line' });
  const offBadge = el('span', { class: 'small muted' });
  const head = el('div', { class: 'pedit-head' }, [modeButton, addLineButton, offBadge]);
  const body = el('div', { class: 'pedit-body' });
  const actions = el('div', { class: 'pedit-actions' });

  // text mode: the inline area grows with the content instead of scrolling inside 3 rows,
  // and ⤢ hands the text over to a fullscreen editor (the whole screen becomes the input)
  const expandButton = el('button', {
    class: 'pedit-expand',
    type: 'button',
    text: '\u2922',
    title: 'Open the fullscreen text editor',
  });
  const textWrap = el('div', { class: 'pedit-textarea-wrap' }, [textarea, expandButton]);

  const editorArea = el('textarea', {
    class: 'text-editor-area',
    autocomplete: 'off',
    autocapitalize: 'off',
    spellcheck: false,
  });
  const editorCount = el('span', { class: 'small muted' });
  const textEditor = el('div', { class: 'text-editor', hidden: true }, [
    el('div', { class: 'text-editor-head' }, [
      el('span', { class: 'text-editor-title', text: title }),
      el('button', { class: 'btn tiny', type: 'button', text: '\u2713 Done', onClick: () => closeTextEditor() }),
    ]),
    el('div', { class: 'text-editor-body' }, [editorArea]),
    el('div', { class: 'text-editor-foot' }, [editorCount]),
  ]);
  document.body.append(textEditor);

  const root = el('div', { class: 'pedit' }, [head, body, actions, textWrap]);

  const selection = { line: null, seg: null, adding: null, editing: null };
  const mode = () => (state.ui.peditMode === 'text' ? 'text' : 'chips');
  const value = () => textarea.value;
  const isNegative = key === 'textNegative' || key === 'imageNegative';

  function commit(text) {
    textarea.value = text;
    state.prompt[key] = text;
    persist();
    render();
  }

  /** Text mode: size the inline area to its content (the CSS gives it a 40vh floor). */
  function fitTextarea() {
    if (mode() !== 'text') {
      textarea.style.height = '';
      return;
    }
    if (!textarea.clientWidth) return; // hidden behind chips mode - nothing to measure yet
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.max(textarea.scrollHeight, 1)}px`;
  }

  function updateEditorCount() {
    const text = editorArea.value;
    const lines = text ? text.split('\n').length : 0;
    editorCount.textContent = `${lines} line${lines === 1 ? '' : 's'} \u00B7 ${text.length} chars`;
  }

  function openTextEditor() {
    editorArea.value = value();
    updateEditorCount();
    textEditor.hidden = false;
    document.body.classList.add('text-editing');
    editorArea.focus();
  }

  function closeTextEditor() {
    if (textEditor.hidden) return;
    textEditor.hidden = true;
    document.body.classList.remove('text-editing');
    render(); // the chips view picks up whatever was typed
  }

  // every keystroke is written through - iOS can drop the page at any moment
  editorArea.addEventListener('input', () => {
    textarea.value = editorArea.value;
    state.prompt[key] = editorArea.value;
    persist();
    updateEditorCount();
  });
  editorArea.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeTextEditor();
  });
  expandButton.addEventListener('click', () => openTextEditor());
  window.addEventListener('resize', fitTextarea);

  function tokenAt(line, seg) {
    if (line === null || seg === null || line === undefined || seg === undefined) return null;
    const lines = value().split('\n');
    if (line < 0 || line >= lines.length) return null;
    const segments = splitSegments(lines[line]);
    if (seg < 0 || seg >= segments.length) return null;
    const token = classify(segments[seg].body);
    token.line = line;
    token.seg = seg;
    return token;
  }

  function countDisabled() {
    let count = 0;
    value().split('\n').forEach((line) => {
      splitSegments(line).forEach((segment) => {
        if (classify(segment.body).disabled) count += 1;
      });
    });
    return count;
  }

  /* ---------------------------------------------------------------- rendering */

  function chipNode(line, seg, token) {
    const classes = ['pedit-chip'];
    if (token.disabled) classes.push('is-disabled');
    if (selection.line === line && selection.seg === seg) classes.push('is-selected');
    if (!token.text) classes.push('is-empty');

    const children = [];
    if (token.kind === 'angle') children.push(el('span', { class: 'pedit-chip-kind', text: '\u25C8' }));
    children.push(el('span', { class: 'pedit-chip-text', text: token.text || '\u2026' }));
    if (Math.abs((token.weight || DEFAULT_WEIGHT) - DEFAULT_WEIGHT) > 1e-9) {
      children.push(el('span', { class: 'pedit-chip-w', text: '\u00D7' + formatWeight(token.weight) }));
    }
    if (token.disabled) children.push(el('span', { class: 'pedit-chip-off', text: '\u26D4' }));

    return el('button', {
      class: classes.join(' '),
      type: 'button',
      dataset: { act: 'chip', line: String(line), seg: String(seg) },
      title: token.text,
    }, children);
  }

  function lineHasChips(lineIndex) {
    const line = value().split('\n')[lineIndex];
    if (line === undefined) return false;
    return splitSegments(line).some((segment) => segment.body.trim());
  }

  /**
   * Inline input row under a line, shared by "add keyword" and "rename keyword".
   * In add mode on a line without keywords it carries the '#\u2014' block-divider button.
   */
  function inputRowNode(line, kind, initial) {
    const input = el('input', {
      class: 'pedit-input',
      type: 'text',
      placeholder: kind === 'edit' ? 'rename keyword\u2026' : 'keyword\u2026',
      autocomplete: 'off',
      autocapitalize: 'off',
      spellcheck: false,
      enterkeyhint: 'done',
    });
    input.value = initial || '';
    const suggestions = el('div', { class: 'pedit-suggest' });
    const children = [input];
    if (kind === 'add' && !lineHasChips(line)) {
      children.push(el('button', {
        class: 'pedit-small-btn pedit-divider-btn',
        type: 'button',
        text: '#\u2014',
        title: "Insert a '# --- name ---' block divider above this line, using the text here as its name",
        dataset: { act: 'insert-divider', line: String(line) },
      }));
    }
    children.push(
      el('button', { class: 'pedit-small-btn', type: 'button', text: '\u2713', title: kind === 'edit' ? 'Apply' : 'Add', dataset: { act: 'insert-ok', line: String(line) } }),
      el('button', { class: 'pedit-small-btn', type: 'button', text: '\u2715', title: 'Cancel', dataset: { act: 'insert-cancel', line: String(line) } }),
      suggestions,
    );
    const node = el('div', { class: 'pedit-insert' + (kind === 'edit' ? ' is-edit' : ''), dataset: { line: String(line) } }, children);

    queueMicrotask(() => {
      const live = root.querySelector(`.pedit-insert[data-line="${line}"] .pedit-input`);
      if (!live) return;
      live.addEventListener('input', () => {
        if (kind === 'edit') {
          const seg = selection.editing ? selection.editing.seg : null;
          selection.editing = { line, seg, value: live.value };
        } else {
          selection.adding = { line, value: live.value };
        }
        updateSuggestionList(live.value);
      });
      live.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          commitInput();
        } else if (event.key === 'Escape') {
          cancelInput();
        }
      });
      live.focus();
      live.setSelectionRange(live.value.length, live.value.length);
      updateSuggestionList('');
    });
    return node;
  }

  function suggestionItems(query) {
    const pool = suggestionPool || { positive: [], negative: [] };
    const merged = [
      ...state.mruKeywords,
      ...(isNegative ? pool.negative : []),
      ...pool.positive,
    ];
    const needle = String(query || '').toLowerCase();
    const seen = new Set();
    const items = [];
    for (const keyword of merged) {
      const lowered = String(keyword).toLowerCase();
      if (seen.has(lowered)) continue;
      if (needle && !lowered.includes(needle)) continue;
      seen.add(lowered);
      items.push(keyword);
      if (items.length >= MAX_SUGGEST) break;
    }
    return items;
  }

  function updateSuggestionList(query) {
    const list = root.querySelector('.pedit-insert .pedit-suggest');
    if (!list) return;
    list.replaceChildren();
    for (const keyword of suggestionItems(query)) {
      list.append(el('button', {
        class: 'pedit-suggest-item',
        type: 'button',
        text: keyword,
        onClick: () => {
          const input = root.querySelector('.pedit-insert .pedit-input');
          if (input) input.value = keyword;
          commitInput();
        },
      }));
    }
  }

  function cancelInput() {
    selection.adding = null;
    selection.editing = null;
    render();
  }

  /** Commit whichever inline input is open (add keyword or rename keyword). */
  function commitInput() {
    const input = root.querySelector('.pedit-insert .pedit-input');
    const text = input ? input.value.trim() : '';
    if (selection.editing) {
      const target = selection.editing;
      selection.editing = null;
      renameKeyword(target.line, target.seg, text);
      return;
    }
    const line = selection.adding ? selection.adding.line : null;
    selection.adding = null;
    if (text && line !== null) insertKeyword(line, text);
    else render();
  }

  /** Replace a keyword's text, keeping its weight / disabled state / bracket kind. */
  function renameKeyword(lineIndex, segIndex, text) {
    if (!text || lineIndex === null || segIndex === null) {
      render();
      return;
    }
    const lines = value().split('\n');
    if (lineIndex < 0 || lineIndex >= lines.length) {
      render();
      return;
    }
    const segments = splitSegments(lines[lineIndex]);
    const segment = segments[segIndex];
    if (!segment) {
      render();
      return;
    }
    const token = classify(segment.body);
    segment.body = rebuild({ kind: token.kind, text }, token.weight || DEFAULT_WEIGHT, token.disabled);
    lines[lineIndex] = joinSegments(segments);
    commit(lines.join('\n'));
  }

  /** Insert a '# --- name ---' divider above `lineIndex`, then keep adding on that line. */
  function insertDivider(lineIndex) {
    const input = root.querySelector('.pedit-insert .pedit-input');
    const name = input ? input.value.trim() : '';
    selection.adding = null;
    selection.editing = null;
    const lines = value().split('\n');
    if (lineIndex === null || lineIndex === undefined || lineIndex < 0 || lineIndex > lines.length) {
      render();
      return;
    }
    lines.splice(lineIndex, 0, blockMarker(name));
    commit(lines.join('\n'));
    openAdd(lineIndex + 1);
  }

  function insertKeyword(lineIndex, keyword) {
    if (lineIndex === null || lineIndex === undefined) return;
    const lines = value().split('\n');
    if (lineIndex < 0 || lineIndex >= lines.length) return;
    const segments = splitSegments(lines[lineIndex]);
    const last = segments[segments.length - 1];
    if (last && !last.body.trim()) {
      last.body = keyword;
    } else {
      if (last && !/,\s*$/.test(last.tail || '')) last.tail = (last.tail || '') + ', ';
      segments.push({ lead: '', body: keyword, tail: '' });
    }
    lines[lineIndex] = joinSegments(segments);
    commit(lines.join('\n'));
  }

  function lineNode(lineText, index, lines) {
    const commented = /^\s*#(?!\()/.test(lineText);
    // a commented line shows its keywords without the leading '# ' - the gutter carries state
    const content = commented ? lineText.replace(/^(\s*)#\s?/, '$1') : lineText;
    const segments = splitSegments(content);

    const chipsRow = el('div', { class: 'pedit-chips' });
    // '# --- ...' opens a block up to the next '# ---' line: one tap comments/uncomments it
    const bounds = blockBounds(lines, index);
    if (bounds) {
      const off = blockIsOff(lines, bounds.from, bounds.to);
      chipsRow.append(el('button', {
        class: 'pedit-gutter pedit-block-toggle' + (off ? ' is-off' : ''),
        type: 'button',
        text: off ? '\u23F8' : '\u25B6',
        title: off
          ? `Turn this block back on (${bounds.to - bounds.from} line(s))`
          : `Turn off this block until the next '#' block marker (${bounds.to - bounds.from} line(s))`,
        dataset: { act: 'block', line: String(index) },
        onClick: () => toggleBlockComment(index),
      }));
    }
    segments.forEach((segment, segIndex) => {
      if (!segment.body.trim()) {
        if (segIndex < segments.length - 1) chipsRow.append(el('span', { class: 'pedit-sep', text: ',' }));
        return;
      }
      chipsRow.append(chipNode(index, segIndex, classify(segment.body)));
    });
    chipsRow.append(el('button', {
      class: 'pedit-add',
      type: 'button',
      text: '\uFF0B',
      title: 'Add a keyword to this line',
      dataset: { act: 'add', line: String(index) },
    }));

    const main = el('div', { class: 'pedit-line-main' }, [chipsRow]);
    if (selection.adding && selection.adding.line === index) main.append(inputRowNode(index, 'add', selection.adding.value));
    else if (selection.editing && selection.editing.line === index) main.append(inputRowNode(index, 'edit', selection.editing.value));

    return el('div', { class: 'pedit-line' + (commented ? ' is-comment' : '') }, [
      el('button', {
        class: 'pedit-gutter' + (commented ? ' is-comment' : ''),
        type: 'button',
        text: commented ? '\u23F8' : '\u{1F4AC}',
        title: commented ? 'Uncomment this line' : 'Comment this line (stripped when generating)',
        dataset: { act: 'comment', line: String(index) },
      }),
      main,
    ]);
  }

  function actionsChildren() {
    const token = tokenAt(selection.line, selection.seg);
    if (!token || !token.text) return [];
    const current = token.weight || DEFAULT_WEIGHT;
    const make = (act, label, extra = {}) => el('button', {
      class: 'pedit-act' + (extra.on ? ' is-on' : ''),
      type: 'button',
      text: label,
      title: extra.title || '',
      dataset: { act },
    });

    return [
      el('span', { class: 'pedit-actions-sel', text: token.text }),
      make('edit', '\u270E', { title: 'Rename this keyword' }),
      make('w-minus', '\u2212', { title: `Lower weight by ${WEIGHT_STEP}` }),
      el('span', { class: 'pedit-weight', text: formatWeight(current) }),
      make('w-plus', '\uFF0B', { title: `Raise weight by ${WEIGHT_STEP}` }),
      make('w-0.8', '0.8'),
      make('w-1.1', '1.1'),
      make('w-1.2', '1.2'),
      make('reset', '\u27F2 1.0', { title: 'Back to weight 1 (brackets removed)' }),
      make('toggle-off', token.disabled ? '\u2705' : '\u26D4', {
        on: token.disabled,
        title: token.disabled ? 'Enable this keyword' : 'Disable (stripped when generating)',
      }),
      make('duplicate', '\u2398', { title: 'Duplicate' }),
      make('delete', '\u{1F5D1}', { title: 'Delete' }),
      make('close', '\u2715', { title: 'Close' }),
    ];
  }

  function render() {
    root.classList.toggle('pedit-mode-chips', mode() === 'chips');
    root.classList.toggle('pedit-mode-text', mode() === 'text');
    modeButton.textContent = mode() === 'chips' ? '\u2328 Text' : '\u270E Chips';
    const disabled = countDisabled();
    offBadge.textContent = disabled ? `${disabled} off` : '';

    if (mode() === 'text') {
      body.replaceChildren();
      actions.replaceChildren();
      queueMicrotask(fitTextarea);
      return;
    }

    const lines = value().split('\n');
    body.replaceChildren(...lines.map((line, index) => lineNode(line, index, lines)));
    if (!value().trim()) {
      body.append(el('div', {
        class: 'pedit-empty small muted',
        text: 'Empty - tap \u2328 Text to type, or add keywords with \uFF0B or the suggestions below.',
      }));
    }
    actions.replaceChildren(...actionsChildren());
  }

  /* ---------------------------------------------------------------- operations */

  function applyChipAction(action) {
    const token = tokenAt(selection.line, selection.seg);
    if (!token) return;
    const current = token.weight || DEFAULT_WEIGHT;

    const write = (body) => {
      const lines = value().split('\n');
      const segments = splitSegments(lines[selection.line]);
      segments[selection.seg].body = body;
      lines[selection.line] = joinSegments(segments);
      commit(lines.join('\n'));
    };

    switch (action) {
      case 'edit':
        selection.adding = null;
        selection.editing = { line: selection.line, seg: selection.seg, value: token.text };
        render();
        break;
      case 'w-plus':
        write(rebuild(token, Math.round((current + WEIGHT_STEP) * 1000) / 1000, token.disabled));
        break;
      case 'w-minus':
        write(rebuild(token, Math.max(0, Math.round((current - WEIGHT_STEP) * 1000) / 1000), token.disabled));
        break;
      case 'reset':
        write(rebuild(token, DEFAULT_WEIGHT, token.disabled));
        break;
      case 'toggle-off':
        write(rebuild(token, current, !token.disabled));
        break;
      case 'duplicate': {
        const lines = value().split('\n');
        const segments = splitSegments(lines[selection.line]);
        const original = segments[selection.seg];
        if (!/,\s*$/.test(original.tail || '')) original.tail = (original.tail || '') + ', ';
        segments.splice(selection.seg + 1, 0, { lead: '', body: original.body, tail: '' });
        lines[selection.line] = joinSegments(segments);
        selection.seg += 1;
        commit(lines.join('\n'));
        break;
      }
      case 'delete': {
        const lines = value().split('\n');
        const segments = splitSegments(lines[selection.line]);
        segments.splice(selection.seg, 1);
        if (!segments.length) segments.push({ lead: '', body: '', tail: '' });
        lines[selection.line] = joinSegments(segments);
        const wasLastLine = selection.line === lines.length - 1;
        selection.line = null;
        selection.seg = null;
        if (wasLastLine && lines.length > 1 && !lines[lines.length - 1].trim()) lines.pop();
        commit(lines.join('\n'));
        break;
      }
      case 'close':
        selection.line = null;
        selection.seg = null;
        render();
        break;
      default:
        if (action.indexOf('w-') === 0) {
          const weight = parseFloat(action.slice(2));
          if (!Number.isNaN(weight)) write(rebuild(token, weight, token.disabled));
        }
        break;
    }
  }

  function toggleLineComment(lineIndex) {
    if (lineIndex === null || lineIndex === undefined) return;
    const lines = value().split('\n');
    if (lineIndex < 0 || lineIndex >= lines.length) return;
    const line = lines[lineIndex];
    const trimmed = line.replace(/^\s+/, '');
    const indent = line.slice(0, line.length - trimmed.length);
    if (/^#(?!\()/.test(trimmed)) {
      lines[lineIndex] = indent + trimmed.slice(1).replace(/^ /, '');
    } else if (trimmed !== '') {
      lines[lineIndex] = indent + '# ' + trimmed;
    }
    commit(lines.join('\n'));
  }

  /** Comment / uncomment a whole '# ---' block (same semantics as the desktop overlay). */
  function toggleBlockComment(lineIndex) {
    if (lineIndex === null || lineIndex === undefined) return;
    const lines = value().split('\n');
    const next = toggleBlockLines(lines, lineIndex);
    if (next !== lines) commit(next.join('\n'));
  }

  function openAdd(lineIndex) {
    selection.adding = { line: lineIndex, value: '' };
    selection.editing = null;
    selection.line = null;
    selection.seg = null;
    render();
    loadSuggestions().then(() => updateSuggestionList(''));
  }

  root.addEventListener('click', (event) => {
    const target = event.target.closest('[data-act]');
    if (!target || !root.contains(target)) return;
    const action = target.dataset.act;
    const line = target.dataset.line === undefined ? null : Number(target.dataset.line);
    const seg = target.dataset.seg === undefined ? null : Number(target.dataset.seg);

    if (action === 'chip') {
      selection.adding = null;
      selection.editing = null;
      selection.line = line;
      selection.seg = seg;
      render();
      return;
    }
    if (action === 'comment') { toggleLineComment(line); return; }
    if (action === 'add') { openAdd(line); return; }
    if (action === 'insert-ok') { commitInput(); return; }
    if (action === 'insert-cancel') { cancelInput(); return; }
    if (action === 'insert-divider') { insertDivider(line); return; }
    if (action === 'use-suggest') return; // the suggestion buttons commit themselves
    applyChipAction(action);
  });

  modeButton.addEventListener('click', () => {
    state.ui.peditMode = mode() === 'chips' ? 'text' : 'chips';
    persist();
    render();
  });

  addLineButton.addEventListener('click', () => {
    const next = value().replace(/\n*$/, '') + '\n';
    textarea.value = next;
    state.prompt[key] = next;
    persist();
    render();
    openAdd(next.split('\n').length - 1);
  });

  render();
  loadSuggestions().then(() => render());

  return {
    root,
    get value() { return value(); },
    set value(text) {
      const next = text == null ? '' : String(text);
      if (next === textarea.value) return;
      textarea.value = next;
      state.prompt[key] = next;
      persist();
      render();
    },
    onHide() {
      closeTextEditor();
    },
    appendKeyword(keyword) {
      const current = value().replace(/\s+$/, '');
      const lowered = keyword.toLowerCase();
      if (current.toLowerCase().split(',').map((part) => part.trim()).includes(lowered)) {
        toast('already in the prompt', 'warn', 1400);
        return;
      }
      commit(current ? `${current}, ${keyword}` : keyword);
    },
  };
}

/* ------------------------------------------------------------------ suggestions fold */

function createSuggestionsFold(field) {
  const chips = el('div', { class: 'chips' });
  const details = el('details', { class: 'fold suggestions-fold' });
  if (state.ui.suggestionsOpen) details.setAttribute('open', '');
  details.append(el('summary', { class: 'fold-summary' }, [
    el('span', { text: '\u2728 Suggestions' }),
    el('span', { class: 'small muted', text: 'tap a keyword to append it' }),
  ]));
  details.append(chips);
  details.addEventListener('toggle', () => {
    state.ui.suggestionsOpen = details.open;
    persist();
  });

  function renderChips() {
    chips.replaceChildren();
    const seen = new Set();
    const add = (keyword, mru) => {
      const lowered = String(keyword).toLowerCase();
      if (seen.has(lowered)) return;
      seen.add(lowered);
      chips.append(el('button', {
        class: `chip ${mru ? 'mru' : ''}`,
        type: 'button',
        text: keyword,
        onClick: () => field.appendKeyword(keyword),
      }));
    };
    state.mruKeywords.slice(0, 8).forEach((keyword) => add(keyword, true));
    (suggestionPool ? suggestionPool.positive : []).slice(0, 24).forEach((keyword) => add(keyword, false));
  }

  on('mru', renderChips);
  loadSuggestions().then(renderChips);
  renderChips();
  return details;
}

/* ------------------------------------------------------------------ public API */

export function createPromptEditor(kind) {
  const positiveKey = kind === 'text' ? 'text' : 'image';
  const negativeKey = `${positiveKey}Negative`;

  const positiveField = createChipsField(positiveKey, 'Prompt', 'Prompt');
  const negativeField = createChipsField(negativeKey, 'Negative prompt', 'Negative prompt');
  const suggestionsFold = createSuggestionsFold(positiveField);

  const negativeFold = el('details', { class: 'fold negative-fold' }, [
    el('summary', { class: 'fold-summary' }, [el('span', { text: 'Negative prompt' })]),
    negativeField.root,
  ]);

  const root = el('div', { class: 'card pedit-card' }, [positiveField.root, suggestionsFold, negativeFold]);

  return {
    root,
    get positive() { return positiveField.value; },
    get negative() { return negativeField.value; },
    set positive(text) { positiveField.value = text; },
    set negative(text) { negativeField.value = text; },
    onHide() {
      positiveField.onHide();
      negativeField.onHide();
    },
  };
}
