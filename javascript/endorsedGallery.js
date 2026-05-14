/**
 * endorsedGallery.js
 * Handles all client-side interactions for the Endorsed Gallery tab.
 *
 * Exposed on window.endorsedGallery:
 *   .action(actionDataB64)       – endorse or remove a card via hidden Gradio bus
 *   .copyParams(infotextB64)     – copy raw infotext to clipboard
 *   .sendTo(infotextB64, target) – paste params into txt2img or img2img
 *   .queueTxt2ImgFire(...)       – queue txt2img jobs with fire override config
 */

(function () {
    'use strict';

    const FIRE_CANONICAL_KEYS = [
        'Prompt',
        'Negative prompt',
        'Enable Hires fix',
        'Steps',
        'Sampler',
        'Schedule type',
        'CFG scale',
        'Seed',
        'Width',
        'Height',
        'Denoising strength',
        'Hires upscale',
        'Hires upscaler',
        'Hires steps',
        'Hires resize-1',
        'Hires resize-2',
        'Batch count',
        'Batch size',
    ];

    const FIRE_KEY_ALIASES = {
        prompt: 'Prompt',
        neg: 'Negative prompt',
        negative: 'Negative prompt',
        'negative prompt': 'Negative prompt',
        'enable hires fix': 'Enable Hires fix',
        'hires fix': 'Enable Hires fix',
        'enable hr fix': 'Enable Hires fix',
        'enable_hires_fix': 'Enable Hires fix',
        'enable_hr': 'Enable Hires fix',
        step: 'Steps',
        steps: 'Steps',
        sampler: 'Sampler',
        schedule: 'Schedule type',
        scheduler: 'Schedule type',
        'schedule type': 'Schedule type',
        cfg: 'CFG scale',
        'cfg scale': 'CFG scale',
        seed: 'Seed',
        width: 'Width',
        w: 'Width',
        height: 'Height',
        h: 'Height',
        denoise: 'Denoising strength',
        denoising: 'Denoising strength',
        'denoising strength': 'Denoising strength',
        'hires upscale': 'Hires upscale',
        'hires upscaler': 'Hires upscaler',
        'hires steps': 'Hires steps',
        'hires resize-1': 'Hires resize-1',
        'hires resize-2': 'Hires resize-2',
        'hr upscale': 'Hires upscale',
        'hr upscaler': 'Hires upscaler',
        'hr steps': 'Hires steps',
        'batch count': 'Batch count',
        'batch_count': 'Batch count',
        'bc': 'Batch count',
        'batch size': 'Batch size',
        'batch_size': 'Batch size',
        'bs': 'Batch size',
    };

    const FIRE_VALUE_SUGGEST_DEFAULTS = {
        'Enable Hires fix': [
            'true',
            'false',
        ],
        'Sampler': [
            'Euler',
            'Euler a',
            'DPM++ 2M',
            'DPM++ 2M Karras',
            'DPM++ SDE',
            'DPM++ SDE Karras',
            'DDIM',
        ],
        'Hires upscaler': [
            'Latent',
            'Latent (antialiased)',
            'Latent (bicubic)',
            'Latent (bicubic antialiased)',
            'Lanczos',
            'ESRGAN_4x',
        ],
        'Schedule type': [
            'Automatic',
            'Karras',
            'Exponential',
            'Polyexponential',
            'SGM Uniform',
        ],
    };

    const FIRE_CONFIG_STORAGE_KEY = 'endgal_fire_override_config_last';

    let previewOverlay = null;
    let previewImage = null;
    let previewList = [];
    let previewIndex = -1;
    let previewLikeBtn = null;
    let previewDislikeBtn = null;
    let previewDownloadBtn = null;
    let actionUndoStack = [];
    let actionRedoStack = [];
    let zoomScale = 1;
    let panX = 0;
    let panY = 0;
    let isDragging = false;
    let dragStartX = 0;
    let dragStartY = 0;
    let dragOriginX = 0;
    let dragOriginY = 0;
    let suppressTxt2imgSwitch = false;
    let txt2imgSwitchGuardReady = false;
    let fireDbSuggestRawCache = '';
    let fireDbSuggestParsedCache = {};

    // ---------------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------------

    /** Decode a base64 string to UTF-8 text (handles unicode correctly). */
    function b64Decode(b64) {
        try {
            return decodeURIComponent(
                atob(b64).split('').map(c =>
                    '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2)
                ).join('')
            );
        } catch (e) {
            return atob(b64);
        }
    }

    function b64Encode(text) {
        const bytes = encodeURIComponent(text).replace(/%([0-9A-F]{2})/g, (_, p1) => {
            return String.fromCharCode(parseInt(p1, 16));
        });
        return btoa(bytes);
    }

    function escapeRegex(text) {
        return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    function parseActionB64(actionDataB64) {
        try {
            return JSON.parse(b64Decode(actionDataB64));
        } catch (_e) {
            return null;
        }
    }

    function makeInverseAction(action) {
        if (!action || !action.type) return null;
        if (action.type === 'endorse') return { ...action, type: 'remove_endorse' };
        if (action.type === 'remove_endorse') return { ...action, type: 'endorse' };
        if (action.type === 'dislike') return { ...action, type: 'remove_dislike' };
        if (action.type === 'remove_dislike') return { ...action, type: 'dislike' };
        return null;
    }

    function shouldConfirmConflict(action) {
        if (!action || !action.type) return false;
        if (!(action.type === 'endorse' || action.type === 'dislike')) return false;
        return Boolean(action.opposite_active);
    }

    function confirmConflict(action) {
        if (!shouldConfirmConflict(action)) return true;
        if (action.type === 'endorse') {
            return window.confirm('This image is currently disliked. Switch to liked and remove dislike?');
        }
        if (action.type === 'dislike') {
            return window.confirm('This image is currently liked. Switch to disliked and remove like?');
        }
        return true;
    }

    function executeAction(actionDataB64, { recordHistory = true, clearRedo = true } = {}) {
        const action = parseActionB64(actionDataB64);
        if (!action) return;
        if (!confirmConflict(action)) return;

        if (recordHistory) {
            const inverse = makeInverseAction(action);
            if (inverse) {
                actionUndoStack.push({
                    forward: actionDataB64,
                    backward: b64Encode(JSON.stringify(inverse)),
                });
                if (actionUndoStack.length > 200) actionUndoStack.shift();
                if (clearRedo) actionRedoStack = [];
            }
        }

        const json = JSON.stringify(action);
        if (!setGradioTextbox('endorsed_gallery_action_input', json)) {
            console.warn('[endorsedGallery] action input not found');
            return;
        }
        clickGradioBtn('endorsed_gallery_action_btn');
    }

    /** Set a Gradio textbox value and fire the input event so Gradio notices. */
    function setGradioTextbox(elemId, value) {
        const el = gradioApp().querySelector(`#${elemId} textarea`);
        if (!el) return false;
        const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
            window.HTMLTextAreaElement.prototype, 'value'
        ).set;
        nativeInputValueSetter.call(el, value);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
    }

    /** Click a Gradio button element by its elem_id. */
    function clickGradioBtn(elemId, delay = 80) {
        setTimeout(() => {
            // Gradio renders gr.Button as <button id="...">
            const btn = gradioApp().querySelector(`#${elemId}`);
            if (btn) btn.click();
        }, delay);
    }

    function switchToTabByName(name) {
        const tabHost = gradioApp().querySelector('#tabs div');
        if (!tabHost) return;
        const target = (name || '').trim().toLowerCase();
        const tabButtons = tabHost.querySelectorAll('button');
        tabButtons.forEach((btn) => {
            if (btn.textContent.trim().toLowerCase().includes(target)) {
                btn.click();
            }
        });
    }

    function toFileServeUrl(absPath) {
        const normalized = String(absPath || '').replace(/\\/g, '/');
        return `/file=${encodeURIComponent(normalized)}`;
    }

    function getComponentInputValue(elemId) {
        const host = gradioApp().querySelector(`#${elemId}`);
        if (!host) return '';
        const input = host.querySelector('input, textarea, select');
        return input ? String(input.value || '').trim() : '';
    }

    function sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    function ensureTxt2ImgSwitchGuard() {
        if (txt2imgSwitchGuardReady) return;
        const original = window.switch_to_txt2img;
        if (typeof original !== 'function') return;

        window.switch_to_txt2img = function (...args) {
            if (suppressTxt2imgSwitch) {
                return;
            }
            return original.apply(this, args);
        };
        txt2imgSwitchGuardReady = true;
    }

    function escapeHtml(text) {
        return String(text || '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function normalizeKeywordKey(key) {
        const cleaned = String(key || '').trim().toLowerCase().replace(/\s+/g, ' ');
        if (!cleaned) return '';
        if (FIRE_KEY_ALIASES[cleaned]) return FIRE_KEY_ALIASES[cleaned];

        const canonical = FIRE_CANONICAL_KEYS.find((k) => k.toLowerCase() === cleaned);
        return canonical || '';
    }

    function buildKeywordHighlightHtml(text) {
        const src = String(text || '');
        const re = /(^|[,\n]\s*)([^:,\n]+)(\s*:\s*)((?:\[[^\]\n]*\]|"(?:\\.|[^"\\])*"|[^,\n])*)/g;
        let out = '';
        let last = 0;
        let m;

        while ((m = re.exec(src)) !== null) {
            out += escapeHtml(src.slice(last, m.index));
            out += escapeHtml(m[1]);
            const canonicalKey = normalizeKeywordKey(m[2]);
            if (canonicalKey) {
                out += `<span class="endgal-fire-key-valid">${escapeHtml(m[2])}</span>`;
            } else {
                out += escapeHtml(m[2]);
            }
            out += escapeHtml(m[3]);

            let valueText = m[4] || '';
            if (canonicalKey) {
                let valueCheck = validateValueForKey(canonicalKey, valueText);
                const variants = parseValueVariants(valueText);
                if (!valueCheck.ok && !variants.error && variants.values.length > 1) {
                    const allValid = variants.values.every((one) => validateValueForKey(canonicalKey, one).ok);
                    valueCheck = { ok: allValid, reason: allValid ? '' : valueCheck.reason };
                }
                if (valueText.trim()) {
                    if (valueCheck.ok) {
                        out += `<span class="endgal-fire-value-valid">${escapeHtml(valueText)}</span>`;
                    } else {
                        out += `<span class="endgal-fire-value-invalid">${escapeHtml(valueText)}</span>`;
                    }
                } else {
                    out += escapeHtml(valueText);
                }
            } else {
                out += escapeHtml(valueText);
            }
            last = re.lastIndex;
        }

        out += escapeHtml(src.slice(last));
        return out.replace(/\n/g, '<br>');
    }

    function currentKeywordFragment(textarea) {
        const value = String(textarea.value || '');
        const caret = textarea.selectionStart || 0;
        const before = value.slice(0, caret);
        const lineStart = before.lastIndexOf('\n') + 1;
        const lineChunk = before.slice(lineStart);
        const segStartInLine = lineChunk.lastIndexOf(',') + 1;
        const segment = lineChunk.slice(segStartInLine);

        if (segment.includes(':')) return null;
        const leadingSpaces = (segment.match(/^\s*/) || [''])[0];
        const fragment = segment.slice(leadingSpaces.length);
        return {
            fragment,
            lineStart,
            segStartInLine,
            leadingSpaces,
        };
    }

    function keywordCandidates(fragment) {
        const needle = String(fragment || '').trim().toLowerCase();
        if (!needle) return FIRE_CANONICAL_KEYS.slice(0, 12);

        const starts = [];
        const contains = [];
        const seen = new Set();

        Object.entries(FIRE_KEY_ALIASES).forEach(([alias, canonical]) => {
            const scoreSrc = `${alias} ${canonical}`.toLowerCase();
            if (!scoreSrc.includes(needle)) return;
            if (seen.has(canonical)) return;
            seen.add(canonical);
            if (canonical.toLowerCase().startsWith(needle) || alias.startsWith(needle)) {
                starts.push(canonical);
            } else {
                contains.push(canonical);
            }
        });

        return [...starts, ...contains].slice(0, 12);
    }

    function getDropdownChoicesByElemId(elemId) {
        const host = gradioApp().querySelector(`#${elemId}`);
        if (!host) return [];

        const select = host.querySelector('select');
        if (!select) return [];

        return Array.from(select.querySelectorAll('option'))
            .map((opt) => String(opt.textContent || '').trim())
            .filter(Boolean);
    }

    function uniqStrings(values) {
        const seen = new Set();
        const out = [];
        (values || []).forEach((v) => {
            const s = String(v || '').trim();
            if (!s) return;
            const key = s.toLowerCase();
            if (seen.has(key)) return;
            seen.add(key);
            out.push(s);
        });
        return out;
    }

    function valueCandidatesForKey(canonicalKey, fragment) {
        const key = String(canonicalKey || '');
        const needle = String(fragment || '').trim().toLowerCase();
        const pool = getAllValueChoicesForKey(key);
        if (!pool.length) return [];

        if (!needle) return pool.slice(0, 12);

        const starts = pool.filter((x) => x.toLowerCase().startsWith(needle));
        const contains = pool.filter((x) => !x.toLowerCase().startsWith(needle) && x.toLowerCase().includes(needle));
        return [...starts, ...contains].slice(0, 12);
    }

    function getAllValueChoicesForKey(canonicalKey) {
        const key = String(canonicalKey || '');
        if (key === 'Prompt' || key === 'Negative prompt') {
            return getDbValueSuggestionsForKey(key);
        }
        if (key === 'Enable Hires fix') {
            return uniqStrings([...(FIRE_VALUE_SUGGEST_DEFAULTS['Enable Hires fix'] || [])]);
        }
        if (key === 'Sampler') {
            return uniqStrings([
                ...getDropdownChoicesByElemId('txt2img_sampling'),
                ...getDropdownChoicesByElemId('img2img_sampling'),
                ...(FIRE_VALUE_SUGGEST_DEFAULTS['Sampler'] || []),
            ]);
        }
        if (key === 'Hires upscaler') {
            return uniqStrings([
                ...getDropdownChoicesByElemId('txt2img_hr_upscaler'),
                ...(FIRE_VALUE_SUGGEST_DEFAULTS['Hires upscaler'] || []),
            ]);
        }
        if (key === 'Schedule type') {
            return uniqStrings([
                ...getDropdownChoicesByElemId('txt2img_scheduler'),
                ...getDropdownChoicesByElemId('img2img_scheduler'),
                ...(FIRE_VALUE_SUGGEST_DEFAULTS['Schedule type'] || []),
            ]);
        }
        return [];
    }

    function parseDbSuggestionPayload(raw) {
        if (!raw) return {};
        try {
            const parsed = JSON.parse(raw);
            return (parsed && typeof parsed === 'object') ? parsed : {};
        } catch (_e) {
            return {};
        }
    }

    function getDbValueSuggestionsForKey(canonicalKey) {
        const raw = getComponentInputValue('endgal_fire_value_suggestions_json');
        if (raw !== fireDbSuggestRawCache) {
            fireDbSuggestRawCache = raw;
            fireDbSuggestParsedCache = parseDbSuggestionPayload(raw);
        }

        const values = fireDbSuggestParsedCache && fireDbSuggestParsedCache[canonicalKey];
        if (!Array.isArray(values)) return [];
        return uniqStrings(values).slice(0, 300);
    }

    function currentPromptTokenContext(textarea) {
        const value = String(textarea.value || '');
        const caret = textarea.selectionStart || 0;
        const before = value.slice(0, caret);

        let segStart = 0;
        for (let i = before.length - 1; i >= 0; i -= 1) {
            const ch = before[i];
            if (ch === ',' || ch === '\n' || ch === '\r') {
                segStart = i + 1;
                break;
            }
        }

        const segment = before.slice(segStart);
        const leadingSpaces = (segment.match(/^\s*/) || [''])[0];
        const fragment = segment.slice(leadingSpaces.length);
        return {
            fragment,
            tokenStartAbs: segStart + leadingSpaces.length,
            caret,
        };
    }

    function promptValueCandidates(canonicalKey, fragment) {
        const needle = String(fragment || '').trim().toLowerCase();
        const pool = getDbValueSuggestionsForKey(canonicalKey);
        if (!pool.length) return [];
        // Prompt editor assist should only show after the user types token chars.
        if (!needle) return [];

        const starts = pool.filter((x) => x.toLowerCase().startsWith(needle));
        const contains = pool.filter((x) => !x.toLowerCase().startsWith(needle) && x.toLowerCase().includes(needle));
        return [...starts, ...contains].slice(0, 12);
    }

    function setupPromptKeywordAssistForHost(host, canonicalKey) {
        if (!host) return;
        const textarea = host.querySelector('textarea');
        if (!textarea || textarea.dataset.endgalPromptAssistReady === '1') return;
        textarea.dataset.endgalPromptAssistReady = '1';

        host.style.position = 'relative';

        const hints = document.createElement('div');
        hints.className = 'endgal-fire-keyword-hints endgal-prompt-keyword-hints';
        host.appendChild(hints);

        let hintItems = [];
        let hintIndex = -1;

        function setPromptHintsOpen(open) {
            host.classList.toggle('endgal-prompt-hints-open', Boolean(open));
        }

        function hideHints() {
            hints.style.display = 'none';
            hints.innerHTML = '';
            hintItems = [];
            hintIndex = -1;
            setPromptHintsOpen(false);
        }

        function updateHintActive() {
            const rows = hints.querySelectorAll('.endgal-fire-keyword-hint');
            rows.forEach((row, idx) => {
                row.classList.toggle('active', idx === hintIndex);
            });
        }

        function applyCandidate(candidate) {
            const ctx = currentPromptTokenContext(textarea);
            if (!ctx) return;

            const value = String(textarea.value || '');
            const replacement = candidate;
            const nextValue = `${value.slice(0, ctx.tokenStartAbs)}${replacement}${value.slice(ctx.caret)}`;
            const newCaret = ctx.tokenStartAbs + replacement.length;

            textarea.value = nextValue;
            textarea.selectionStart = newCaret;
            textarea.selectionEnd = newCaret;
            textarea.dispatchEvent(new Event('input', { bubbles: true }));
            hideHints();
        }

        function renderHints() {
            const ctx = currentPromptTokenContext(textarea);
            const items = promptValueCandidates(canonicalKey, ctx.fragment);
            if (!items.length) {
                hideHints();
                return;
            }

            const prev = hintItems[Math.max(0, hintIndex)] || '';
            hintItems = items;
            hints.innerHTML = hintItems
                .map((k) => `<button type="button" class="endgal-fire-keyword-hint">${escapeHtml(k)}</button>`)
                .join('');
            hints.style.display = 'block';
            setPromptHintsOpen(true);

            const prevIdx = prev ? hintItems.indexOf(prev) : -1;
            hintIndex = prevIdx >= 0 ? prevIdx : 0;
            updateHintActive();

            const buttons = Array.from(hints.querySelectorAll('.endgal-fire-keyword-hint'));
            buttons.forEach((btn, idx) => {
                btn.addEventListener('mousedown', (e) => {
                    e.preventDefault();
                    applyCandidate(hintItems[idx]);
                });
            });
        }

        textarea.addEventListener('input', renderHints);
        textarea.addEventListener('click', renderHints);
        textarea.addEventListener('focus', renderHints);
        textarea.addEventListener('blur', () => {
            setTimeout(hideHints, 120);
        });

        textarea.addEventListener('keyup', (e) => {
            if (['ArrowDown', 'ArrowUp', 'Enter', 'Tab', 'Escape'].includes(e.key)) return;
            renderHints();
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
                e.preventDefault();
                applyCandidate(hintItems[Math.max(0, hintIndex)]);
            } else if (e.key === 'Escape') {
                hideHints();
            }
        });

        renderHints();
    }

    function setupPromptKeywordAssist() {
        const app = gradioApp();
        if (!app) return;

        const hosts = [
            { ids: ['txt2img_prompt'], key: 'Prompt' },
            { ids: ['txt2img_neg_prompt', 'txt2img_negative_prompt'], key: 'Negative prompt' },
            { ids: ['img2img_prompt'], key: 'Prompt' },
            { ids: ['img2img_neg_prompt', 'img2img_negative_prompt'], key: 'Negative prompt' },
        ];

        hosts.forEach((entry) => {
            let host = null;
            for (let i = 0; i < entry.ids.length; i += 1) {
                host = app.querySelector(`#${entry.ids[i]}`);
                if (host) break;
            }
            if (host) {
                setupPromptKeywordAssistForHost(host, entry.key);
            }
        });
    }

    function validateValueForKey(canonicalKey, value) {
        const key = String(canonicalKey || '').trim();
        const raw = String(value || '').trim();
        if (!key) return { ok: true };
        if (!raw) return { ok: false, reason: `empty value for '${key}'` };

        const lower = raw.toLowerCase();
        const enumChoices = getAllValueChoicesForKey(key);
        if (enumChoices.length) {
            const matched = enumChoices.some((x) => x.toLowerCase() === lower);
            return matched
                ? { ok: true, normalized: enumChoices.find((x) => x.toLowerCase() === lower) || raw }
                : { ok: false, reason: `invalid value '${raw}' for '${key}'` };
        }

        function asNumber() {
            const n = Number(raw);
            return Number.isFinite(n) ? n : null;
        }

        function asInteger() {
            if (!/^-?\d+$/.test(raw)) return null;
            const n = Number(raw);
            return Number.isFinite(n) ? n : null;
        }

        if (key === 'Steps') {
            const n = asInteger();
            return (n !== null && n >= 1) ? { ok: true } : { ok: false, reason: `Steps must be an integer >= 1` };
        }
        if (key === 'Hires steps') {
            const n = asInteger();
            return (n !== null && n >= 0) ? { ok: true } : { ok: false, reason: `Hires steps must be an integer >= 0` };
        }
        if (key === 'Width' || key === 'Height' || key === 'Hires resize-1' || key === 'Hires resize-2') {
            const n = asInteger();
            return (n !== null && n >= 0) ? { ok: true } : { ok: false, reason: `${key} must be an integer >= 0` };
        }
        if (key === 'CFG scale') {
            const n = asNumber();
            return (n !== null && n >= 0) ? { ok: true } : { ok: false, reason: `CFG scale must be a number >= 0` };
        }
        if (key === 'Denoising strength') {
            const n = asNumber();
            return (n !== null && n >= 0 && n <= 1) ? { ok: true } : { ok: false, reason: `Denoising strength must be between 0 and 1` };
        }
        if (key === 'Hires upscale') {
            const n = asNumber();
            return (n !== null && n >= 1) ? { ok: true } : { ok: false, reason: `Hires upscale must be a number >= 1` };
        }
        if (key === 'Seed') {
            const n = asInteger();
            return (n !== null) ? { ok: true } : { ok: false, reason: `Seed must be an integer` };
        }
        if (key === 'Batch count') {
            const n = asInteger();
            return (n !== null && n >= 1) ? { ok: true } : { ok: false, reason: `Batch count must be an integer >= 1` };
        }
        if (key === 'Batch size') {
            const n = asInteger();
            return (n !== null && n >= 1) ? { ok: true } : { ok: false, reason: `Batch size must be an integer >= 1` };
        }

        return { ok: true };
    }

    function currentAssistContext(textarea) {
        const value = String(textarea.value || '');
        const caret = textarea.selectionStart || 0;
        const before = value.slice(0, caret);
        const lineStart = before.lastIndexOf('\n') + 1;
        const lineChunk = before.slice(lineStart);
        const segStartInLine = (() => {
            let inQuote = false;
            let depth = 0;
            let lastComma = -1;
            for (let i = 0; i < lineChunk.length; i += 1) {
                const ch = lineChunk[i];
                if (ch === '"') {
                    inQuote = !inQuote;
                    continue;
                }
                if (inQuote) continue;
                if (ch === '[') {
                    depth += 1;
                    continue;
                }
                if (ch === ']') {
                    depth = Math.max(0, depth - 1);
                    continue;
                }
                if (ch === ',' && depth === 0) {
                    lastComma = i;
                }
            }
            return lastComma + 1;
        })();
        const segment = lineChunk.slice(segStartInLine);
        const segAbs = lineStart + segStartInLine;

        const colon = segment.indexOf(':');
        if (colon < 0) {
            const leadingSpaces = (segment.match(/^\s*/) || [''])[0];
            const fragment = segment.slice(leadingSpaces.length);
            return {
                mode: 'key',
                fragment,
                leadingSpaces,
                segAbs,
                caret,
            };
        }

        const rawKey = segment.slice(0, colon).trim();
        const canonicalKey = normalizeKeywordKey(rawKey) || rawKey;
        const afterColon = segment.slice(colon + 1);
        const valueLeadingSpaces = (afterColon.match(/^\s*/) || [''])[0];
        const valueFragment = afterColon.slice(valueLeadingSpaces.length);
        const valueStartAbs = segAbs + colon + 1 + valueLeadingSpaces.length;

        return {
            mode: 'value',
            key: canonicalKey,
            fragment: valueFragment,
            valueStartAbs,
            caret,
        };
    }

    function setupFireConfigAssist() {
        const host = gradioApp().querySelector('#endgal_hires_override_config');
        if (!host) return;

        const textarea = host.querySelector('textarea');
        if (!textarea || textarea.dataset.endgalFireAssistReady === '1') return;
        textarea.dataset.endgalFireAssistReady = '1';

        host.style.position = 'relative';

        const highlight = document.createElement('div');
        highlight.className = 'endgal-fire-highlight';
        host.appendChild(highlight);

        const hints = document.createElement('div');
        hints.className = 'endgal-fire-keyword-hints';
        host.appendChild(hints);

        let hintIndex = -1;
        let hintItems = [];
        let lastHintMode = '';

        const titleLabel = host.querySelector('label > span');
        let errorBadge = host.querySelector('.endgal-fire-config-error');
        let jobsBadge = host.querySelector('.endgal-fire-config-jobs');
        if (!jobsBadge && titleLabel) {
            jobsBadge = document.createElement('span');
            jobsBadge.className = 'endgal-fire-config-jobs';
            titleLabel.insertAdjacentElement('afterend', jobsBadge);
        }
        if (!errorBadge && titleLabel) {
            errorBadge = document.createElement('span');
            errorBadge.className = 'endgal-fire-config-error';
            if (jobsBadge) {
                jobsBadge.insertAdjacentElement('afterend', errorBadge);
            } else {
                titleLabel.insertAdjacentElement('afterend', errorBadge);
            }
        }

        function loadSavedFireConfig() {
            try {
                return localStorage.getItem(FIRE_CONFIG_STORAGE_KEY) || '';
            } catch (_e) {
                return '';
            }
        }

        function persistFireConfig(raw) {
            try {
                localStorage.setItem(FIRE_CONFIG_STORAGE_KEY, String(raw || ''));
            } catch (_e) {
                // Ignore storage failures (private mode/quota/security settings).
            }
        }

        function applyValidationState() {
            const result = validateFireOverrideConfig(textarea.value || '');
            host.classList.toggle('endgal-fire-config-invalid', !result.valid);

            if (jobsBadge) {
                const expanded = buildExpandedOverrideSets(textarea.value || '');
                const count = Math.max(1, expanded.count || 1);
                jobsBadge.textContent = `  (${count} jobs)`;
                jobsBadge.title = `${count} jobs will be queued`;
                jobsBadge.style.display = 'inline';
            }

            if (!errorBadge) return;
            if (!result.valid) {
                errorBadge.textContent = `  ${result.errors[0]}`;
                errorBadge.title = result.errors.join('\n');
                errorBadge.style.display = 'inline';
            } else {
                errorBadge.textContent = '';
                errorBadge.title = '';
                errorBadge.style.display = 'none';
            }
        }

        function syncHighlightLayout() {
            const cs = window.getComputedStyle(textarea);
            highlight.style.top = `${textarea.offsetTop}px`;
            highlight.style.left = `${textarea.offsetLeft}px`;
            highlight.style.width = `${textarea.clientWidth}px`;
            highlight.style.height = `${textarea.clientHeight}px`;
            highlight.style.paddingTop = cs.paddingTop;
            highlight.style.paddingRight = cs.paddingRight;
            highlight.style.paddingBottom = cs.paddingBottom;
            highlight.style.paddingLeft = cs.paddingLeft;
            highlight.style.font = cs.font;
            highlight.style.lineHeight = cs.lineHeight;
            highlight.style.letterSpacing = cs.letterSpacing;
            highlight.style.textAlign = cs.textAlign;
            highlight.style.tabSize = cs.tabSize;
        }

        function warmupHighlightSync() {
            [0, 80, 180, 380, 800].forEach((ms) => {
                setTimeout(() => {
                    syncHighlightLayout();
                    syncHighlight();
                }, ms);
            });

            if (document.fonts && document.fonts.ready) {
                document.fonts.ready.then(() => {
                    syncHighlightLayout();
                    syncHighlight();
                }).catch(() => {});
            }
        }

        function hideHints() {
            hints.style.display = 'none';
            hints.innerHTML = '';
            hintItems = [];
            hintIndex = -1;
        }

        function updateHintActive() {
            const rows = hints.querySelectorAll('.endgal-fire-keyword-hint');
            rows.forEach((row, idx) => {
                row.classList.toggle('active', idx === hintIndex);
            });
        }

        function applyCandidate(candidate) {
            const ctx = currentAssistContext(textarea);
            if (!ctx) return;

            const value = String(textarea.value || '');
            const caret = textarea.selectionStart || 0;
            let nextValue = value;
            let newCaret = caret;

            if (ctx.mode === 'key') {
                const replacement = `${ctx.leadingSpaces}${candidate}: `;
                nextValue = `${value.slice(0, ctx.segAbs)}${replacement}${value.slice(caret)}`;
                newCaret = ctx.segAbs + replacement.length;
            } else if (ctx.mode === 'value') {
                nextValue = `${value.slice(0, ctx.valueStartAbs)}${candidate}${value.slice(caret)}`;
                newCaret = ctx.valueStartAbs + candidate.length;
            }

            textarea.value = nextValue;
            textarea.selectionStart = newCaret;
            textarea.selectionEnd = newCaret;
            textarea.dispatchEvent(new Event('input', { bubbles: true }));
            hideHints();
        }

        function renderHints() {
            const ctx = currentAssistContext(textarea);
            if (!ctx) {
                hideHints();
                return;
            }

            const prevChosen = hintItems[Math.max(0, hintIndex)] || '';
            const mode = ctx.mode;
            hintItems = mode === 'value'
                ? valueCandidatesForKey(ctx.key, ctx.fragment)
                : keywordCandidates(ctx.fragment);

            if (!hintItems.length) {
                hideHints();
                return;
            }

            hints.innerHTML = hintItems
                .map((k) => `<button type="button" class="endgal-fire-keyword-hint">${escapeHtml(k)}</button>`)
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

            const buttons = Array.from(hints.querySelectorAll('.endgal-fire-keyword-hint'));
            buttons.forEach((btn, idx) => {
                btn.addEventListener('mousedown', (e) => {
                    e.preventDefault();
                    applyCandidate(hintItems[idx]);
                });
            });
        }

        function syncHighlight() {
            highlight.innerHTML = buildKeywordHighlightHtml(textarea.value || '');
            highlight.scrollTop = textarea.scrollTop;
            highlight.scrollLeft = textarea.scrollLeft;
        }

        textarea.addEventListener('input', () => {
            persistFireConfig(textarea.value || '');
            syncHighlight();
            renderHints();
            applyValidationState();
        });
        textarea.addEventListener('click', renderHints);
        textarea.addEventListener('keyup', (e) => {
            if (['ArrowDown', 'ArrowUp', 'Enter', 'Tab', 'Escape'].includes(e.key)) {
                return;
            }
            renderHints();
        });
        textarea.addEventListener('focus', () => {
            warmupHighlightSync();
            renderHints();
        });
        textarea.addEventListener('scroll', syncHighlight);
        textarea.addEventListener('blur', () => {
            setTimeout(hideHints, 120);
            clickGradioBtn('endgal_fire_config_save_btn', 0);
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
                const ctx = currentAssistContext(textarea);
                if (!ctx) return;
                e.preventDefault();
                applyCandidate(hintItems[Math.max(0, hintIndex)]);
            } else if (e.key === 'Escape') {
                hideHints();
            }
        });

        const savedRaw = loadSavedFireConfig();
        if (!String(textarea.value || '').trim() && String(savedRaw || '').trim()) {
            textarea.value = savedRaw;
            textarea.dispatchEvent(new Event('input', { bubbles: true }));
        }

        syncHighlightLayout();
        syncHighlight();
        renderHints();
        applyValidationState();
        warmupHighlightSync();

        if (window.ResizeObserver) {
            const ro = new ResizeObserver(() => {
                syncHighlightLayout();
                syncHighlight();
            });
            ro.observe(textarea);
            ro.observe(host);
        }

        window.addEventListener('resize', () => {
            syncHighlightLayout();
            syncHighlight();
        });
    }

    function setupDropdownInputGuard() {
        const guardedIds = [
            'endgal_page_size',
            'endgal_date_filter',
            'endgal_thumb_size',
            'endgal_card_extras_mode',
        ];

        function patchDropdownInput(host) {
            if (!host) return;
            const input = host.querySelector('input');
            if (!input || input.dataset.endgalNoInputPatched === '1') return;

            input.dataset.endgalNoInputPatched = '1';
            input.setAttribute('inputmode', 'none');
            input.setAttribute('autocomplete', 'off');
            input.setAttribute('autocapitalize', 'off');
            input.setAttribute('spellcheck', 'false');
        }

        function applyGuard() {
            const app = gradioApp();
            if (!app) return;
            guardedIds.forEach((id) => {
                patchDropdownInput(app.querySelector(`#${id}`));
            });
        }

        applyGuard();

        const app = gradioApp();
        if (!app) return;
        const observer = new MutationObserver(() => {
            applyGuard();
        });

        observer.observe(app, {
            childList: true,
            subtree: true,
        });
    }

    function upsertInfotextParam(text, key, value) {
        const prefix = String(text || '').trim();
        const rendered = `${key}: ${value}`;
        const pattern = new RegExp(
            `(^|,\\s*)${escapeRegex(key)}:\\s*(?:"(?:\\\\.|[^\\"])*"|[^,\\n]*)(?=(?:,\\s*[\\w][\\w \\/-]*:\\s*)|$)`,
            'm'
        );

        if (pattern.test(prefix)) {
            return prefix.replace(pattern, `$1${rendered}`);
        }

        if (!prefix) {
            return rendered;
        }

        const lines = prefix.split('\n');
        const lastLine = lines[lines.length - 1] || '';
        if (/\w[\w \/-]*:\s*/.test(lastLine)) {
            lines[lines.length - 1] = `${lastLine}, ${rendered}`;
            return lines.join('\n');
        }

        lines.push(rendered);
        return lines.join('\n');
    }

    function splitTopLevelCsv(text) {
        const s = String(text || '');
        const out = [];
        let cur = '';
        let inQuote = false;
        let bracketDepth = 0;

        for (let i = 0; i < s.length; i += 1) {
            const ch = s[i];
            if (ch === '"') {
                inQuote = !inQuote;
                cur += ch;
                continue;
            }
            if (!inQuote) {
                if (ch === '[') {
                    bracketDepth += 1;
                    cur += ch;
                    continue;
                }
                if (ch === ']') {
                    bracketDepth = Math.max(0, bracketDepth - 1);
                    cur += ch;
                    continue;
                }
                if (ch === ',' && bracketDepth === 0) {
                    out.push(cur.trim());
                    cur = '';
                    continue;
                }
            }
            cur += ch;
        }

        out.push(cur.trim());
        return out.filter(Boolean);
    }

    function parseValueVariants(rawValue) {
        const value = String(rawValue || '').trim();
        if (!value) return { values: [], error: 'empty value' };

        if (value.startsWith('[') || value.endsWith(']')) {
            if (!(value.startsWith('[') && value.endsWith(']'))) {
                return { values: [], error: `malformed list value '${value}'` };
            }
            const inner = value.slice(1, -1).trim();
            if (!inner) return { values: [], error: 'list value cannot be empty' };
            const items = splitTopLevelCsv(inner).map((x) => x.trim()).filter(Boolean);
            if (!items.length) return { values: [], error: 'list value cannot be empty' };
            return { values: items, error: '' };
        }

        return { values: [value], error: '' };
    }

    function applyInfotextOverrides(infotext, overrides) {
        let updated = String(infotext || '').trim();
        (overrides || []).forEach((entry) => {
            if (!entry || !entry.key) return;
            updated = upsertInfotextParam(updated, entry.key, entry.value);
        });
        return updated;
    }

    function parseOverrideLine(line) {
        const text = String(line || '').trim();
        if (!text) return [];

        const parts = splitTopLevelCsv(text);

        const entries = [];
        parts.forEach((part) => {
            const idx = part.indexOf(':');
            if (idx <= 0) return;
            const key = part.slice(0, idx).trim();
            const value = part.slice(idx + 1).trim();
            if (!key) return;
            const normalizedKey = normalizeKeywordKey(key) || key;
            const parsed = parseValueVariants(value);
            if (!parsed.values.length) return;
            entries.push({ key: normalizedKey, values: parsed.values, value: parsed.values[0] });
        });
        return entries;
    }

    function parseOverrideLineWithErrors(line, lineNo) {
        const text = String(line || '').trim();
        if (!text) return { entries: [], errors: [] };

        const parts = splitTopLevelCsv(text);

        const entries = [];
        const errors = [];

        parts.forEach((part) => {
            const idx = part.indexOf(':');
            if (idx <= 0) {
                errors.push(`Line ${lineNo}: '${part}' is not in key:value format`);
                return;
            }

            const key = part.slice(0, idx).trim();
            const value = part.slice(idx + 1).trim();
            if (!key) {
                errors.push(`Line ${lineNo}: empty key in '${part}'`);
                return;
            }
            if (!value) {
                errors.push(`Line ${lineNo}: empty value for key '${key}'`);
                return;
            }

            const normalizedKey = normalizeKeywordKey(key) || key;
            const parsedValues = parseValueVariants(value);
            if (parsedValues.error) {
                errors.push(`Line ${lineNo}: ${parsedValues.error}`);
                return;
            }

            for (let i = 0; i < parsedValues.values.length; i += 1) {
                const one = parsedValues.values[i];
                const valueCheck = validateValueForKey(normalizedKey, one);
                if (!valueCheck.ok) {
                    errors.push(`Line ${lineNo}: ${valueCheck.reason}`);
                    return;
                }
            }
            entries.push({ key: normalizedKey, values: parsedValues.values, value: parsedValues.values[0] });
        });

        if (!entries.length && !errors.length) {
            errors.push(`Line ${lineNo}: no valid key:value entries`);
        }

        return { entries, errors };
    }

    function validateFireOverrideConfig(raw) {
        const text = String(raw || '').trim();
        if (!text) {
            return { valid: true, errors: [] };
        }

        const lines = String(raw)
            .split(/\r?\n/)
            .map((line) => line.trim());

        const errors = [];
        lines.forEach((line, idx) => {
            if (!line) return;
            const parsed = parseOverrideLineWithErrors(line, idx + 1);
            if (parsed.errors.length) {
                errors.push(...parsed.errors);
            }
        });

        return { valid: errors.length === 0, errors };
    }

    function readGalleryFireOverrideSets() {
        const raw = getComponentInputValue('endgal_hires_override_config');
        if (!raw) return [[]];

        const lines = String(raw)
            .split(/\r?\n/)
            .map((x) => x.trim())
            .filter(Boolean);

        if (!lines.length) return [[]];

        const sets = lines
            .map(parseOverrideLine)
            .filter((entries) => entries.length > 0);

        return sets.length ? sets : [[]];
    }

    function expandOverrideEntrySet(entries) {
        const src = Array.isArray(entries) ? entries : [];
        if (!src.length) return [[]];

        let combos = [[]];
        src.forEach((entry) => {
            const values = Array.isArray(entry.values) && entry.values.length
                ? entry.values
                : [entry.value];
            const next = [];
            combos.forEach((base) => {
                values.forEach((v) => {
                    next.push([...base, { key: entry.key, value: v }]);
                });
            });
            combos = next;
        });

        return combos.length ? combos : [[]];
    }

    function buildExpandedOverrideSets(rawText) {
        const raw = typeof rawText === 'string' ? rawText : getComponentInputValue('endgal_hires_override_config');
        if (!raw) return { sets: [[]], count: 1 };

        const lines = String(raw)
            .split(/\r?\n/)
            .map((x) => x.trim())
            .filter(Boolean);

        if (!lines.length) return { sets: [[]], count: 1 };

        const perLine = lines
            .map(parseOverrideLine)
            .filter((entries) => entries.length > 0)
            .map(expandOverrideEntrySet);

        if (!perLine.length) return { sets: [[]], count: 1 };

        const flatSets = perLine.flat();
        return { sets: flatSets, count: Math.max(1, flatSets.length) };
    }

    async function injectPathToExtrasUpload(absPath) {
        const fileInput = gradioApp().querySelector('#extras_image input[type="file"]');
        if (!fileInput) {
            console.warn('[endorsedGallery] extras file input not found');
            return;
        }

        const srcUrl = toFileServeUrl(absPath);
        const res = await fetch(srcUrl);
        if (!res.ok) {
            console.warn('[endorsedGallery] failed to fetch image from path', absPath, res.status);
            return;
        }

        const blob = await res.blob();
        const name = (String(absPath).split(/[\\/]/).pop() || 'gallery-image.png');
        const file = new File([blob], name, { type: blob.type || 'image/png' });
        const data = new DataTransfer();
        data.items.add(file);
        fileInput.files = data.files;
        fileInput.dispatchEvent(new Event('change', { bubbles: true }));
    }

    function ensurePreviewOverlay() {
        if (previewOverlay) return previewOverlay;

        previewOverlay = document.createElement('div');
        previewOverlay.id = 'endgal_preview_overlay';
        previewOverlay.innerHTML = [
            '<button id="endgal_preview_prev" class="endgal-preview-nav" aria-label="Previous image">‹</button>',
            '<img id="endgal_preview_image" alt="preview" />',
            '<button id="endgal_preview_next" class="endgal-preview-nav" aria-label="Next image">›</button>',
            '<div id="endgal_preview_tags"></div>',
            '<div id="endgal_preview_actions">',
            '  <button id="endgal_preview_like" class="endgal-preview-action" title="toggle endorse">☆</button>',
            '  <button id="endgal_preview_dislike" class="endgal-preview-action" title="toggle dislike">⬇</button>',
            '  <a id="endgal_preview_download" class="endgal-preview-action endgal-preview-download" title="Download original image" download>&#8681; Download</a>',
            '</div>'
        ].join('');

        previewOverlay.addEventListener('click', (e) => {
            // Only close when clicking backdrop (not image / nav buttons)
            if (e.target === previewOverlay) {
                hidePreview();
            }
        });

        const prevBtn = previewOverlay.querySelector('#endgal_preview_prev');
        const nextBtn = previewOverlay.querySelector('#endgal_preview_next');
        previewImage = previewOverlay.querySelector('#endgal_preview_image');
        previewLikeBtn = previewOverlay.querySelector('#endgal_preview_like');
        previewDislikeBtn = previewOverlay.querySelector('#endgal_preview_dislike');
        previewDownloadBtn = previewOverlay.querySelector('#endgal_preview_download');

        if (prevBtn) {
            prevBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                stepPreview(-1);
            });
        }
        if (nextBtn) {
            nextBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                stepPreview(1);
            });
        }

        if (previewLikeBtn) {
            previewLikeBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                triggerPreviewAction('like');
            });
        }

        if (previewDislikeBtn) {
            previewDislikeBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                triggerPreviewAction('dislike');
            });
        }

        if (previewImage) {
            previewImage.addEventListener('click', (e) => {
                e.stopPropagation();
            });

            previewImage.addEventListener('wheel', (e) => {
                e.preventDefault();
                const rect = previewImage.getBoundingClientRect();
                const cx = e.clientX - (rect.left + rect.width / 2);
                const cy = e.clientY - (rect.top + rect.height / 2);

                const oldScale = zoomScale;
                const factor = e.deltaY < 0 ? 1.12 : 0.89;
                zoomScale = Math.min(8, Math.max(0.2, zoomScale * factor));
                const ratio = zoomScale / oldScale;

                // Keep zoom anchored near cursor point.
                panX = panX * ratio - cx * (ratio - 1);
                panY = panY * ratio - cy * (ratio - 1);
                applyTransform();
            }, { passive: false });

            previewImage.addEventListener('mousedown', (e) => {
                e.preventDefault();
                isDragging = true;
                dragStartX = e.clientX;
                dragStartY = e.clientY;
                dragOriginX = panX;
                dragOriginY = panY;
                previewImage.classList.add('dragging');
            });

            previewImage.addEventListener('dblclick', (e) => {
                e.preventDefault();
                resetTransform();
            });
        }

        document.addEventListener('mousemove', (e) => {
            if (!isDragging || !previewOverlay || !previewOverlay.classList.contains('show')) return;
            panX = dragOriginX + (e.clientX - dragStartX);
            panY = dragOriginY + (e.clientY - dragStartY);
            applyTransform();
        });

        document.addEventListener('mouseup', () => {
            if (!isDragging) return;
            isDragging = false;
            if (previewImage) previewImage.classList.remove('dragging');
        });

        document.addEventListener('keydown', (e) => {
            if (!previewOverlay || !previewOverlay.classList.contains('show')) return;

            if ((e.ctrlKey || e.metaKey) && !e.shiftKey && (e.key === 'z' || e.key === 'Z')) {
                e.preventDefault();
                window.endorsedGallery.undo();
                return;
            }
            if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.shiftKey && (e.key === 'z' || e.key === 'Z')))) {
                e.preventDefault();
                window.endorsedGallery.redo();
                return;
            }

            if (e.key === 'Escape') {
                hidePreview();
            } else if (e.key === 'ArrowLeft') {
                e.preventDefault();
                stepPreview(-1);
            } else if (e.key === 'ArrowRight') {
                e.preventDefault();
                stepPreview(1);
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                triggerPreviewAction('like');
            } else if (e.key === 'ArrowDown') {
                e.preventDefault();
                triggerPreviewAction('dislike');
            } else if (e.key === 'h' || e.key === 'H') {
                e.preventDefault();
                queueCurrentPreviewFire();
            }
        });

        document.body.appendChild(previewOverlay);
        return previewOverlay;
    }

    function hidePreview() {
        if (previewOverlay) previewOverlay.classList.remove('show');
        isDragging = false;
        if (previewImage) previewImage.classList.remove('dragging');
    }

    function showEndHint(message) {
        const app = gradioApp();
        if (!app) return;

        const host = app.querySelector('#endgal_sync_status') || app.querySelector('#endgal_html');
        if (!host) return;

        const safeMsg = String(message || 'All images are over.')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');

        host.innerHTML = `<div id="endgal_end_hint" class="endgal-sync-result">${safeMsg}</div>`;
    }

    function applyTransform() {
        if (!previewImage) return;
        previewImage.style.transform = `translate(${panX}px, ${panY}px) scale(${zoomScale})`;
    }

    function resetTransform() {
        zoomScale = 1;
        panX = 0;
        panY = 0;
        applyTransform();
    }

    function buildPreviewList() {
        const imgs = Array.from(gradioApp().querySelectorAll('#endgal_html .endgal-thumb img'));
        previewList = imgs
            .map(el => ({
                src: el.dataset.preview || el.dataset.orig || el.getAttribute('src'),
                origUrl: el.dataset.orig || '',
                infotextB64: el.dataset.infotext || '',
                endorseAction: el.dataset.endorseAction || '',
                dislikeAction: el.dataset.dislikeAction || '',
                endorseLabel: el.dataset.endorseLabel || '☆',
                dislikeLabel: el.dataset.dislikeLabel || '⬇',
                tags: (() => {
                    try { return JSON.parse(atob(el.dataset.tags || '')); }
                    catch (e) { return []; }
                })(),
            }))
            .filter(item => Boolean(item.src));
    }

    function refreshPreviewActionButtons() {
        const item = previewList[previewIndex] || null;
        if (previewLikeBtn) {
            previewLikeBtn.textContent = item ? (item.endorseLabel || '☆') : '☆';
            previewLikeBtn.disabled = !(item && item.endorseAction);
        }
        if (previewDislikeBtn) {
            previewDislikeBtn.textContent = item ? (item.dislikeLabel || '⬇') : '⬇';
            previewDislikeBtn.disabled = !(item && item.dislikeAction);
        }
        if (previewDownloadBtn) {
            const origUrl = item && item.origUrl ? item.origUrl : (item ? item.src : '');
            if (origUrl) {
                previewDownloadBtn.href = origUrl;
                // Extract filename from /file=path/to/file.png
                const decoded = decodeURIComponent(origUrl.replace(/^\/file=/, ''));
                previewDownloadBtn.download = decoded.split('/').pop().split('\\').pop() || 'image';
                previewDownloadBtn.style.display = '';
            } else {
                previewDownloadBtn.style.display = 'none';
            }
        }
    }

    function refreshPreviewTags() {
        const tagsEl = previewOverlay && previewOverlay.querySelector('#endgal_preview_tags');
        if (!tagsEl) return;
        const item = previewList[previewIndex] || null;
        const tags = (item && item.tags) || [];
        if (!tags.length) {
            tagsEl.innerHTML = '<span class="endgal-preview-tags-empty">No caption</span>';
            return;
        }
        tagsEl.innerHTML = tags
            .map(t => `<span class="endgal-tag-pill endgal-tag-pill-preview">${t.replace(/_/g, ' ')}</span>`)
            .join('');
    }

    function queueCurrentPreviewFire() {
        const item = previewList[previewIndex] || null;
        if (!item || !item.infotextB64) return;

        window.endorsedGallery.queueTxt2ImgFire(item.infotextB64, { keepGalleryTab: true });
    }

    function triggerPreviewAction(kind) {
        const item = previewList[previewIndex];
        if (!item) return;
        const actionB64 = kind === 'like' ? item.endorseAction : item.dislikeAction;
        if (!actionB64) return;

        const atLast = previewIndex >= previewList.length - 1;
        if (!atLast && previewList.length > 1) {
            stepPreview(1);
        } else {
            hidePreview();
            showEndHint('All images are over.');
        }

        executeAction(actionB64, { recordHistory: true, clearRedo: true });
    }

    function stepPreview(delta) {
        if (!previewImage || previewList.length === 0) return;

        const nextIndex = previewIndex + delta;
        if (nextIndex < 0 || nextIndex >= previewList.length) {
            hidePreview();
            showEndHint('All images are over.');
            return;
        }

        previewIndex = nextIndex;
        previewImage.src = previewList[previewIndex].src;
        refreshPreviewActionButtons();
        refreshPreviewTags();
        resetTransform();
    }

    function clearSearchTextbox() {
        const el = gradioApp().querySelector('#endgal_search_box textarea');
        if (!el) return;

        // Keep gallery search pristine even when browser/gradio restores prior values.
        el.setAttribute('placeholder', '');
        if (el.value !== '') {
            const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
                window.HTMLTextAreaElement.prototype, 'value'
            ).set;
            nativeInputValueSetter.call(el, '');
            el.dispatchEvent(new Event('input', { bubbles: true }));
        }
    }

    function bootstrapClearSearchTextbox() {
        [60, 220, 600, 1200].forEach((ms) => {
            setTimeout(() => clearSearchTextbox(), ms);
        });
    }

    // ---------------------------------------------------------------------------
    // Public API
    // ---------------------------------------------------------------------------

    window.endorsedGallery = {

        /**
         * Triggered by ⭐/☆ buttons in gallery cards.
         * actionDataB64 decodes to JSON: {type: "endorse"|"remove", ...fields}
         */
        action: function (actionDataB64) {
            executeAction(actionDataB64, { recordHistory: true, clearRedo: true });
        },

        undo: function () {
            const entry = actionUndoStack.pop();
            if (!entry) return;
            executeAction(entry.backward, { recordHistory: false, clearRedo: false });
            actionRedoStack.push(entry);
        },

        redo: function () {
            const entry = actionRedoStack.pop();
            if (!entry) return;
            executeAction(entry.forward, { recordHistory: false, clearRedo: false });
            actionUndoStack.push(entry);
        },

        /**
         * Copy the raw infotext to clipboard.
         * infotextB64 is base64(infotext).
         */
        copyParams: function (infotextB64) {
            const text = b64Decode(infotextB64);
            navigator.clipboard.writeText(text).then(() => {
                // Brief visual feedback: flash the button that was clicked
                const btn = event && event.target;
                if (btn) {
                    const orig = btn.textContent;
                    btn.textContent = '✅';
                    setTimeout(() => { btn.textContent = orig; }, 1200);
                }
            }).catch(err => {
                console.warn('[endorsedGallery] clipboard write failed:', err);
            });
        },

        /**
         * Fill the generation tab (txt2img or img2img) with the card's params.
         * target: 'txt2img' | 'img2img'
         * pathB64: optional base64(abs_file_path) – when provided and target is img2img,
         *          the source image is injected into the img2img image input.
         */
        sendTo: function (infotextB64, target, pathB64) {
            const infotext = b64Decode(infotextB64);
            if (!setGradioTextbox('endorsed_gallery_infotext_apply', infotext)) {
                console.warn('[endorsedGallery] infotext_apply textbox not found');
                return;
            }
            const btnId = target === 'img2img'
                ? 'endorsed_gallery_apply_img2img_btn'
                : 'endorsed_gallery_apply_txt2img_btn';
            clickGradioBtn(btnId);

            // Switch to the target tab so the user sees the result
            setTimeout(() => {
                switchToTabByName(target);
            }, 200);

            // For img2img, also inject the source image into the img2img image input.
            if (target === 'img2img' && pathB64) {
                const path = b64Decode(pathB64);
                if (path) {
                    setTimeout(() => {
                        const fileInput = gradioApp().querySelector('#img2img_image input[type="file"]');
                        if (!fileInput) {
                            console.warn('[endorsedGallery] img2img file input not found');
                            return;
                        }
                        const srcUrl = toFileServeUrl(path);
                        fetch(srcUrl)
                            .then((res) => {
                                if (!res.ok) throw new Error('fetch failed: ' + res.status);
                                return res.blob();
                            })
                            .then((blob) => {
                                const name = (String(path).split(/[\\/]/).pop() || 'gallery-image.png');
                                const file = new File([blob], name, { type: blob.type || 'image/png' });
                                const data = new DataTransfer();
                                data.items.add(file);
                                fileInput.files = data.files;
                                fileInput.dispatchEvent(new Event('change', { bubbles: true }));
                            })
                            .catch((err) => console.warn('[endorsedGallery] img2img image inject failed:', err));
                    }, 250);
                }
            }
        },

        queueTxt2ImgFire: async function (infotextB64, options) {
            const opts = options || {};
            const baseInfotext = b64Decode(infotextB64 || '');
            const overrideSets = buildExpandedOverrideSets().sets;
            const queueBtn = gradioApp().querySelector('#txt2img_queue_btn');

            if (!queueBtn) {
                console.warn('[endorsedGallery] txt2img queue button not found');
                return;
            }

            suppressTxt2imgSwitch = true;
            try {
                for (let i = 0; i < overrideSets.length; i += 1) {
                    const infotext = applyInfotextOverrides(baseInfotext, overrideSets[i]);
                    if (!setGradioTextbox('endorsed_gallery_infotext_apply', infotext)) {
                        console.warn('[endorsedGallery] infotext_apply textbox not found');
                        return;
                    }

                    clickGradioBtn('endorsed_gallery_apply_txt2img_btn', 0);

                    // Optional fallback to keep Gallery visible if any external code still switches tabs.
                    if (opts.keepGalleryTab !== false) {
                        setTimeout(() => {
                            switchToTabByName('gallery');
                        }, 20);
                    }

                    await sleep(320);
                    queueBtn.click();
                    await sleep(260);
                }
            } finally {
                suppressTxt2imgSwitch = false;
            }
        },

        // Backward compatibility for existing callers.
        queueTxt2ImgHires: function (infotextB64, options) {
            return window.endorsedGallery.queueTxt2ImgFire(infotextB64, options);
        },

        /**
         * Send a composed image (and its optional .composerstate.json) to the Composer tab.
         * @param {string} imagePathB64  base64(abs_file_path_to_png)
         * @param {string} configPathB64 base64(abs_file_path_to_composerstate.json) or base64("")
         */
        sendToComposer: function (imagePathB64, configPathB64) {
            const imagePath = b64Decode(imagePathB64 || '');
            const configPath = b64Decode(configPathB64 || '');
            if (!imagePath) return;

            switchToTabByName('composer');
            setTimeout(async () => {
                if (typeof window.composer_load_from_gallery === 'function') {
                    await window.composer_load_from_gallery(imagePath, configPath);
                }
            }, 450);
        },

        /**
         * Send selected gallery image to Extras tab.
         * pathB64 is base64(abs_file_path).
         */
        sendToExtras: function (pathB64) {
            const path = b64Decode(pathB64 || '');
            if (!path) return;

            // Requested behavior: jump to Extras immediately, then pass image path
            // into Extras upload (drag-drop equivalent) without hidden load/apply bridge.
            switchToTabByName('extras');
            setTimeout(() => {
                injectPathToExtrasUpload(path).catch((err) => {
                    console.warn('[endorsedGallery] injectPathToExtrasUpload failed:', err);
                });
            }, 40);
        },

        previewImage: function (src) {
            if (!src) return;
            const overlay = ensurePreviewOverlay();

            buildPreviewList();
            previewIndex = previewList.findIndex(item => item.src === src);
            if (previewIndex < 0) {
                previewList.push({
                    src,
                    infotextB64: '',
                    endorseAction: '',
                    dislikeAction: '',
                    endorseLabel: '☆',
                    dislikeLabel: '⬇',
                });
                previewIndex = previewList.length - 1;
            }

            if (!previewImage) return;
            previewImage.src = previewList[previewIndex].src;
            refreshPreviewActionButtons();
            refreshPreviewTags();
            resetTransform();
            overlay.classList.add('show');
        },
    };

    /**
     * Monitor gallery for end-of-gallery state and hide preview when detected
     */
    function checkAndHandleEndOfGallery() {
        const app = gradioApp();
        if (!app) return;

        const endHint = app.querySelector('#endgal_end_hint');
        if (endHint) {
            // End of gallery hint is present - close preview and scroll hint into view
            hidePreview();
            setTimeout(() => {
                endHint.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }, 100);
        }
    }

    // Monitor gallery HTML updates for end-of-gallery state
    function setupEndOfGalleryMonitor() {
        const galleryContainer = gradioApp().querySelector('#endgal_html');
        if (!galleryContainer) return;

        const observer = new MutationObserver(() => {
            checkAndHandleEndOfGallery();
        });

        observer.observe(galleryContainer, {
            childList: true,
            subtree: true,
        });
    }

    // Start monitoring when document is ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', setupEndOfGalleryMonitor);
    } else {
        setupEndOfGalleryMonitor();
    }

    // ---------------------------------------------------------------------------
    // Auto-refresh gallery on tab focus
    // ---------------------------------------------------------------------------

    /**
     * When the user clicks the Gallery tab, auto-refresh if the panel is still
     * showing the "Click ⟳ Refresh to load." placeholder.
     */
    function onTabSwitch() {
        const tabBtn = gradioApp().querySelector('button[id="endorsed_gallery"]') ||
            Array.from(gradioApp().querySelectorAll('#tabs > div > button')).find(
                b => b.textContent.includes('Gallery')
            );
        if (!tabBtn) return;

        tabBtn.addEventListener('click', () => {
            setTimeout(() => {
                clearSearchTextbox();
                setupFireConfigAssist();
                setupPromptKeywordAssist();
                const html = gradioApp().querySelector('#endgal_html');
                if (!html) return;
                if (html.innerHTML.includes('Click ⟳ Refresh')) {
                    const refreshBtn = gradioApp().querySelector('#endgal_refresh_btn');
                    if (refreshBtn) refreshBtn.click();
                }
            }, 150);
        });
    }

    // Wait for Gradio to finish rendering before attaching listeners
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            ensureTxt2ImgSwitchGuard();
            bootstrapClearSearchTextbox();
            setupDropdownInputGuard();
            setTimeout(setupPromptKeywordAssist, 900);
            setTimeout(setupPromptKeywordAssist, 1800);
            setTimeout(setupFireConfigAssist, 1200);
            setTimeout(setupFireConfigAssist, 2500);
            setTimeout(onTabSwitch, 1500);
        });
    } else {
        ensureTxt2ImgSwitchGuard();
        bootstrapClearSearchTextbox();
        setupDropdownInputGuard();
        setTimeout(setupPromptKeywordAssist, 900);
        setTimeout(setupPromptKeywordAssist, 1800);
        setTimeout(setupFireConfigAssist, 1200);
        setTimeout(setupFireConfigAssist, 2500);
        setTimeout(onTabSwitch, 1500);
    }

})();
