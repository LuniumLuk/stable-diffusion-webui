/**
 * Prompt line-comment support for txt2img / img2img.
 *
 * Lines whose first non-whitespace character is '#' are treated as comments.
 *   - Ctrl+/ toggles comment / uncomment on all lines covered by the selection.
 *   - Comment lines are displayed in green italic via a transparent-textarea +
 *     absolutely-positioned highlight-backdrop overlay (same pattern as hires_fix.js).
 *   - Comment lines are stripped from the prompt only inside the Python pipeline;
 *     the full text (with comments) is preserved in PNG metadata and gallery.
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
     * Convert raw prompt text to HTML with comment lines wrapped in
     * <span class="prompt-comment">. Non-comment text is plain-escaped.
     * Lines are joined with <br> so the backdrop renders line-by-line.
     */
    function buildCommentHighlightHtml(text) {
        const lines = String(text || '').split('\n');
        return lines.map(function (line) {
            const trimmed = line.trimStart ? line.trimStart() : line.replace(/^\s+/, '');
            if (trimmed.charAt(0) === '#') {
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
