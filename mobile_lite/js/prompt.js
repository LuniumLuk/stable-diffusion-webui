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
 *   - long lines       -> folded to one row by default ('▸N' expands them again)
 *   - ⚖ per line        -> weight for the WHOLE line (wraps it in '(…:w)'; 1.0 unwraps)
 *   - [⌨ Text] toggle   -> CodeMirror 6 text mode (prompt-cm.js; the hidden textarea stays
 *                          the value store + fallback): inline keyword suggestions while
 *                          typing, `#` comment styling, tap-a-keyword quick actions
 *                          (weight / ⛔ / 💬 / move / delete) and drag-to-rearrange;
 *                          ⤢ opens a fullscreen copy of the same editor
 *
 * The MRU + endorsed keyword suggestions live in a fold that is COLLAPSED by default
 * (state.ui.suggestionsOpen persists the user's choice).
 */

import { api_ } from './api.js';
import { el, toast } from './ui.js';
import { on, persist, state } from './state.js';
import { createPromptCM } from './prompt-cm.js';
import { DEFAULT_WEIGHT, applyLineWeight, blockBounds, blockIsOff, blockMarker, classify, formatWeight, joinSegments, parseLineWeight, rebuild, splitSegments, toggleBlockLines } from './prompt-parse.js';

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
  // the text-mode CodeMirror instances mount here lazily (the textarea stays as the
  // fallback and as the value store every other code path keeps using)
  const cmHost = el('div', { class: 'pedit-cm-host' });
  const textWrap = el('div', { class: 'pedit-textarea-wrap' }, [textarea, cmHost, expandButton]);

  const editorArea = el('textarea', {
    class: 'text-editor-area',
    autocomplete: 'off',
    autocapitalize: 'off',
    spellcheck: false,
  });
  const cmFullHost = el('div', { class: 'pedit-cm-host pedit-cm-host-full' });
  const editorCount = el('span', { class: 'small muted' });
  const textEditor = el('div', { class: 'text-editor', hidden: true }, [
    el('div', { class: 'text-editor-head' }, [
      el('span', { class: 'text-editor-title', text: title }),
      el('button', { class: 'btn tiny', type: 'button', text: '\u2713 Done', onClick: () => closeTextEditor() }),
    ]),
    el('div', { class: 'text-editor-body' }, [editorArea, cmFullHost]),
    el('div', { class: 'text-editor-foot' }, [editorCount]),
  ]);
  document.body.append(textEditor);

  const root = el('div', { class: 'pedit' }, [head, body, actions, textWrap]);

  const selection = { line: null, seg: null, adding: null, editing: null, lineWeight: null };
  // lines the user unfolded again (folded is the default; index-based, transient state)
  const expandedLines = new Set();
  // last chip tap - a second tap on the same chip within the window toggles disabled
  const chipTap = { line: null, seg: null, at: 0 };
  const DOUBLE_TAP_MS = 350;
  const LINE_WEIGHT_MAX = 10;
  const mode = () => (state.ui.peditMode === 'text' ? 'text' : 'chips');
  const value = () => textarea.value;
  const isNegative = key === 'textNegative' || key === 'imageNegative';

  /* CodeMirror mounts (prompt-cm.js): the textarea remains the value store and the
     fallback — the CM views are synced from it on every external write and push their
     edits back through onCmInput.  Both mount lazily: the inline one when text mode is
     first shown, the fullscreen one when the ⤢ overlay is first opened. */
  let cm = null;
  let cmFull = null;
  let cmStarted = false;
  let cmFullStarted = false;

  function syncCmViews() {
    if (cm && cm.getText() !== textarea.value) cm.setText(textarea.value);
    if (cmFull && cmFull.getText() !== textarea.value) cmFull.setText(textarea.value);
    if (editorArea.value !== textarea.value) editorArea.value = textarea.value;
  }

  function onCmInput(text) {
    if (text === textarea.value) return; // echo of an external sync
    textarea.value = text;
    state.prompt[key] = text;
    persist();
    if (editorArea.value !== text) {
      editorArea.value = text;
      updateEditorCount();
    }
    const off = countDisabled();
    offBadge.textContent = off ? `${off} off` : '';
    if (cm && cm.getText() !== text) cm.setText(text);
    if (cmFull && cmFull.getText() !== text) cmFull.setText(text);
  }

  function ensureCM() {
    if (cmStarted) return;
    cmStarted = true;
    createPromptCM({
      host: cmHost,
      text: value(),
      placeholder,
      variant: 'inline',
      getSuggestions: suggestionItems,
      onChange: onCmInput,
    }).then((instance) => {
      cm = instance;
      textWrap.classList.add('pedit-has-cm');
      queueMicrotask(() => cm.requestMeasure());
    }).catch(() => {
      cmStarted = false; // bundle unavailable — keep the plain textarea
    });
  }

  function ensureCMFull() {
    if (cmFullStarted) return;
    cmFullStarted = true;
    createPromptCM({
      host: cmFullHost,
      text: value(),
      placeholder,
      variant: 'full',
      getSuggestions: suggestionItems,
      onChange: onCmInput,
    }).then((instance) => {
      cmFull = instance;
      textEditor.classList.add('pedit-has-cm');
      if (!textEditor.hidden) {
        queueMicrotask(() => {
          cmFull.setText(value());
          cmFull.requestMeasure();
          cmFull.focus();
        });
      }
    }).catch(() => {
      cmFullStarted = false;
    });
  }

  const isCommentedLine = (text) => /^\s*#(?!\()/.test(text);
  const stripLineComment = (text) => text.replace(/^(\s*)#\s?/, '$1');

  /** Line text as the chips view sees it: comment stripped, line weight unwrapped. */
  function displayContent(rawLine) {
    const stripped = isCommentedLine(rawLine) ? stripLineComment(rawLine) : rawLine;
    const lineWeight = parseLineWeight(stripped);
    return lineWeight ? lineWeight.inner : stripped;
  }

  /** Split a raw line into its untouched prefix (indent + comment marker) and its content. */
  function lineParts(rawLine) {
    const text = String(rawLine == null ? '' : rawLine);
    const indent = text.slice(0, text.length - text.trimStart().length);
    const rest = text.slice(indent.length);
    if (/^#(?!\()/.test(rest)) {
      const marker = rest.startsWith('# ') ? '# ' : '#';
      return { prefix: indent + marker, content: rest.slice(marker.length) };
    }
    return { prefix: indent, content: rest };
  }

  /** Write a line's content back, re-applying the line-weight group when one exists. */
  function writeLineContent(lines, lineIndex, contentText) {
    const { prefix, content } = lineParts(lines[lineIndex]);
    const lineWeight = parseLineWeight(content);
    lines[lineIndex] = prefix + applyLineWeight(contentText, lineWeight ? lineWeight.weight : null);
    return lines;
  }

  function commit(text) {
    textarea.value = text;
    state.prompt[key] = text;
    persist();
    syncCmViews();
    render();
  }

  /** Text mode: size the inline area to its content (the CSS gives it a 40vh floor). */
  function fitTextarea() {
    if (cm) return; // CodeMirror measures itself
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
    ensureCMFull();
    if (cmFull) {
      cmFull.setText(value());
      queueMicrotask(() => {
        cmFull.requestMeasure();
        cmFull.focus();
      });
    } else {
      editorArea.focus();
    }
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
    const segments = splitSegments(displayContent(lines[line]));
    if (seg < 0 || seg >= segments.length) return null;
    const token = classify(segments[seg].body);
    token.line = line;
    token.seg = seg;
    return token;
  }

  function countDisabled() {
    let count = 0;
    value().split('\n').forEach((line) => {
      splitSegments(displayContent(line)).forEach((segment) => {
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
    return splitSegments(displayContent(line)).some((segment) => segment.body.trim());
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
    const segments = splitSegments(displayContent(lines[lineIndex]));
    const segment = segments[segIndex];
    if (!segment) {
      render();
      return;
    }
    const token = classify(segment.body);
    segment.body = rebuild({ kind: token.kind, text }, token.weight || DEFAULT_WEIGHT, token.disabled);
    writeLineContent(lines, lineIndex, joinSegments(segments));
    expandedLines.add(lineIndex);
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
    const segments = splitSegments(displayContent(lines[lineIndex]));
    const last = segments[segments.length - 1];
    if (last && !last.body.trim()) {
      last.body = keyword;
    } else {
      if (last && !/,\s*$/.test(last.tail || '')) last.tail = (last.tail || '') + ', ';
      segments.push({ lead: '', body: keyword, tail: '' });
    }
    writeLineContent(lines, lineIndex, joinSegments(segments));
    expandedLines.add(lineIndex);
    commit(lines.join('\n'));
  }

  function lineNode(lineText, index, lines) {
    const commented = isCommentedLine(lineText);
    // a commented line shows its keywords without the leading '# ' - the gutter carries state;
    // displayContent also unwraps a line-weight group so per-keyword chips stay editable
    const content = displayContent(lineText);
    const lineWeight = commented ? null : parseLineWeight(lineText);
    const segments = splitSegments(content);

    const row = el('div', { class: 'pedit-row' });
    // '# --- ...' opens a block up to the next '# ---' line: one tap comments/uncomments it
    const bounds = blockBounds(lines, index);
    if (bounds) {
      const off = blockIsOff(lines, bounds.from, bounds.to);
      row.append(el('button', {
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
    // a folded line keeps one chip row that slides horizontally - the buttons stay reachable
    const chips = el('div', { class: 'pedit-chips' });
    segments.forEach((segment, segIndex) => {
      if (!segment.body.trim()) {
        if (segIndex < segments.length - 1) chips.append(el('span', { class: 'pedit-sep', text: ',' }));
        return;
      }
      chips.append(chipNode(index, segIndex, classify(segment.body)));
    });
    row.append(chips);
    row.append(el('span', { class: 'pedit-fold-slot' }));
    row.append(el('button', {
      class: 'pedit-add',
      type: 'button',
      text: '\uFF0B',
      title: 'Add a keyword to this line',
      dataset: { act: 'add', line: String(index) },
    }));
    if (!commented && content.trim()) {
      row.append(el('button', {
        class: 'pedit-line-weight' + (lineWeight ? ' is-on' : ''),
        type: 'button',
        text: lineWeight ? `\u00D7${formatWeight(lineWeight.weight)}` : '\u2696',
        title: lineWeight
          ? `Line weight \u00D7${formatWeight(lineWeight.weight)} - adjust the weight of the whole line`
          : 'Set a weight for the whole line',
        dataset: { act: 'line-weight', line: String(index) },
      }));
    }

    const main = el('div', { class: 'pedit-line-main' }, [row]);
    if (selection.adding && selection.adding.line === index) main.append(inputRowNode(index, 'add', selection.adding.value));
    else if (selection.editing && selection.editing.line === index) main.append(inputRowNode(index, 'edit', selection.editing.value));
    else if (selection.lineWeight && selection.lineWeight.line === index) main.append(lineWeightRowNode(index));

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

  /* ---------------------------------------------------------------- line fold + weight */

  /** Folded lines show one chip row; the fold button expands/collapses a single line. */
  function toggleFold(lineIndex) {
    if (lineIndex === null || lineIndex === undefined) return;
    if (expandedLines.has(lineIndex)) expandedLines.delete(lineIndex);
    else expandedLines.add(lineIndex);
    render();
  }

  /**
   * `body.replaceChildren` briefly empties the scroll container, which resets `.pedit-body`
   * scrollTop to 0 on WebKit/Blink - the editor would jump to the top on every render
   * (chip tap, fold, weight change). Remember the first visible line and put it back after
   * the re-render + fold pass (same frame, before paint).
   */
  function captureScrollAnchor() {
    if (mode() !== 'chips' || !body.clientHeight) return null;
    const viewTop = body.getBoundingClientRect().top;
    const nodes = body.querySelectorAll('.pedit-line');
    for (let index = 0; index < nodes.length; index += 1) {
      const rect = nodes[index].getBoundingClientRect();
      if (rect.bottom > viewTop + 1) return { index, top: rect.top };
    }
    return null;
  }

  function restoreScrollAnchor(anchor) {
    if (!anchor || mode() !== 'chips') return;
    const node = body.querySelectorAll('.pedit-line')[anchor.index];
    if (!node) return;
    let delta = node.getBoundingClientRect().top - anchor.top;
    if (Math.abs(delta) < 1) return;
    // let every scrollable ancestor absorb the delta (editor body, then the page body)
    let scrollable = node.parentElement;
    while (scrollable && Math.abs(delta) >= 1) {
      const style = getComputedStyle(scrollable);
      if (/(auto|scroll)/.test(style.overflowY) && scrollable.scrollHeight > scrollable.clientHeight + 1) {
        const before = scrollable.scrollTop;
        scrollable.scrollTop = before + delta;
        delta -= scrollable.scrollTop - before;
      }
      scrollable = scrollable.parentElement;
    }
    if (Math.abs(delta) >= 1) window.scrollBy(0, delta);
  }

  /**
   * Fold every line that wraps to more than one row. Folded = a hard single chip row
   * (`.is-folded` forces nowrap + horizontal slide). Measured after each render, so the
   * '+N' badge is only offered when something is actually hidden; runs in a microtask (the
   * fresh DOM can be measured then). Screens that are hidden (0 wide) are skipped - their
   * `onShow` calls relayout().
   */
  function applyFolds() {
    if (mode() !== 'chips' || !root.clientWidth) return;
    root.querySelectorAll('.pedit-line').forEach((lineElement, index) => {
      const slot = lineElement.querySelector('.pedit-fold-slot');
      const wrap = lineElement.querySelector('.pedit-chips');
      if (slot) slot.replaceChildren();
      if (wrap) {
        wrap.classList.remove('is-folded');
        wrap.style.maxHeight = '';
      }
      if (!wrap || !slot) return;
      const chipNodes = Array.from(wrap.querySelectorAll('.pedit-chip'));
      if (chipNodes.length < 2) return;
      // group chips by visual row through their vertical centres (works with mixed heights)
      const centers = chipNodes.map((chip) => {
        const rect = chip.getBoundingClientRect();
        return rect.top + rect.height / 2;
      });
      const hiddenCount = centers.filter((center) => Math.abs(center - centers[0]) > 2).length;
      if (!hiddenCount) return; // fits on one row - nothing to fold
      const expanded = expandedLines.has(index);
      slot.append(el('button', {
        class: 'pedit-fold',
        type: 'button',
        text: expanded ? '\u25BE' : `\u25B8${hiddenCount}`,
        title: expanded ? 'Fold this line back to one row' : `Show ${hiddenCount} more keyword(s)`,
        dataset: { act: 'fold', line: String(index) },
      }));
      if (!expanded) wrap.classList.add('is-folded');
    });
  }

  /** Inline editor for the line weight: stepper + quick values; changes apply immediately. */
  function lineWeightRowNode(lineIndex) {
    const current = selection.lineWeight ? selection.lineWeight.weight : 1.1;
    const button = (act, label, extra = {}) => el('button', {
      class: 'pedit-small-btn' + (extra.on ? ' is-on' : ''),
      type: 'button',
      text: label,
      title: extra.title || '',
      dataset: extra.weight === undefined
        ? { act, line: String(lineIndex) }
        : { act, line: String(lineIndex), weight: formatWeight(extra.weight) },
    });
    return el('div', { class: 'pedit-insert is-weight', dataset: { line: String(lineIndex) } }, [
      el('span', { class: 'small muted', text: '\u2696 line weight' }),
      button('lw-minus', '\u2212', { title: `Lower by ${WEIGHT_STEP}` }),
      el('span', { class: 'pedit-weight', text: formatWeight(current) }),
      button('lw-plus', '\uFF0B', { title: `Raise by ${WEIGHT_STEP}` }),
      ...[0.8, 1.0, 1.1, 1.2, 1.5].map((weight) => button('lw-set', formatWeight(weight), {
        weight,
        on: Math.abs(weight - current) < 1e-9,
        title: weight === 1.0 ? 'Remove the line weight' : `Set the line weight to ${formatWeight(weight)}`,
      })),
      button('lw-close', '\u2713', { title: 'Done' }),
    ]);
  }

  function openLineWeight(lineIndex) {
    const lines = value().split('\n');
    if (lineIndex < 0 || lineIndex >= lines.length) return;
    const { content } = lineParts(lines[lineIndex]);
    const lineWeight = parseLineWeight(content);
    selection.adding = null;
    selection.editing = null;
    selection.lineWeight = { line: lineIndex, weight: lineWeight ? lineWeight.weight : 1.1 };
    render();
  }

  /** Wrap/unwrap the whole line; the row stays open so the stepper can be tapped again. */
  function applyLineWeightValue(lineIndex, weight) {
    const lines = value().split('\n');
    if (lineIndex < 0 || lineIndex >= lines.length) return;
    const { prefix, content } = lineParts(lines[lineIndex]);
    lines[lineIndex] = prefix + applyLineWeight(content, weight);
    if (selection.lineWeight && selection.lineWeight.line === lineIndex) selection.lineWeight.weight = weight;
    expandedLines.add(lineIndex);
    commit(lines.join('\n'));
  }

  function stepLineWeight(lineIndex, delta) {
    const current = selection.lineWeight && selection.lineWeight.line === lineIndex
      ? selection.lineWeight.weight
      : 1.1;
    const next = Math.min(LINE_WEIGHT_MAX, Math.max(0.05, Math.round((current + delta) * 1000) / 1000));
    applyLineWeightValue(lineIndex, next);
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
      ensureCM();
      body.replaceChildren();
      actions.replaceChildren();
      queueMicrotask(() => {
        fitTextarea();
        if (cm) cm.requestMeasure();
      });
      return;
    }

    const lines = value().split('\n');
    const anchor = captureScrollAnchor();
    body.replaceChildren(...lines.map((line, index) => lineNode(line, index, lines)));
    queueMicrotask(() => { applyFolds(); restoreScrollAnchor(anchor); });
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
      const segments = splitSegments(displayContent(lines[selection.line]));
      segments[selection.seg].body = body;
      writeLineContent(lines, selection.line, joinSegments(segments));
      expandedLines.add(selection.line);
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
        const segments = splitSegments(displayContent(lines[selection.line]));
        const original = segments[selection.seg];
        if (!/,\s*$/.test(original.tail || '')) original.tail = (original.tail || '') + ', ';
        segments.splice(selection.seg + 1, 0, { lead: '', body: original.body, tail: '' });
        writeLineContent(lines, selection.line, joinSegments(segments));
        expandedLines.add(selection.line);
        selection.seg += 1;
        commit(lines.join('\n'));
        break;
      }
      case 'delete': {
        const lines = value().split('\n');
        const segments = splitSegments(displayContent(lines[selection.line]));
        segments.splice(selection.seg, 1);
        if (!segments.length) segments.push({ lead: '', body: '', tail: '' });
        writeLineContent(lines, selection.line, joinSegments(segments));
        expandedLines.add(selection.line);
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
    selection.lineWeight = null;
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
    if (action !== 'chip') {
      // any other action breaks a pending double-tap sequence
      chipTap.line = null;
      chipTap.seg = null;
    }

    if (action === 'chip') {
      // a second tap on the same chip within the window toggles disabled (#(...) form)
      const now = Date.now();
      const isDouble = chipTap.line === line && chipTap.seg === seg && now - chipTap.at < DOUBLE_TAP_MS;
      chipTap.line = line;
      chipTap.seg = seg;
      chipTap.at = now;
      selection.adding = null;
      selection.editing = null;
      selection.lineWeight = null;
      selection.line = line;
      selection.seg = seg;
      if (isDouble) {
        const token = tokenAt(line, seg);
        if (token) {
          applyChipAction('toggle-off');
          toast(token.disabled ? `enabled ${token.text}` : `disabled ${token.text}`, 'ok', 1400);
          // start a fresh sequence - the next tap must not pair with the toggle
          chipTap.line = null;
          chipTap.seg = null;
          chipTap.at = 0;
          return;
        }
      }
      render();
      return;
    }
    if (action === 'comment') { toggleLineComment(line); return; }
    if (action === 'add') { openAdd(line); return; }
    if (action === 'insert-ok') { commitInput(); return; }
    if (action === 'insert-cancel') { cancelInput(); return; }
    if (action === 'insert-divider') { insertDivider(line); return; }
    if (action === 'fold') { toggleFold(line); return; }
    if (action === 'line-weight') { openLineWeight(line); return; }
    if (action === 'lw-minus') { stepLineWeight(line, -WEIGHT_STEP); return; }
    if (action === 'lw-plus') { stepLineWeight(line, WEIGHT_STEP); return; }
    if (action === 'lw-set') { applyLineWeightValue(line, Number(target.dataset.weight)); return; }
    if (action === 'lw-close') { selection.lineWeight = null; render(); return; }
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
    commit(next);
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
      syncCmViews();
      render();
    },
    onHide() {
      closeTextEditor();
      if (cm) cm.closePopups();
      if (cmFull) cmFull.closePopups();
    },
    /** Re-measure line folds (screens call this from onShow, the DOM is measurable then). */
    relayout() {
      applyFolds();
    },
    appendKeyword(keyword) {
      const current = value().replace(/\s+$/, '');
      const lowered = keyword.toLowerCase();
      if (current.toLowerCase().split(',').map((part) => part.trim()).includes(lowered)) {
        toast('already in the prompt', 'warn', 1400);
        return;
      }
      expandedLines.add(Math.max(0, current.split('\n').length - 1)); // keep the edited line open
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
  const positiveKey = kind === 'text' ? 'text' : kind === 'qwen' ? 'qwen' : 'image';
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
    relayout() {
      positiveField.relayout();
      negativeField.relayout();
    },
    onHide() {
      positiveField.onHide();
      negativeField.onHide();
    },
  };
}
