/**
 * Prompt line-comment support for txt2img / img2img.
 *
 * Lines whose first non-whitespace character is '#' are treated as comments.
 *   - Ctrl+/ toggles comment / uncomment on all lines covered by the selection.
 *   - Comment lines are displayed in green italic via a transparent-textarea +
 *     absolutely-positioned highlight-backdrop overlay (same pattern as hires_fix.js).
 *   - Comment lines are stripped from the prompt only inside the Python pipeline;
 *     the full text (with comments) is preserved in PNG metadata and gallery.
 *   - Block comments: text between one '# ---' starter line and the next
 *     one forms a block; a toggle icon rendered at the end of the starter
 *     line comments / uncomments every line inside the block in one click.
 *     Starter lines may carry a trailing label ('# --- my section').
 */
(function () {
    'use strict';

    const PROMPT_IDS = [
        'txt2img_prompt',
        'txt2img_neg_prompt',
        'img2img_prompt',
        'img2img_neg_prompt',
    ];

    // ── helpers ──────────────────────────────────────────────────────────────

    function escapeHtml(str) {
        return String(str || '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    /**
     * A "block starter" is any line that begins (after optional leading
     * whitespace) with '# ---'. Extra dashes, trailing whitespace, or a
     * trailing label ('# --- my section') are all allowed.
     */
    function isBlockMarker(line) {
        return /^\s*#\s*-{3,}/.test(line);
    }

    /** True when the line's first non-whitespace character is '#'. */
    function lineStartsWithHash(line) {
        const trimmed = line.trimStart ? line.trimStart() : line.replace(/^\s+/, '');
        return trimmed.charAt(0) === '#';
    }

    /**
     * A block is "commented" when every non-empty line between its two
     * '# ---' markers starts with '#'. Empty blocks are never considered
     * commented.
     */
    function blockIsCommented(lines, from, to) {
        let any = false;
        for (let i = from; i < to; i++) {
            if (lines[i].trim() === '') continue;
            any = true;
            if (!lineStartsWithHash(lines[i])) return false;
        }
        return any;
    }

    /**
     * Convert raw prompt text to HTML for the backdrop overlay.
     *  - Comment lines are wrapped in <span class="prompt-comment">.
     *  - Lines that open a '# ---' ... '# ---' block get a clickable toggle
     *    icon rendered at the end of the starter line.
     */
    function buildCommentHighlightHtml(text) {
        const lines = String(text || '').split('\n');
        const n = lines.length;

        // For every line, the index of the next block marker strictly
        // after it (or -1). Store before updating `last` so a marker
        // line's own index is never returned for itself.
        const nextMarker = new Array(n).fill(-1);
        let last = -1;
        for (let i = n - 1; i >= 0; i--) {
            nextMarker[i] = last;
            if (isBlockMarker(lines[i])) last = i;
        }

        return lines.map(function (line, idx) {
            if (isBlockMarker(line) && nextMarker[idx] > idx) {
                const commented = blockIsCommented(lines, idx + 1, nextMarker[idx]);
                const icon = commented ? '⏸' : '▶';
                const title = commented ? 'Uncomment block' : 'Comment block';
                return '<span class="prompt-comment prompt-block-marker">' + escapeHtml(line) + '</span>'
                    + '<span class="prompt-block-toggle' + (commented ? ' is-commented' : '') + '"'
                    + ' data-block-start="' + idx + '" title="' + title + '">' + icon + '</span>';
            }
            if (lineStartsWithHash(line)) {
                return '<span class="prompt-comment">' + escapeHtml(line) + '</span>';
            }
            return escapeHtml(line);
        }).join('<br>');
    }

    /**
     * Toggle line-comment (Ctrl+/) on the selected lines inside a textarea.
     * If every non-empty selected line already starts with '#', they are
     * uncommented; otherwise all selected lines are commented.
     */
    function toggleLineComment(textarea) {
        const value = textarea.value;
        const ss = textarea.selectionStart;
        const se = textarea.selectionEnd;

        // Expand to cover whole lines.
        const lineStart = value.lastIndexOf('\n', ss - 1) + 1;
        const lineEndIdx = value.indexOf('\n', se);
        const blockEnd = lineEndIdx === -1 ? value.length : lineEndIdx;

        const block = value.slice(lineStart, blockEnd);
        const lines = block.split('\n');

        const nonEmpty = lines.filter(function (l) { return l.trim() !== ''; });
        const allCommented = nonEmpty.length > 0 &&
            nonEmpty.every(function (l) {
                return (l.trimStart ? l.trimStart() : l.replace(/^\s+/, '')).charAt(0) === '#';
            });

        var newLines;
        if (allCommented) {
            // Remove the leading '# ' or '#'
            newLines = lines.map(function (line) {
                var trimmed = line.trimStart ? line.trimStart() : line.replace(/^\s+/, '');
                var indent = line.slice(0, line.length - trimmed.length);
                if (trimmed.slice(0, 2) === '# ') return indent + trimmed.slice(2);
                if (trimmed.charAt(0) === '#') return indent + trimmed.slice(1);
                return line;
            });
        } else {
            // Prepend '# ' (skip purely empty lines)
            newLines = lines.map(function (line) {
                return line.trim() === '' ? line : '# ' + line;
            });
        }

        var newBlock = newLines.join('\n');
        var delta = newBlock.length - block.length;
        var newValue = value.slice(0, lineStart) + newBlock + value.slice(blockEnd);

        textarea.value = newValue;
        textarea.selectionStart = lineStart;
        textarea.selectionEnd = blockEnd + delta;

        textarea.dispatchEvent(new Event('input', { bubbles: true }));
        textarea.dispatchEvent(new Event('change', { bubbles: true }));
    }

    /**
     * Toggle the comment state of the block opened by the '# ---' marker at
     * line index `startIdx`. Content lines between the opening marker and the
     * next closing marker are commented (prefixed with '# ') or uncommented
     * as one unit. Marker lines themselves are left untouched.
     */
    function toggleBlockComment(textarea, startIdx) {
        const lines = textarea.value.split('\n');
        if (startIdx < 0 || startIdx >= lines.length || !isBlockMarker(lines[startIdx])) return;

        let endIdx = -1;
        for (let i = startIdx + 1; i < lines.length; i++) {
            if (isBlockMarker(lines[i])) {
                endIdx = i;
                break;
            }
        }
        if (endIdx === -1) return;

        const commented = blockIsCommented(lines, startIdx + 1, endIdx);

        for (let j = startIdx + 1; j < endIdx; j++) {
            if (lines[j].trim() === '') continue;
            const trimmed = lines[j].trimStart ? lines[j].trimStart() : lines[j].replace(/^\s+/, '');
            const indent = lines[j].slice(0, lines[j].length - trimmed.length);
            if (commented) {
                if (trimmed.slice(0, 2) === '# ') lines[j] = indent + trimmed.slice(2);
                else if (trimmed.charAt(0) === '#') lines[j] = indent + trimmed.slice(1);
            } else if (!lineStartsWithHash(lines[j])) {
                lines[j] = indent + '# ' + trimmed;
            }
        }

        const newValue = lines.join('\n');
        textarea.value = newValue;

        // Park the caret at the start of the block so the user keeps context.
        const pos = lines.slice(0, startIdx).join('\n').length + (startIdx > 0 ? 1 : 0);
        textarea.selectionStart = pos;
        textarea.selectionEnd = pos;

        textarea.dispatchEvent(new Event('input', { bubbles: true }));
        textarea.dispatchEvent(new Event('change', { bubbles: true }));
    }

    // ── per-textarea installation ─────────────────────────────────────────────

    function installOn(host) {
        if (!host) return;
        const textarea = host.querySelector('textarea');
        if (!textarea || textarea.dataset.promptCommentReady === '1') return;
        textarea.dataset.promptCommentReady = '1';

        console.log('[promptComment] installing on host id=' + (host.id || '(no id)'));

        // Mark host so CSS can target it.
        host.classList.add('prompt-comment-assist');

        // Create the highlight backdrop overlay (same pattern as hires-stage-highlight).
        const backdrop = document.createElement('div');
        backdrop.className = 'prompt-highlight-backdrop';
        host.appendChild(backdrop);

        // Clicking a block-toggle icon (rendered inside the backdrop) toggles
        // the whole '# ---' ... '# ---' block. The backdrop itself stays
        // click-through; only the icon span re-enables pointer events (CSS).
        backdrop.addEventListener('click', function (e) {
            let el = e.target;
            while (el && el !== backdrop && !(el.classList && el.classList.contains('prompt-block-toggle'))) {
                el = el.parentElement;
            }
            if (!el || el === backdrop) return;
            const start = parseInt(el.dataset.blockStart, 10);
            if (!isNaN(start)) toggleBlockComment(textarea, start);
        });

        // ── layout sync ─────────────────────────────────────────────────────

        function syncLayout() {
            var cs = window.getComputedStyle(textarea);
            // Account for the textarea's border so the backdrop content area
            // aligns pixel-for-pixel with the actual text inside the textarea.
            var borderTop  = parseFloat(cs.borderTopWidth)  || 0;
            var borderLeft = parseFloat(cs.borderLeftWidth) || 0;
            backdrop.style.top    = (textarea.offsetTop  + borderTop)  + 'px';
            backdrop.style.left   = (textarea.offsetLeft + borderLeft) + 'px';
            backdrop.style.width  = textarea.clientWidth  + 'px';
            backdrop.style.height = textarea.clientHeight + 'px';
            backdrop.style.paddingTop    = cs.paddingTop;
            backdrop.style.paddingRight  = cs.paddingRight;
            backdrop.style.paddingBottom = cs.paddingBottom;
            backdrop.style.paddingLeft   = cs.paddingLeft;
            backdrop.style.font          = cs.font;
            backdrop.style.lineHeight    = cs.lineHeight;
            backdrop.style.letterSpacing = cs.letterSpacing;
            backdrop.style.wordSpacing   = cs.wordSpacing;
            backdrop.style.textAlign     = cs.textAlign;
            backdrop.style.tabSize       = cs.tabSize;
        }

        function syncContent() {
            backdrop.innerHTML = buildCommentHighlightHtml(textarea.value || '');
            backdrop.scrollTop  = textarea.scrollTop;
            backdrop.scrollLeft = textarea.scrollLeft;
        }

        // ── event listeners ──────────────────────────────────────────────────

        textarea.addEventListener('input',  function () { syncContent(); });
        textarea.addEventListener('change', function () { syncContent(); });
        textarea.addEventListener('scroll', function () {
            backdrop.scrollTop  = textarea.scrollTop;
            backdrop.scrollLeft = textarea.scrollLeft;
        });
        textarea.addEventListener('focus', function () {
            syncLayout();
            syncContent();
        });

        // Ctrl+/ → toggle line comment
        textarea.addEventListener('keydown', function (e) {
            if ((e.ctrlKey || e.metaKey) && e.key === '/') {
                e.preventDefault();
                toggleLineComment(textarea);
                syncContent();
            }
        });

        // Resize observer to keep overlay in sync when Gradio resizes the textarea.
        if (typeof ResizeObserver !== 'undefined') {
            var ro = new ResizeObserver(function () {
                syncLayout();
            });
            ro.observe(textarea);
        }

        // Hook the textarea's native value setter so any programmatic assignment
        // (e.g. Gradio/Svelte restoring values after "Send to txt2img") triggers
        // an immediate backdrop sync without waiting for the 300ms poll.
        (function hookValueSetter(el) {
            var desc = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value');
            if (!desc || !desc.set) return;
            Object.defineProperty(el, 'value', {
                get: function () { return desc.get.call(this); },
                set: function (v) {
                    desc.set.call(this, v);
                    syncContent();
                },
                configurable: true,
            });
        })(textarea);

        // Fallback poller for frameworks that bypass the value setter.
        var lastValue = textarea.value;
        setInterval(function () {
            if (textarea.value !== lastValue) {
                lastValue = textarea.value;
                syncContent();
            }
        }, 300);

        // Initial render.
        [0, 80, 200, 500].forEach(function (ms) {
            setTimeout(function () {
                syncLayout();
                syncContent();
            }, ms);
        });

        window.addEventListener('resize', syncLayout);
    }

    // ── bootstrap ─────────────────────────────────────────────────────────────

    function installAll() {
        PROMPT_IDS.forEach(function (id) {
            var host = gradioApp().querySelector('#' + id);
            installOn(host);
        });
    }

    onUiLoaded(installAll);
    onAfterUiUpdate(installAll);
})();
