
function onCalcResolutionHires(enable, width, height, hr_scale, hr_resize_x, hr_resize_y) {
    function setInactive(elem, inactive) {
        elem.classList.toggle('inactive', !!inactive);
    }

    var hrUpscaleBy = gradioApp().getElementById('txt2img_hr_scale');
    var hrResizeX = gradioApp().getElementById('txt2img_hr_resize_x');
    var hrResizeY = gradioApp().getElementById('txt2img_hr_resize_y');

    gradioApp().getElementById('txt2img_hires_fix_row2').style.display = opts.use_old_hires_fix_width_height ? "none" : "";

    setInactive(hrUpscaleBy, opts.use_old_hires_fix_width_height || hr_resize_x > 0 || hr_resize_y > 0);
    setInactive(hrResizeX, opts.use_old_hires_fix_width_height || hr_resize_x == 0);
    setInactive(hrResizeY, opts.use_old_hires_fix_width_height || hr_resize_y == 0);

    return [enable, width, height, hr_scale, hr_resize_x, hr_resize_y];
}

(function() {
    'use strict';

    const STAGE_KEYS = ['scale', 'cfg', 'steps', 'denoise'];
    const STAGE_VALUE_SUGGESTIONS = {
        scale: ['1.1', '1.25', '1.5', '1.75', '2.0'],
        cfg: ['0', '3.5', '5', '7', '9'],
        steps: ['8', '10', '12', '16', '20', '30'],
        denoise: ['0.35', '0.5', '0.65', '0.75'],
    };

    function escapeHtml(text) {
        return String(text || '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function toNum(v, fallback) {
        const n = Number(v);
        return Number.isFinite(n) ? n : fallback;
    }

    function formatScale(v) {
        const n = toNum(v, 0);
        if (!Number.isFinite(n) || n <= 0) return '0x';
        return `${n.toFixed(3).replace(/\.0+$/, '').replace(/(\.\d*[1-9])0+$/, '$1')}x`;
    }

    function getInputElement(elemId) {
        const host = gradioApp().querySelector(`#${elemId}`);
        return host ? host.querySelector('input, textarea, select') : null;
    }

    function getNumericById(elemId, fallback) {
        const input = getInputElement(elemId);
        return toNum(input ? input.value : fallback, fallback);
    }

    function getTextareaContext(textarea) {
        const value = String(textarea.value || '');
        const caret = textarea.selectionStart || 0;
        const before = value.slice(0, caret);
        const lineStart = before.lastIndexOf('\n') + 1;
        const lineChunk = before.slice(lineStart);
        const segStartInLine = lineChunk.lastIndexOf(',') + 1;
        const segment = lineChunk.slice(segStartInLine);
        const segAbs = lineStart + segStartInLine;

        const colon = segment.indexOf(':');
        if (colon < 0) {
            const leadingSpaces = (segment.match(/^\s*/) || [''])[0];
            const fragment = segment.slice(leadingSpaces.length).toLowerCase();
            return {
                mode: 'key',
                fragment,
                leadingSpaces,
                segAbs,
                caret,
            };
        }

        const rawKey = segment.slice(0, colon).trim().toLowerCase();
        const afterColon = segment.slice(colon + 1);
        const valueLeadingSpaces = (afterColon.match(/^\s*/) || [''])[0];
        const valueFragment = afterColon.slice(valueLeadingSpaces.length);
        const valueStartAbs = segAbs + colon + 1 + valueLeadingSpaces.length;
        return {
            mode: 'value',
            key: rawKey,
            fragment: valueFragment,
            valueStartAbs,
            caret,
        };
    }

    function keywordCandidates(fragment) {
        const needle = String(fragment || '').trim().toLowerCase();
        if (!needle) return STAGE_KEYS.slice();
        const starts = STAGE_KEYS.filter((k) => k.startsWith(needle));
        const contains = STAGE_KEYS.filter((k) => !k.startsWith(needle) && k.includes(needle));
        return [...starts, ...contains];
    }

    function valueCandidates(key, fragment) {
        const base = (STAGE_VALUE_SUGGESTIONS[key] || []).slice();
        if (key === 'cfg') {
            const cfgNow = getNumericById('txt2img_cfg_scale', NaN);
            if (Number.isFinite(cfgNow)) {
                base.unshift(String(cfgNow));
            }
        }
        if (key === 'steps') {
            const hrSteps = getNumericById('txt2img_hires_steps', NaN);
            const steps = getNumericById('txt2img_steps', NaN);
            if (Number.isFinite(hrSteps)) base.unshift(String(Math.max(0, Math.round(hrSteps))));
            if (Number.isFinite(steps)) base.unshift(String(Math.max(0, Math.round(steps))));
        }

        const unique = [];
        const seen = new Set();
        base.forEach((v) => {
            const s = String(v || '').trim();
            if (!s) return;
            if (seen.has(s)) return;
            seen.add(s);
            unique.push(s);
        });

        const needle = String(fragment || '').trim().toLowerCase();
        if (!needle) return unique.slice(0, 12);
        const starts = unique.filter((x) => x.toLowerCase().startsWith(needle));
        const contains = unique.filter((x) => !x.toLowerCase().startsWith(needle) && x.toLowerCase().includes(needle));
        return [...starts, ...contains].slice(0, 12);
    }

    function validateKeyValue(key, valueText) {
        const keyLc = String(key || '').trim().toLowerCase();
        const val = String(valueText || '').trim();
        if (!val) return false;
        const num = Number(val);
        if (!Number.isFinite(num)) return false;
        if (keyLc === 'scale') return num > 1.0;
        if (keyLc === 'cfg') return true;
        if (keyLc === 'steps') return num >= 0;
        if (keyLc === 'denoise') return num >= 0 && num <= 1;
        return false;
    }

    function buildStageConfigHighlightHtml(text) {
        const src = String(text || '');
        const re = /(^|[\n,]\s*)([^:,\n]+)(\s*:\s*)([^,\n]*)/g;
        let out = '';
        let last = 0;
        let m;

        while ((m = re.exec(src)) !== null) {
            out += escapeHtml(src.slice(last, m.index));
            out += escapeHtml(m[1]);

            const rawKey = m[2] || '';
            const keyLc = rawKey.trim().toLowerCase();
            const isKeyValid = STAGE_KEYS.includes(keyLc);

            if (isKeyValid) {
                out += `<span class="hires-stage-key-valid">${escapeHtml(rawKey)}</span>`;
            } else {
                out += `<span class="hires-stage-key-invalid">${escapeHtml(rawKey)}</span>`;
            }

            out += escapeHtml(m[3]);

            const valueText = m[4] || '';
            if (valueText.trim()) {
                const ok = isKeyValid && validateKeyValue(keyLc, valueText);
                const cls = ok ? 'hires-stage-value-valid' : 'hires-stage-value-invalid';
                out += `<span class="${cls}">${escapeHtml(valueText)}</span>`;
            } else {
                out += escapeHtml(valueText);
            }

            last = re.lastIndex;
        }

        out += escapeHtml(src.slice(last));
        return out.replace(/\n/g, '<br>');
    }

    function parseStageConfigText(text) {
        if (!text) return [];
        const chunks = String(text).split(/\n+/);
        const parsed = [];

        chunks.forEach((chunk) => {
            const line = chunk.trim();
            if (!line) return;

            const stage = {};
            line.split(',').forEach((part) => {
                const item = part.trim();
                if (!item || item.indexOf(':') < 0) return;
                const pair = item.split(':');
                const key = String(pair[0] || '').trim().toLowerCase();
                const value = String(pair.slice(1).join(':') || '').trim();

                if (key === 'scale') {
                    const v = Number(value);
                    if (Number.isFinite(v)) stage.scale = v;
                } else if (key === 'cfg') {
                    const v = Number(value);
                    if (Number.isFinite(v)) stage.cfg = v;
                } else if (key === 'steps') {
                    const v = Number(value);
                    if (Number.isFinite(v)) stage.steps = Math.max(0, Math.round(v));
                } else if (key === 'denoise') {
                    const v = Number(value);
                    if (Number.isFinite(v) && v >= 0 && v <= 1) stage.denoise = v;
                }
            });

            if (!Number.isFinite(stage.scale) || stage.scale <= 1.0) return;
            parsed.push(stage);
        });

        return parsed;
    }

    function roundToLatentGrid(value) {
        const optF = 8;
        return Math.max(optF, Math.round(Number(value) / optF) * optF);
    }

    function computeFinalSize(baseW, baseH, hrScale, hrResizeX, hrResizeY) {
        const w = Math.max(8, Math.round(baseW));
        const h = Math.max(8, Math.round(baseH));
        const rx = Math.max(0, Math.round(hrResizeX));
        const ry = Math.max(0, Math.round(hrResizeY));

        if (rx === 0 && ry === 0) {
            return {
                width: Math.round(w * hrScale),
                height: Math.round(h * hrScale),
            };
        }

        if (ry === 0) {
            return {
                width: rx,
                height: Math.floor(rx * h / w),
            };
        }

        if (rx === 0) {
            return {
                width: Math.floor(ry * w / h),
                height: ry,
            };
        }

        const srcRatio = w / h;
        const dstRatio = rx / ry;
        if (srcRatio < dstRatio) {
            return {
                width: rx,
                height: Math.floor(rx * h / w),
            };
        }

        return {
            width: Math.floor(ry * w / h),
            height: ry,
        };
    }

    function buildStagePlanPreview(baseW, baseH, hrScale, hrResizeX, hrResizeY, stageText) {
        const finalSize = computeFinalSize(baseW, baseH, hrScale, hrResizeX, hrResizeY);
        const finalW = finalSize.width;
        const finalH = finalSize.height;

        let currentW = Math.round(baseW);
        let currentH = Math.round(baseH);
        const stages = [];
        const parsed = parseStageConfigText(stageText);

        parsed.forEach((stage) => {
            let targetW = roundToLatentGrid(baseW * stage.scale);
            let targetH = roundToLatentGrid(baseH * stage.scale);

            targetW = Math.min(targetW, finalW);
            targetH = Math.min(targetH, finalH);

            if (targetW <= currentW && targetH <= currentH) return;

            stages.push({
                targetWidth: targetW,
                targetHeight: targetH,
                toScale: targetW / baseW,
                isFinal: false,
            });
            currentW = targetW;
            currentH = targetH;
        });

        if (currentW !== finalW || currentH !== finalH) {
            stages.push({
                targetWidth: finalW,
                targetHeight: finalH,
                toScale: finalW / baseW,
                isFinal: true,
            });
        }

        return {
            stages,
            finalScale: finalW / baseW,
        };
    }

    function installHrStageConfigAssist() {
        const host = gradioApp().querySelector('#txt2img_hr_stage_config');
        if (!host) return;

        const textarea = host.querySelector('textarea');
        if (!textarea || textarea.dataset.hrStageAssistReady === '1') return;
        textarea.dataset.hrStageAssistReady = '1';

        host.classList.add('hires-stage-assist');

        const highlight = document.createElement('div');
        highlight.className = 'hires-stage-highlight';
        host.appendChild(highlight);

        const hints = document.createElement('div');
        hints.className = 'hires-stage-keyword-hints';
        host.appendChild(hints);

        const titleSpan = host.querySelector('label > span');
        let hintLine = host.querySelector('.hires-stage-config-hint');
        if (!hintLine && titleSpan) {
            hintLine = document.createElement('span');
            hintLine.className = 'hires-stage-config-hint';
            titleSpan.insertAdjacentElement('afterend', hintLine);
        }

        let hintItems = [];
        let hintIndex = -1;
        let lastHintMode = '';

        function syncHighlightLayout() {
            const cs = window.getComputedStyle(textarea);
            const borderTop  = parseFloat(cs.borderTopWidth)  || 0;
            const borderLeft = parseFloat(cs.borderLeftWidth) || 0;
            highlight.style.top  = `${textarea.offsetTop  + borderTop}px`;
            highlight.style.left = `${textarea.offsetLeft + borderLeft}px`;
            highlight.style.width = `${textarea.clientWidth}px`;
            highlight.style.height = `${textarea.clientHeight}px`;
            highlight.style.paddingTop = cs.paddingTop;
            highlight.style.paddingRight = cs.paddingRight;
            highlight.style.paddingBottom = cs.paddingBottom;
            highlight.style.paddingLeft = cs.paddingLeft;
            highlight.style.font = cs.font;
            highlight.style.lineHeight = cs.lineHeight;
            highlight.style.letterSpacing = cs.letterSpacing;
            highlight.style.wordSpacing = cs.wordSpacing;
            highlight.style.textAlign = cs.textAlign;
            highlight.style.tabSize = cs.tabSize;
        }

        function syncHighlight() {
            highlight.innerHTML = buildStageConfigHighlightHtml(textarea.value || '');
            highlight.scrollTop = textarea.scrollTop;
            highlight.scrollLeft = textarea.scrollLeft;
        }

        function hideHints() {
            hints.style.display = 'none';
            hints.innerHTML = '';
            hintItems = [];
            hintIndex = -1;
        }

        function updateHintActive() {
            const rows = hints.querySelectorAll('.hires-stage-keyword-hint');
            rows.forEach((row, idx) => {
                row.classList.toggle('active', idx === hintIndex);
            });
        }

        function applyCandidate(candidate) {
            const ctx = getTextareaContext(textarea);
            if (!ctx) return;

            const value = String(textarea.value || '');
            let nextValue = value;
            let newCaret = ctx.caret;

            if (ctx.mode === 'key') {
                const replacement = `${ctx.leadingSpaces}${candidate}: `;
                nextValue = `${value.slice(0, ctx.segAbs)}${replacement}${value.slice(ctx.caret)}`;
                newCaret = ctx.segAbs + replacement.length;
            } else if (ctx.mode === 'value') {
                nextValue = `${value.slice(0, ctx.valueStartAbs)}${candidate}${value.slice(ctx.caret)}`;
                newCaret = ctx.valueStartAbs + candidate.length;
            }

            textarea.value = nextValue;
            textarea.selectionStart = newCaret;
            textarea.selectionEnd = newCaret;
            textarea.dispatchEvent(new Event('input', { bubbles: true }));
            hideHints();
        }

        function renderHints() {
            const ctx = getTextareaContext(textarea);
            if (!ctx) {
                hideHints();
                return;
            }

            const prevChosen = hintItems[Math.max(0, hintIndex)] || '';
            const mode = ctx.mode;
            hintItems = mode === 'value'
                ? valueCandidates(ctx.key, ctx.fragment)
                : keywordCandidates(ctx.fragment);

            if (!hintItems.length) {
                hideHints();
                return;
            }

            hints.innerHTML = hintItems
                .map((k) => `<button type="button" class="hires-stage-keyword-hint">${escapeHtml(k)}</button>`)
                .join('');
            hints.style.display = 'block';

            if (mode === lastHintMode && prevChosen) {
                const prevIdx = hintItems.indexOf(prevChosen);
                hintIndex = prevIdx >= 0 ? prevIdx : 0;
            } else {
                hintIndex = 0;
            }
            lastHintMode = mode;
            updateHintActive();

            const buttons = Array.from(hints.querySelectorAll('.hires-stage-keyword-hint'));
            buttons.forEach((btn, idx) => {
                btn.addEventListener('mousedown', (e) => {
                    e.preventDefault();
                    applyCandidate(hintItems[idx]);
                });
            });
        }

        function renderHintLine() {
            if (!hintLine) return;

            const enableHrHost = gradioApp().querySelector('#txt2img_hr');
            const enabled = enableHrHost ? Boolean(enableHrHost.querySelector('input[type="checkbox"]:checked')) : false;
            if (!enabled) {
                hintLine.textContent = 'Hires. fix disabled';
                return;
            }

            const w = Math.max(8, getNumericById('txt2img_width', 512));
            const h = Math.max(8, getNumericById('txt2img_height', 512));
            const hrScale = Math.max(1.0, getNumericById('txt2img_hr_scale', 2.0));
            const hrResizeX = Math.max(0, getNumericById('txt2img_hr_resize_x', 0));
            const hrResizeY = Math.max(0, getNumericById('txt2img_hr_resize_y', 0));

            const preview = buildStagePlanPreview(w, h, hrScale, hrResizeX, hrResizeY, textarea.value || '');
            const scales = preview.stages.map((s) => formatScale(s.toScale));
            const lastIsOriginStage = preview.stages.length > 0 && preview.stages[preview.stages.length - 1].isFinal;
            const stagePart = scales.length ? scales.join(' -> ') : '(no valid stage)';
            const originPart = lastIsOriginStage ? ' + origin' : '';
            hintLine.textContent = `${preview.stages.length} stage(s) | final ${formatScale(preview.finalScale)} | ${stagePart}${originPart}`;
        }

        textarea.addEventListener('input', () => {
            syncHighlight();
            renderHints();
            renderHintLine();
        });
        textarea.addEventListener('click', renderHints);
        textarea.addEventListener('keyup', (e) => {
            if (['ArrowDown', 'ArrowUp', 'Enter', 'Tab', 'Escape'].includes(e.key)) return;
            renderHints();
        });
        textarea.addEventListener('focus', () => {
            syncHighlightLayout();
            syncHighlight();
            renderHints();
        });
        textarea.addEventListener('scroll', syncHighlight);
        textarea.addEventListener('blur', () => {
            setTimeout(hideHints, 120);
        });

        textarea.addEventListener('keydown', (e) => {
            if (hints.style.display !== 'block' || !hintItems.length) return;
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                hintIndex = (hintIndex + 1) % hintItems.length;
                updateHintActive();
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                hintIndex = (hintIndex - 1 + hintItems.length) % hintItems.length;
                updateHintActive();
            } else if (e.key === 'Enter' || e.key === 'Tab') {
                const ctx = getTextareaContext(textarea);
                if (!ctx) return;
                e.preventDefault();
                applyCandidate(hintItems[Math.max(0, hintIndex)]);
            } else if (e.key === 'Escape') {
                hideHints();
            }
        });

        const refreshPlanInputs = [
            'txt2img_width',
            'txt2img_height',
            'txt2img_hr_scale',
            'txt2img_hr_resize_x',
            'txt2img_hr_resize_y',
            'txt2img_hr',
        ];

        refreshPlanInputs.forEach((id) => {
            const host = gradioApp().querySelector(`#${id}`);
            if (!host) return;
            host.addEventListener('input', renderHintLine, true);
            host.addEventListener('change', renderHintLine, true);
            host.addEventListener('click', renderHintLine, true);
        });

        [0, 80, 180, 380].forEach((ms) => {
            setTimeout(() => {
                syncHighlightLayout();
                syncHighlight();
                renderHintLine();
            }, ms);
        });
        window.addEventListener('resize', syncHighlightLayout);

        // Hook the textarea's native value setter so Gradio/Svelte restoring
        // a value (e.g. "Send to txt2img") immediately refreshes the highlight.
        (() => {
            const desc = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value');
            if (!desc || !desc.set) return;
            Object.defineProperty(textarea, 'value', {
                get() { return desc.get.call(this); },
                set(v) {
                    desc.set.call(this, v);
                    syncHighlight();
                    renderHintLine();
                },
                configurable: true,
            });
        })();
    }

    onUiLoaded(installHrStageConfigAssist);
    onAfterUiUpdate(installHrStageConfigAssist);
})();
