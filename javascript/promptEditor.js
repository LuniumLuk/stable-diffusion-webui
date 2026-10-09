/**
 * Native prompt editor for txt2img / img2img (and the Qwen-Image 2.1 tab).
 *
 * Replaces the pile of textarea overlays (highlight backdrop, keyboard-only
 * weight editing, suggestion dropdown) with a chip editor built for touch:
 *
 *   - text is parsed into keyword chips (top-level commas separate them);
 *   - tap a chip          -> selects it and opens the action bar
 *   - action bar          -> weight -/+ (and quick values), disable, duplicate,
 *                            delete  (no keyboard needed)
 *   - gutter button (💬)  -> comment / uncomment the whole line (the Python
 *                            pipeline strips '#' comment lines)
 *   - ⛔ on a chip        -> wraps the keyword as  #(keyword)  - a *disabled*
 *                            inline group the backend strips just like a comment
 *   - ＋ keyword          -> inline input with suggestions from the endorsed
 *                            keyword pool and the installed extra networks
 *   - [⌨ Text] button     -> switches back to the classic textarea (the
 *                            original overlay features keep working there)
 *
 * The gradio textarea stays the single source of truth: every edit rewrites
 * `textarea.value` and dispatches input/change, so token counters, presets,
 * extra-network insertion, styles, paste and the generate payload all keep
 * working unchanged.
 */
(function () {
    'use strict';

    const HOST_IDS = ['txt2img_prompt', 'txt2img_neg_prompt', 'img2img_prompt', 'img2img_neg_prompt', 'qwen_prompt', 'qwen_neg_prompt', 'krea2_prompt', 'krea2_neg_prompt'];
    const LS_MODE = 'pedit.mode';           // 'chips' | 'text'
    const LS_STEP = 'pedit.step';           // weight step, default '0.05'
    const LS_RECENT = 'pedit.recent';       // MRU keyword list (JSON array)
    const MAX_SUGGEST = 14;
    const DEFAULT_WEIGHT = 1.0;

    // ── tiny helpers ────────────────────────────────────────────────────────

    function readLS(key, fallback) {
        try {
            const v = window.localStorage ? window.localStorage.getItem(key) : null;
            return v === null || v === undefined ? fallback : v;
        } catch (e) {
            return fallback;
        }
    }

    function writeLS(key, value) {
        try {
            window.localStorage && window.localStorage.setItem(key, String(value));
        } catch (e) {
            /* ignore */
        }
    }

    function escapeHtml(str) {
        return String(str == null ? '' : str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function clamp(v, lo, hi) {
        return Math.max(lo, Math.min(v, hi));
    }

    function formatWeight(w) {
        const rounded = Math.round(w * 1000) / 1000;
        // A1111 writes weights with a decimal part; "1" would be parsed as integer 1 fine,
        // but "1.0" is what the console/API users expect to see.
        return Number.isInteger(rounded) ? rounded + '.0' : String(rounded);
    }

    // ── token model ─────────────────────────────────────────────────────────
    //
    // A line is split into segments at *top level* commas (commas inside
    // (), [] or <> are not separators).  Each segment keeps its raw text
    // (lead + body + tail) so an untouched line re-serialises byte-identically.

    function splitSegments(line) {
        const segs = [];
        let lead = '';
        let body = '';
        let depth = 0;
        let i = 0;

        // leading whitespace belongs to `lead`
        while (i < line.length && /\s/.test(line[i])) lead += line[i++];
        // an empty line (or only whitespace) is a single empty segment
        if (i >= line.length) return [{ lead: lead, body: '', tail: '' }];

        for (; i < line.length; i++) {
            const ch = line[i];
            if (ch === '(' || ch === '[' || ch === '<') depth++;
            else if (ch === ')' || ch === ']' || ch === '>') depth = Math.max(0, depth - 1);

            if (ch === ',' && depth === 0) {
                let tail = ',';
                i++;
                while (i < line.length && /\s/.test(line[i])) tail += line[i++];
                i--;
                segs.push({ lead: lead, body: body, tail: tail });
                lead = '';
                body = '';
                continue;
            }
            body += ch;
        }
        segs.push({ lead: lead, body: body, tail: '' });
        return segs;
    }

    function joinSegments(segs) {
        return segs.map((s) => s.lead + s.body + s.tail).join('');
    }

    /** Effective weight of an A1111 style chunk: (x:W) [x] ((x)) <lora:x:W>. */
    function colonWeight(inner) {
        // find the last ':' that is not inside nested parens
        let depth = 0;
        for (let i = inner.length - 1; i >= 0; i--) {
            const ch = inner[i];
            if (ch === ')' || ch === ']' || ch === '>') depth++;
            else if (ch === '(' || ch === '[' || ch === '<') depth--;
            else if (ch === ':' && depth === 0) {
                const w = parseFloat(inner.slice(i + 1));
                if (!isNaN(w) && /^\s*-?[\d.]+\s*$/.test(inner.slice(i + 1))) {
                    return { text: inner.slice(0, i), weight: w, hasColon: true };
                }
                return { text: inner, weight: null, hasColon: false };
            }
        }
        return { text: inner, weight: null, hasColon: false };
    }

    /** Number of balanced wrapper levels: '((x))' with ('(',')') -> 2. */
    function wrapperLevels(t, open, close) {
        let inner = t;
        let levels = 0;
        while (levels < 9 && inner.length >= 2 && inner[0] === open && inner[inner.length - 1] === close) {
            let depth = 0;
            let closesAtEnd = false;
            for (let i = 0; i < inner.length; i++) {
                if (inner[i] === open) depth++;
                else if (inner[i] === close) {
                    depth--;
                    if (depth === 0) {
                        closesAtEnd = i === inner.length - 1;
                        break;
                    }
                }
            }
            if (!closesAtEnd) break;
            inner = inner.slice(1, -1);
            levels++;
        }
        return { levels: levels, inner: inner };
    }

    /**
     * Classify a segment body -> { kind, text, weight, disabled }
     *   kind: 'plain' | 'paren' | 'bracket' | 'angle'
     * The weight is the *effective* A1111 weight, so '((x))' is 1.21 and '[x]' is 0.909.
     */
    function classify(body) {
        const t = body.trim();
        if (!t) return { kind: 'plain', text: '', weight: DEFAULT_WEIGHT, disabled: false };

        if (t === ',') return { kind: 'plain', text: ',', weight: DEFAULT_WEIGHT, disabled: false };

        // #(...) / #[...] / #<...> -> disabled keyword group
        if (t[0] === '#' && t.length > 3) {
            const inner = classify(t.slice(1));
            if (inner.kind !== 'plain') {
                inner.disabled = true;
                return inner;
            }
        }

        if (t[0] === '(' && t[t.length - 1] === ')') {
            const wrap = wrapperLevels(t, '(', ')');
            if (wrap.levels > 0) {
                const colon = colonWeight(wrap.inner);
                const base = colon.hasColon ? colon.weight : 1.1;
                const weight = base * Math.pow(1.1, wrap.levels - 1);
                return { kind: 'paren', text: colon.hasColon ? colon.text : wrap.inner, weight: weight, disabled: false };
            }
        }

        if (t[0] === '[' && t[t.length - 1] === ']') {
            const wrap = wrapperLevels(t, '[', ']');
            if (wrap.levels > 0) {
                const colon = colonWeight(wrap.inner);
                const base = colon.hasColon ? colon.weight : 1 / 1.1;
                const weight = base * Math.pow(1 / 1.1, wrap.levels - 1);
                return { kind: 'bracket', text: colon.hasColon ? colon.text : wrap.inner, weight: weight, disabled: false };
            }
        }

        if (t[0] === '<' && t[t.length - 1] === '>') {
            const inner = t.slice(1, -1);
            const parts = inner.split(':');
            let weight = DEFAULT_WEIGHT;
            let text = inner;
            if (parts.length >= 3) {
                const w = parseFloat(parts[parts.length - 1]);
                if (!isNaN(w)) {
                    weight = w;
                    text = parts.slice(0, -1).join(':');
                }
            }
            return { kind: 'angle', text: text, weight: weight, disabled: false };
        }

        return { kind: 'plain', text: t, weight: DEFAULT_WEIGHT, disabled: false };
    }

    /**
     * Build the body text for a token with the given weight / disabled flag.
     * Used by every chip action (weight steppers, disable, quick weights).
     */
    function rebuild(token, weight, disabled) {
        const flat = Math.abs(weight - DEFAULT_WEIGHT) < 1e-9;
        let inner;
        if (token.kind === 'angle') {
            inner = flat ? '<' + token.text + '>' : '<' + token.text + ':' + formatWeight(weight) + '>';
        } else {
            inner = flat ? token.text : token.text + ':' + formatWeight(weight);
        }
        if (disabled) return '#(' + inner + ')';
        if (token.kind === 'angle' || flat) return inner; // weight 1 -> drop the brackets entirely
        return '(' + inner + ')';
    }

    // ── per-host editor ─────────────────────────────────────────────────────

    function installOn(host) {
        if (!host || host.dataset.peditReady === '1') return;
        const textarea = host.querySelector('textarea');
        if (!textarea) return;
        host.dataset.peditReady = '1';

        host.classList.add('pedit-host');

        const root = document.createElement('div');
        root.className = 'pedit-root';
        host.appendChild(root);

        const state = {
            text: textarea.value || '',
            selected: null,       // { line, seg }
            input: null,          // { line, value } while the inline add-input is open
            suggestIdx: 0,
            suggestions: [],
            pool: null,
            lastCommitted: textarea.value || '',
            scroll: 0,
        };

        const step = () => {
            const v = parseFloat(readLS(LS_STEP, '0.05'));
            return isNaN(v) || v <= 0 ? 0.05 : v;
        };

        // ── text synchronisation (textarea is the source of truth) ──────────

        function commit(newText, keepSelection) {
            state.text = newText;
            state.lastCommitted = newText;
            if (textarea.value !== newText) {
                textarea.value = newText;
            }
            textarea.dispatchEvent(new Event('input', { bubbles: true }));
            textarea.dispatchEvent(new Event('change', { bubbles: true }));
            render();
        }

        function syncFromTextarea(force) {
            const v = textarea.value || '';
            if (v === state.lastCommitted && !force) return;
            // never clobber the DOM while the user is typing inside the editor
            const active = document.activeElement;
            if (!force && active && root.contains(active) && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')) return;
            state.text = v;
            state.lastCommitted = v;
            render();
        }

        // ── rendering ───────────────────────────────────────────────────────

        function tokenAt(line, seg) {
            const lines = state.text.split('\n');
            if (line < 0 || line >= lines.length) return null;
            const segs = splitSegments(lines[line]);
            if (seg < 0 || seg >= segs.length) return null;
            const info = classify(segs[seg].body);
            info.segIndex = seg;
            info.lineIndex = line;
            return info;
        }

        function chipHtml(line, seg, token) {
            const selected = state.selected && state.selected.line === line && state.selected.seg === seg;
            const cls = ['pedit-chip'];
            if (token.disabled) cls.push('is-disabled');
            if (selected) cls.push('is-selected');
            if (!token.text) cls.push('is-empty');

            const label = token.text || '…';
            const showWeight = Math.abs((token.weight || 1) - DEFAULT_WEIGHT) > 1e-9;
            const weightBadge = showWeight ? `<span class="pedit-chip-w" title="weight">×${escapeHtml(formatWeight(token.weight))}</span>` : '';
            const kindBadge = token.kind === 'angle' ? '<span class="pedit-chip-kind" title="extra network tag">◈</span>' : '';
            return `<span class="${cls.join(' ')}" data-line="${line}" data-seg="${seg}" title="${escapeHtml(token.text)}">`
                + kindBadge
                + `<span class="pedit-chip-text">${escapeHtml(label)}</span>`
                + weightBadge
                + (token.disabled ? '<span class="pedit-chip-off" title="disabled">⛔</span>' : '')
                + '</span>';
        }

        function lineHtml(line, index, lines) {
            const commented = /^\s*#(?!\()/.test(line);
            // a commented line shows its keywords without the leading '# ' - the
            // gutter button carries the state and the raw text stays untouched
            const content = commented ? line.replace(/^(\s*)#\s?/, '$1') : line;
            const segs = splitSegments(content);
            const chips = segs
                .map((s, i) => {
                    if (!s.body.trim()) {
                        // a bare separator (", a, b" or "a, , b") keeps its comma visible
                        return i < segs.length - 1 ? '<span class="pedit-sep">,</span>' : '';
                    }
                    return chipHtml(index, i, classify(s.body));
                })
                .join('');
            const commentBtn = `<button type="button" class="pedit-gutter ${commented ? 'is-comment' : ''}" `
                + `data-line="${index}" title="${commented ? 'Uncomment this line' : 'Comment this line'}">${commented ? '⏸' : '💬'}</button>`;
            // '# ---' markers open a block up to the next marker: one tap toggles the whole block
            let blockBtn = '';
            const bounds = lines ? blockBounds(lines, index) : null;
            if (bounds) {
                const off = blockIsOff(lines, bounds.from, bounds.to);
                const count = bounds.to - bounds.from;
                const title = off
                    ? 'Turn this block back on (' + count + ' line(s))'
                    : 'Turn off this block until the next # marker (' + count + ' line(s))';
                blockBtn = `<button type="button" class="pedit-gutter pedit-block-toggle ${off ? 'is-off' : ''}" `
                    + `data-line="${index}" title="${title}">${off ? '⏸' : '▶'}</button>`;
            }
            return `<div class="pedit-line ${commented ? 'is-comment' : ''}" data-line="${index}">`
                + commentBtn
                + blockBtn
                + `<div class="pedit-chips">${chips}<button type="button" class="pedit-add" data-line="${index}" title="Add a keyword to this line">＋</button></div>`
                + '</div>';
        }

        function actionBarHtml() {
            const sel = state.selected;
            if (!sel) return '';
            const token = tokenAt(sel.line, sel.seg);
            if (!token || !token.text) return '';
            const w = token.weight || DEFAULT_WEIGHT;
            return `<div class="pedit-actions">`
                + `<span class="pedit-actions-text" title="selected keyword">${escapeHtml(token.text)}</span>`
                + `<button type="button" class="pedit-act" data-act="w-minus" title="Lower weight">−</button>`
                + `<span class="pedit-weight" title="weight">${escapeHtml(formatWeight(w))}</span>`
                + `<button type="button" class="pedit-act" data-act="w-plus" title="Raise weight">＋</button>`
                + `<button type="button" class="pedit-act pedit-quick" data-act="w-0.8">0.8</button>`
                + `<button type="button" class="pedit-act pedit-quick" data-act="w-1.1">1.1</button>`
                + `<button type="button" class="pedit-act pedit-quick" data-act="w-1.2">1.2</button>`
                + `<button type="button" class="pedit-act" data-act="reset" title="Back to weight 1 (no brackets)">⟲1.0</button>`
                + `<span class="pedit-actions-sep"></span>`
                + `<button type="button" class="pedit-act ${token.disabled ? 'is-on' : ''}" data-act="toggle-off" title="${token.disabled ? 'Enable this keyword' : 'Disable this keyword (stripped when generating)'}">${token.disabled ? '✅' : '⛔'}</button>`
                + `<button type="button" class="pedit-act" data-act="duplicate" title="Duplicate">⎘</button>`
                + `<button type="button" class="pedit-act" data-act="delete" title="Delete">🗑</button>`
                + `<button type="button" class="pedit-act pedit-act-close" data-act="close" title="Close">✕</button>`
                + '</div>';
        }

        function inputHtml(line) {
            if (!state.input || state.input.line !== line) return '';
            const items = state.suggestions;
            const list = items.length
                ? items.map((s, i) => `<button type="button" class="pedit-suggest-item ${i === state.suggestIdx ? 'is-active' : ''}" data-suggest="${i}">${escapeHtml(s)}</button>`).join('')
                : '<span class="pedit-suggest-empty">no match — Enter adds the text as typed</span>';
            return `<div class="pedit-insert" data-line="${line}">`
                + `<input type="text" class="pedit-input" value="${escapeHtml(state.input.value || '')}" placeholder="keyword…" autocomplete="off" enterkeyhint="done" />`
                + '<button type="button" class="pedit-insert-ok" title="Add">✓</button>'
                + '<button type="button" class="pedit-insert-cancel" title="Cancel">✕</button>'
                + `<div class="pedit-suggest">${list}</div>`
                + '</div>';
        }

        function render() {
            const lines = state.text.split('\n');
            const body = lines.map((l, i) => lineHtml(l, i, lines) + inputHtml(i)).join('');
            const disabledCount = countDisabled();
            const previous = root.querySelector('.pedit-body');
            const scrollTop = previous ? previous.scrollTop : state.scroll;
            root.innerHTML = `<div class="pedit-head">`
                + `<span class="pedit-title">chips</span>`
                + `<button type="button" class="pedit-head-btn" data-act="to-text" title="Switch to the plain textarea (highlight, Ctrl+/, block comments)">⌨ Text</button>`
                + `<button type="button" class="pedit-head-btn" data-act="add-line" title="Add a line">＋ line</button>`
                + `<button type="button" class="pedit-head-btn" data-act="uncomment-all" title="Uncomment every line">▶ all</button>`
                + (disabledCount ? `<span class="pedit-badge" title="keywords disabled with #( ) are stripped when generating">${disabledCount} off</span>` : '')
                + '</div>'
                + `<div class="pedit-body">${body}</div>`
                + actionBarHtml();
            const scroller = root.querySelector('.pedit-body');
            if (scroller) {
                scroller.scrollTop = scrollTop;
                state.scroll = scroller.scrollTop;
            }
        }

        function countDisabled() {
            let n = 0;
            state.text.split('\n').forEach((line) => {
                splitSegments(line).forEach((s) => {
                    if (classify(s.body).disabled) n++;
                });
            });
            return n;
        }

        // ── editing operations ──────────────────────────────────────────────

        function setLineBody(lineIndex, segIndex, newBody) {
            const lines = state.text.split('\n');
            if (lineIndex < 0 || lineIndex >= lines.length) return;
            const segs = splitSegments(lines[lineIndex]);
            if (segIndex < 0 || segIndex >= segs.length) return;
            segs[segIndex].body = newBody;
            lines[lineIndex] = joinSegments(segs);
            commit(lines.join('\n'));
        }

        function mapLine(lineIndex, fn) {
            const lines = state.text.split('\n');
            if (lineIndex < 0 || lineIndex >= lines.length) return;
            lines[lineIndex] = fn(lines[lineIndex]);
            commit(lines.join('\n'));
        }

        function rawBody(lineIndex, segIndex) {
            const lines = state.text.split('\n');
            if (lineIndex < 0 || lineIndex >= lines.length) return null;
            const segs = splitSegments(lines[lineIndex]);
            if (segIndex < 0 || segIndex >= segs.length) return null;
            return segs[segIndex];
        }

        function applyChipAction(action) {
            const sel = state.selected;
            if (!sel) return;
            const token = tokenAt(sel.line, sel.seg);
            if (!token) return;
            const seg = rawBody(sel.line, sel.seg);
            if (!seg) return;
            const cur = token.weight || DEFAULT_WEIGHT;

            const write = (body) => {
                const lines = state.text.split('\n');
                const segs = splitSegments(lines[sel.line]);
                segs[sel.seg].body = body;
                lines[sel.line] = joinSegments(segs);
                commit(lines.join('\n'));
            };

            switch (action) {
                case 'w-plus':
                    write(rebuild(token, Math.round((cur + step()) * 1000) / 1000, token.disabled));
                    break;
                case 'w-minus':
                    write(rebuild(token, Math.max(0, Math.round((cur - step()) * 1000) / 1000), token.disabled));
                    break;
                case 'reset':
                    write(rebuild(token, DEFAULT_WEIGHT, token.disabled));
                    break;
                case 'toggle-off':
                    write(rebuild(token, cur, !token.disabled));
                    break;
                case 'duplicate': {
                    const lines = state.text.split('\n');
                    const segs = splitSegments(lines[sel.line]);
                    const orig = segs[sel.seg];
                    // make sure the clone is a separate keyword, not glued to the original
                    if (!/,\s*$/.test(orig.tail || '')) orig.tail = (orig.tail || '') + ', ';
                    segs.splice(sel.seg + 1, 0, { lead: '', body: seg.body, tail: '' });
                    lines[sel.line] = joinSegments(segs);
                    state.selected = { line: sel.line, seg: sel.seg + 1 };
                    commit(lines.join('\n'));
                    break;
                }
                case 'delete': {
                    const lines = state.text.split('\n');
                    const segs = splitSegments(lines[sel.line]);
                    segs.splice(sel.seg, 1);
                    if (!segs.length) segs.push({ lead: '', body: '', tail: '' });
                    lines[sel.line] = joinSegments(segs);
                    state.selected = null;
                    // drop the line entirely when it ended up empty as the last line
                    if (sel.line === lines.length - 1 && !lines[sel.line].trim() && lines.length > 1) lines.pop();
                    commit(lines.join('\n'));
                    break;
                }
                case 'close':
                    state.selected = null;
                    render();
                    break;
                default:
                    if (action.indexOf('w-') === 0) {
                        const w = parseFloat(action.slice(2));
                        if (!isNaN(w)) write(rebuild(token, w, token.disabled));
                    }
                    break;
            }
        }

        function toggleLineComment(lineIndex) {
            mapLine(lineIndex, (line) => {
                const trimmed = line.replace(/^\s+/, '');
                const indent = line.slice(0, line.length - trimmed.length);
                if (/^#(?!\()/.test(trimmed)) {
                    const body = trimmed.slice(1).replace(/^ /, '');
                    return indent + body;
                }
                if (trimmed === '') return line;
                return indent + '# ' + trimmed;
            });
        }

        function uncommentAll() {
            const lines = state.text.split('\n').map((line) => {
                const trimmed = line.replace(/^\s+/, '');
                const indent = line.slice(0, line.length - trimmed.length);
                return /^#(?!\()/.test(trimmed) ? indent + trimmed.slice(1).replace(/^ /, '') : line;
            });
            commit(lines.join('\n'));
        }

        // ── '# ---' block comments (same contract as javascript/promptComment.js) ──

        function isBlockMarker(line) {
            return /^\s*#\s*-{3,}/.test(line);
        }

        /** {"from", "to"} line indexes covered by the block opened at `index`, or null. */
        function blockBounds(lines, index) {
            if (index < 0 || index >= lines.length || !isBlockMarker(lines[index])) return null;
            for (let i = index + 1; i < lines.length; i += 1) {
                if (isBlockMarker(lines[i])) return { from: index + 1, to: i };
            }
            return null;
        }

        function startsWithLineHash(line) {
            const trimmed = line.replace(/^\s+/, '');
            if (trimmed.charAt(0) !== '#') return false;
            return '([<'.indexOf(trimmed.charAt(1)) < 0;
        }

        function blockIsOff(lines, from, to) {
            let any = false;
            for (let i = from; i < to; i += 1) {
                if (!lines[i].trim()) continue;
                any = true;
                if (!startsWithLineHash(lines[i])) return false;
            }
            return any;
        }

        /** Comment / uncomment every line between the marker at `index` and the next one. */
        function toggleBlockComment(index) {
            const lines = state.text.split('\n');
            const bounds = blockBounds(lines, index);
            if (!bounds) return;
            const off = blockIsOff(lines, bounds.from, bounds.to);
            const next = lines.slice();
            for (let i = bounds.from; i < bounds.to; i += 1) {
                const line = next[i];
                if (!line.trim()) continue;
                const trimmed = line.replace(/^\s+/, '');
                const indent = line.slice(0, line.length - trimmed.length);
                if (off) {
                    if (trimmed.slice(0, 2) === '# ') next[i] = indent + trimmed.slice(2);
                    else if (trimmed.charAt(0) === '#') next[i] = indent + trimmed.slice(1);
                } else if (!startsWithLineHash(line)) {
                    next[i] = indent + '# ' + trimmed;
                }
            }
            commit(next.join('\n'));
        }

        function addLine() {
            const base = state.text.replace(/\n*$/, '');
            const next = base + '\n';
            commit(next);
            const newLineIndex = next.split('\n').length - 1; // the trailing empty line
            openInput(newLineIndex);
        }

        // ── inline keyword input + suggestions ──────────────────────────────

        function openInput(lineIndex) {
            state.input = { line: lineIndex, value: '' };
            state.selected = null;
            refreshSuggestions('');
            render();
            const el = root.querySelector('.pedit-input');
            if (el) {
                el.focus();
                el.setSelectionRange(el.value.length, el.value.length);
            }
            const scroller = root.querySelector('.pedit-body');
            if (scroller) scroller.scrollTop = scroller.scrollHeight;
        }

        function closeInput() {
            state.input = null;
            state.suggestions = [];
            state.suggestIdx = 0;
            render();
        }

        function commitInput(value) {
            const text = String(value || '').trim();
            if (!text) {
                closeInput();
                return;
            }
            const lineIndex = state.input ? state.input.line : 0;
            const lines = state.text.split('\n');
            const segs = splitSegments(lines[lineIndex] || '');
            const body = text;
            const emptyOnly = segs.length === 1 && !segs[0].body.trim();
            if (emptyOnly) {
                segs[0] = { lead: '', body: body, tail: '' };
            } else {
                const last = segs[segs.length - 1];
                if (!last.tail) last.tail = ', ';
                segs.push({ lead: '', body: body, tail: '' });
            }
            lines[lineIndex] = joinSegments(segs);
            pushRecent(text);
            state.input = null;
            state.suggestions = [];
            state.selected = { line: lineIndex, seg: emptyOnly ? 0 : segs.length - 1 };
            commit(lines.join('\n'));
        }

        function pushRecent(text) {
            try {
                let list = JSON.parse(readLS(LS_RECENT, '[]'));
                if (!Array.isArray(list)) list = [];
                list = [text].concat(list.filter((x) => x !== text)).slice(0, 40);
                writeLS(LS_RECENT, JSON.stringify(list));
                state.pool = null; // rebuild with the new MRU entry
            } catch (e) {
                /* ignore */
            }
        }

        function pool() {
            const base = [];
            // recently used keywords first
            try {
                JSON.parse(readLS(LS_RECENT, '[]')).forEach((k) => base.push(k));
            } catch (e) { /* ignore */ }

            // endorsed keyword pool (gallery suggestions JSON, already in the DOM)
            try {
                const box = gradioApp().querySelector('#endgal_fire_value_suggestions_json textarea');
                if (box && box.value) {
                    const data = JSON.parse(box.value);
                    ['Prompt', 'Negative prompt'].forEach((key) => {
                        (data[key] || []).forEach((k) => base.push(String(k)));
                    });
                }
            } catch (e) { /* ignore */ }

            // extra networks (LoRA / embeddings / hypernetworks) from the cards
            try {
                gradioApp().querySelectorAll('.card[data-name]').forEach((card) => {
                    const onclick = String(card.getAttribute('onclick') || '');
                    const name = card.getAttribute('data-name') || '';
                    if (!name) return;
                    if (onclick.indexOf('selectLora') >= 0 || onclick.indexOf('selectLyco') >= 0) base.push('<lora:' + name + ':1>');
                    else if (onclick.indexOf('selectHypernetwork') >= 0 || onclick.indexOf('addHypernetworkToPrompt') >= 0) base.push('<hypernet:' + name + ':1>');
                    else if (onclick.indexOf('addEmbeddingToPrompt') >= 0) base.push(name);
                });
            } catch (e) { /* ignore */ }

            const seen = new Set();
            return base.filter((k) => {
                const key = String(k).toLowerCase();
                if (seen.has(key)) return false;
                seen.add(key);
                return true;
            });
        }

        function refreshSuggestions(value) {
            const needle = String(value || '').trim().toLowerCase();
            if (!state.pool) state.pool = pool();
            const list = state.pool;
            if (!needle) {
                state.suggestions = list.slice(0, MAX_SUGGEST);
            } else {
                const starts = [];
                const contains = [];
                for (let i = 0; i < list.length; i++) {
                    const k = list[i];
                    const lk = k.toLowerCase();
                    if (lk.startsWith(needle)) starts.push(k);
                    else if (lk.indexOf(needle) >= 0) contains.push(k);
                    if (starts.length >= MAX_SUGGEST * 2) break;
                }
                state.suggestions = starts.concat(contains).slice(0, MAX_SUGGEST);
            }
            state.suggestIdx = 0;
        }

        // ── events ──────────────────────────────────────────────────────────

        root.addEventListener('pointerdown', (e) => {
            const target = e.target;
            if (!target || !target.closest) return;
            const chip = target.closest('.pedit-chip');
            if (chip && chip.dataset.seg !== undefined) {
                const line = parseInt(chip.dataset.line, 10);
                const seg = parseInt(chip.dataset.seg, 10);
                const same = state.selected && state.selected.line === line && state.selected.seg === seg;
                state.selected = same ? null : { line: line, seg: seg };
                render();
                e.preventDefault();
                return;
            }
            const blockToggle = target.closest('.pedit-block-toggle');
            if (blockToggle) {
                toggleBlockComment(parseInt(blockToggle.dataset.line, 10));
                e.preventDefault();
                return;
            }
            const gutter = target.closest('.pedit-gutter');
            if (gutter) {
                toggleLineComment(parseInt(gutter.dataset.line, 10));
                e.preventDefault();
                return;
            }
            const add = target.closest('.pedit-add');
            if (add) {
                openInput(parseInt(add.dataset.line, 10));
                e.preventDefault();
                return;
            }
            const act = target.closest('.pedit-act');
            if (act) {
                applyChipAction(act.dataset.act);
                e.preventDefault();
                return;
            }
            const head = target.closest('.pedit-head-btn');
            if (head) {
                const a = head.dataset.act;
                if (a === 'to-text') setMode('text');
                else if (a === 'add-line') addLine();
                else if (a === 'uncomment-all') uncommentAll();
                e.preventDefault();
                return;
            }
            const sug = target.closest('.pedit-suggest-item');
            if (sug) {
                const item = state.suggestions[parseInt(sug.dataset.suggest, 10)];
                if (item) commitInput(item);
                e.preventDefault();
                return;
            }
            if (target.closest('.pedit-insert-ok')) {
                const el = root.querySelector('.pedit-input');
                if (el) commitInput(el.value);
                e.preventDefault();
                return;
            }
            if (target.closest('.pedit-insert-cancel')) {
                closeInput();
                e.preventDefault();
                return;
            }
        });

        root.addEventListener('input', (e) => {
            if (e.target && e.target.classList && e.target.classList.contains('pedit-input')) {
                state.input.value = e.target.value;
                refreshSuggestions(e.target.value);
                renderSuggestOnly();
            }
        });

        root.addEventListener('keydown', (e) => {
            if (!e.target || !e.target.classList || !e.target.classList.contains('pedit-input')) return;
            if (e.key === 'Enter') {
                e.preventDefault();
                const pick = state.suggestions[state.suggestIdx];
                commitInput(e.target.value.trim() ? e.target.value : (pick || ''));
            } else if (e.key === 'Tab' && state.suggestions.length) {
                e.preventDefault();
                e.target.value = state.suggestions[state.suggestIdx];
                state.input.value = e.target.value;
                refreshSuggestions(e.target.value);
                renderSuggestOnly();
            } else if (e.key === 'ArrowDown') {
                e.preventDefault();
                state.suggestIdx = Math.min(state.suggestions.length - 1, state.suggestIdx + 1);
                renderSuggestOnly();
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                state.suggestIdx = Math.max(0, state.suggestIdx - 1);
                renderSuggestOnly();
            } else if (e.key === 'Escape') {
                e.preventDefault();
                closeInput();
            }
        });

        // only re-render the suggestion list while typing so the caret never jumps
        function renderSuggestOnly() {
            const box = root.querySelector('.pedit-suggest');
            if (!box) return;
            const items = state.suggestions;
            box.innerHTML = items.length
                ? items.map((s, i) => `<button type="button" class="pedit-suggest-item ${i === state.suggestIdx ? 'is-active' : ''}" data-suggest="${i}">${escapeHtml(s)}</button>`).join('')
                : '<span class="pedit-suggest-empty">no match — Enter adds the text as typed</span>';
        }

        // keep the textarea in sync when anything else rewrites the value
        (function hookValueSetter(el) {
            const desc = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value');
            if (!desc || !desc.set) return;
            Object.defineProperty(el, 'value', {
                get: function () { return desc.get.call(this); },
                set: function (v) {
                    desc.set.call(this, v);
                    if (mode() === 'chips') syncFromTextarea(true);
                },
                configurable: true,
            });
        })(textarea);

        textarea.addEventListener('input', () => { if (mode() === 'text') return; syncFromTextarea(false); });

        setInterval(() => {
            if (mode() !== 'chips') return;
            syncFromTextarea(false);
        }, 400);

        // ── mode switch ─────────────────────────────────────────────────────

        function setMode(next) {
            writeLS(LS_MODE, next);
            applyMode();
        }

        function applyMode() {
            const chips = mode() === 'chips';
            host.classList.toggle('pedit-chips-mode', chips);
            root.style.display = chips ? '' : 'none';
            if (chips) {
                state.text = textarea.value || '';
                state.lastCommitted = state.text;
                render();
            }
        }

        function mode() {
            const saved = readLS(LS_MODE, '');
            if (saved === 'chips' || saved === 'text') return saved;
            // default: chips on touch devices, classic textarea with a mouse
            const coarse = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
            return coarse ? 'chips' : 'text';
        }

        // floating toggle, visible in text mode (chips mode has its own header)
        const fab = document.createElement('button');
        fab.type = 'button';
        fab.className = 'pedit-fab';
        fab.textContent = '🧩 Chips';
        fab.title = 'Switch to the chip editor (touch friendly: tap keywords to toggle / adjust weight)';
        fab.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            setMode('chips');
        });
        host.appendChild(fab);

        host.addEventListener('pedit-set-mode', (e) => setMode(e.detail));

        applyMode();
        if (mode() === 'chips') render();

        // expose the mode switch to the rest of the UI (all hosts share one mode)
        window.promptEditorSetMode = (m) => {
            writeLS(LS_MODE, m);
            HOST_IDS.forEach((id) => {
                const h = gradioApp().querySelector('#' + id);
                if (h) h.dispatchEvent(new CustomEvent('pedit-set-mode', { detail: m }));
            });
        };
    }

    function installAll() {
        const app = gradioApp();
        HOST_IDS.forEach((id) => {
            const host = app.querySelector('#' + id);
            if (host) installOn(host);
        });
    }

    onUiLoaded(installAll);
    onAfterUiUpdate(installAll);

    // exposed for the node test in tmp/pedit_test.js (prompt text must never be
    // corrupted, so the parser/serialiser pair is unit tested)
    window.promptEditorDebug = {
        splitSegments: splitSegments,
        joinSegments: joinSegments,
        classify: classify,
        rebuild: rebuild,
        formatWeight: formatWeight,
    };
})();
