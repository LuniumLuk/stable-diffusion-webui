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

    // --- Reversed order toggle state ---
    const REVERSE_UNRATED_KEY = 'endgal_reverse_unrated';
    function getReverseUnrated() {
        try { return localStorage.getItem(REVERSE_UNRATED_KEY) === '1'; } catch { return false; }
    }
    function setReverseUnrated(val) {
        try { localStorage.setItem(REVERSE_UNRATED_KEY, val ? '1' : '0'); } catch {}
    }
    function setupReverseUnratedSync() {
        const el = gradioApp().querySelector('#endgal_reverse_unrated input[type="checkbox"]');
        if (!el) return;
        if (el.__endgalSynced) return;
        el.__endgalSynced = true;
        // Restore persisted state without synthetic change dispatch.
        // Synthetic startup events can hit stale Gradio callback maps after UI edits.
        const stored = getReverseUnrated();
        el.checked = stored;
        // Save future changes to localStorage
        el.addEventListener('change', () => {
            setReverseUnrated(el.checked);
        });
    }

    const FIRE_CANONICAL_KEYS = [
        'Prompt',
        'Negative prompt',
        'Hires stage',
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
        'hires stage': 'Hires stage',
        'hires_stage': 'Hires stage',
        'hr stage': 'Hires stage',
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
        'Hires stage': [
            '"scale: 1.15, steps: 8; scale: 1.45, denoise: 0.55"',
            '"scale: 1.2, cfg: 5.5, steps: 10; scale: 1.6, cfg: 6, denoise: 0.5"',
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
    let previewPromptEl = null;
    let previewNegativeEl = null;
    let previewSettingsEl = null;
    let previewCaptionEl = null;
    let previewActionsEl = null;
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
    let previewBodyOverflowBefore = '';

    function updatePreviewViewportHeightVar() {
        const vh = Math.max(1, window.innerHeight || 1) * 0.01;
        document.documentElement.style.setProperty('--endgal-preview-vh', `${vh}px`);
    }

    function isPreviewOpen() {
        return Boolean(previewOverlay && previewOverlay.classList.contains('show'));
    }

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
        if (action.type === 'stage') return { ...action, type: 'unstage' };
        if (action.type === 'unstage') return { ...action, type: 'stage' };
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

    /**
     * Force-set a Gradio slider (number + optional range input) by its elem_id.
     * Uses the native HTMLInputElement value setter so Svelte/React state updates.
     */
    function setGradioSlider(elemId, numValue) {
        const host = gradioApp().querySelector(`#${elemId}`);
        if (!host) return false;
        const nativeSetter = Object.getOwnPropertyDescriptor(
            window.HTMLInputElement.prototype, 'value'
        ).set;
        let updated = false;
        // Update the visible number input (Gradio renders this for the text field of a slider)
        const numInput = host.querySelector('input[type="number"]');
        if (numInput) {
            nativeSetter.call(numInput, String(numValue));
            numInput.dispatchEvent(new Event('input', { bubbles: true }));
            numInput.dispatchEvent(new Event('change', { bubbles: true }));
            updated = true;
        }
        // Also sync the range track if present
        const rangeInput = host.querySelector('input[type="range"]');
        if (rangeInput) {
            nativeSetter.call(rangeInput, String(numValue));
            rangeInput.dispatchEvent(new Event('input', { bubbles: true }));
            rangeInput.dispatchEvent(new Event('change', { bubbles: true }));
            updated = true;
        }
        return updated;
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
        if (key === 'Hires stage') {
            return uniqStrings([...(FIRE_VALUE_SUGGEST_DEFAULTS['Hires stage'] || [])]);
        }
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

        function asNumber() {
            const n = Number(raw);
            return Number.isFinite(n) ? n : null;
        }

        function asInteger() {
            if (!/^-?\d+$/.test(raw)) return null;
            const n = Number(raw);
            return Number.isFinite(n) ? n : null;
        }

        function parseHiresStageConfigValue(quotedRaw) {
            const s = String(quotedRaw || '');
            if (s.length < 2 || s[0] !== '"' || s[s.length - 1] !== '"') {
                return { ok: false, reason: `Hires stage must be wrapped in double quotes` };
            }

            const inner = s.slice(1, -1).trim();
            if (!inner) {
                return { ok: false, reason: `Hires stage cannot be empty` };
            }
            if (/\r|\n/.test(inner)) {
                return { ok: false, reason: `Hires stage in Fire Config must use ';' to separate stages` };
            }

            const stageChunks = inner.split(';').map((x) => x.trim()).filter(Boolean);
            if (!stageChunks.length) {
                return { ok: false, reason: `Hires stage must contain at least one stage` };
            }

            for (let i = 0; i < stageChunks.length; i += 1) {
                const line = stageChunks[i];
                const parts = line.split(',').map((x) => x.trim()).filter(Boolean);
                if (!parts.length) {
                    return { ok: false, reason: `Hires stage stage #${i + 1} is empty` };
                }

                const stage = {};
                for (let p = 0; p < parts.length; p += 1) {
                    const item = parts[p];
                    const idx = item.indexOf(':');
                    if (idx <= 0) {
                        return { ok: false, reason: `Hires stage stage #${i + 1} has invalid item '${item}'` };
                    }
                    const k = item.slice(0, idx).trim().toLowerCase();
                    const v = item.slice(idx + 1).trim();
                    const num = Number(v);

                    if (k === 'scale') {
                        if (!Number.isFinite(num) || num <= 1.0) {
                            return { ok: false, reason: `Hires stage scale must be > 1 (stage #${i + 1})` };
                        }
                        stage.scale = num;
                    } else if (k === 'cfg') {
                        if (!Number.isFinite(num)) {
                            return { ok: false, reason: `Hires stage cfg must be numeric (stage #${i + 1})` };
                        }
                    } else if (k === 'steps') {
                        if (!Number.isFinite(num) || Math.round(num) < 0) {
                            return { ok: false, reason: `Hires stage steps must be integer >= 0 (stage #${i + 1})` };
                        }
                    } else if (k === 'denoise') {
                        if (!Number.isFinite(num) || num < 0 || num > 1) {
                            return { ok: false, reason: `Hires stage denoise must be between 0 and 1 (stage #${i + 1})` };
                        }
                    } else {
                        return { ok: false, reason: `Hires stage unknown key '${k}' (stage #${i + 1})` };
                    }
                }

                if (!Number.isFinite(stage.scale)) {
                    return { ok: false, reason: `Hires stage requires scale in each stage (stage #${i + 1})` };
                }
            }

            return { ok: true };
        }

        if (key === 'Hires stage') {
            return parseHiresStageConfigValue(raw);
        }

        const lower = raw.toLowerCase();
        const enumChoices = getAllValueChoicesForKey(key);
        if (enumChoices.length) {
            const matched = enumChoices.some((x) => x.toLowerCase() === lower);
            return matched
                ? { ok: true, normalized: enumChoices.find((x) => x.toLowerCase() === lower) || raw }
                : { ok: false, reason: `invalid value '${raw}' for '${key}'` };
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

        let _fireConfigSaveTimer = null;
        function schedulePersistFireConfigToServer() {
            if (_fireConfigSaveTimer) clearTimeout(_fireConfigSaveTimer);
            _fireConfigSaveTimer = setTimeout(() => {
                _fireConfigSaveTimer = null;
                clickGradioBtn('endgal_fire_config_save_btn', 0);
            }, 800);
        }

        function flushPersistFireConfigToServer() {
            if (_fireConfigSaveTimer) {
                clearTimeout(_fireConfigSaveTimer);
                _fireConfigSaveTimer = null;
            }
            clickGradioBtn('endgal_fire_config_save_btn', 0);
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
            schedulePersistFireConfigToServer();
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
        if (String(savedRaw || '').trim()) {
            // Always prefer localStorage — it is updated on every keystroke so it is
            // always at least as fresh as the server-side file.
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
            const key = entry.key === 'Hires stage' ? 'Hires stage config' : entry.key;
            updated = upsertInfotextParam(updated, key, entry.value);
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

        updatePreviewViewportHeightVar();

        previewOverlay = document.createElement('div');
        previewOverlay.id = 'endgal_preview_overlay';
        previewOverlay.innerHTML = [
            '<div id="endgal_preview_panel">',
            '  <div id="endgal_preview_content">',
            '    <div id="endgal_preview_center">',
            '      <button id="endgal_preview_prev" class="endgal-preview-nav" aria-label="Previous image">‹</button>',
            '      <div id="endgal_preview_image_stage">',
            '        <img id="endgal_preview_image" alt="preview" />',
            '      </div>',
            '      <button id="endgal_preview_next" class="endgal-preview-nav" aria-label="Next image">›</button>',
            '    </div>',
            '    <div id="endgal_preview_info" class="endgal-preview-panel-col">',
            '      <h3>Prompt</h3>',
            '      <pre id="endgal_preview_prompt"></pre>',
            '      <h3>Negative prompt</h3>',
            '      <pre id="endgal_preview_negative"></pre>',
            '      <h3>Settings</h3>',
            '      <pre id="endgal_preview_settings"></pre>',
            '      <h3>Captions</h3>',
            '      <div id="endgal_preview_tags"></div>',
            '    </div>',
            '  </div>',
            '  <div id="endgal_preview_actions_wrap" class="endgal-preview-panel-col">',
            '    <h3>Quick actions</h3>',
            '    <div id="endgal_preview_actions"></div>',
            '  </div>',
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
        previewPromptEl = previewOverlay.querySelector('#endgal_preview_prompt');
        previewNegativeEl = previewOverlay.querySelector('#endgal_preview_negative');
        previewSettingsEl = previewOverlay.querySelector('#endgal_preview_settings');
        previewCaptionEl = previewOverlay.querySelector('#endgal_preview_tags');
        previewActionsEl = previewOverlay.querySelector('#endgal_preview_actions');

        const panel = previewOverlay.querySelector('#endgal_preview_panel');

        window.addEventListener('resize', updatePreviewViewportHeightVar, { passive: true });

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

        // Keep wheel scrolling contained to the preview panel.
        if (panel) {
            panel.addEventListener('wheel', (e) => {
                e.stopPropagation();
            }, { passive: true });
        }

        if (previewPromptEl) {
            previewPromptEl.title = 'Click to copy prompt';
            previewPromptEl.classList.add('endgal-preview-copyable');
            previewPromptEl.addEventListener('click', (e) => {
                e.stopPropagation();
                copyPreviewText(previewPromptEl);
            });
        }

        if (previewNegativeEl) {
            previewNegativeEl.title = 'Click to copy negative prompt';
            previewNegativeEl.classList.add('endgal-preview-copyable');
            previewNegativeEl.addEventListener('click', (e) => {
                e.stopPropagation();
                copyPreviewText(previewNegativeEl);
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
            } else if (e.key === 'a' || e.key === 'A') {
                e.preventDefault();
                triggerPreviewAction('archive');
            } else if (e.key === 's' || e.key === 'S') {
                e.preventDefault();
                triggerPreviewAction('stage');
            }
        });

        document.body.appendChild(previewOverlay);
        return previewOverlay;
    }

    function copyPreviewText(el) {
        if (!el) return;
        const text = String(el.textContent || '').trim();
        if (!text || text === '(empty)') return;

        navigator.clipboard.writeText(text).then(() => {
            el.classList.add('endgal-preview-copied');
            setTimeout(() => el.classList.remove('endgal-preview-copied'), 900);
        }).catch((err) => {
            console.warn('[endorsedGallery] clipboard write failed:', err);
        });
    }

    function parsePreviewInfotext(rawText) {
        const full = String(rawText || '').trim();
        const result = {
            prompt: '',
            negative: '',
            settings: '',
        };

        if (!full) {
            return result;
        }

        const negMatch = /negative\s+prompt\s*:/i.exec(full);
        const idxNeg = negMatch ? negMatch.index : -1;
        const idxSteps = full.lastIndexOf('Steps:');

        if (idxNeg >= 0) {
            result.prompt = full.slice(0, idxNeg).trim().replace(/,+\s*$/, '');
            if (idxSteps > idxNeg) {
                result.negative = full.slice(idxNeg + negMatch[0].length, idxSteps).trim().replace(/,+\s*$/, '');
                result.settings = full.slice(idxSteps).trim().replace(/^,+\s*/, '');
            } else {
                result.negative = full.slice(idxNeg + negMatch[0].length).trim().replace(/,+\s*$/, '');
            }
        } else if (idxSteps > 0) {
            result.prompt = full.slice(0, idxSteps).trim().replace(/,+\s*$/, '');
            result.settings = full.slice(idxSteps).trim().replace(/^,+\s*/, '');
        } else {
            result.prompt = full;
        }

        if (!result.settings) {
            result.settings = full;
        }

        return result;
    }

    function decodeFilePathFromFileUrl(fileUrl) {
        const src = String(fileUrl || '');
        if (!src) return '';

        try {
            const stripped = src.replace(/^\/file=/, '');
            return decodeURIComponent(stripped);
        } catch (_e) {
            return src;
        }
    }

    function collectCardQuickButtons(imgEl) {
        const card = imgEl && imgEl.closest ? imgEl.closest('.endgal-card') : null;
        if (!card) return [];

        return Array.from(card.querySelectorAll('.endgal-thumb-corner-actions button, .endgal-thumb-actions button'));
    }

    function getCurrentPreviewPath() {
        const item = previewList[previewIndex] || null;
        if (!item) return '';
        const p = decodeFilePathFromFileUrl(item.origUrl || item.src || '');
        return String(p || '').trim();
    }

    function openCurrentPreviewInExplorer() {
        const path = getCurrentPreviewPath();
        if (!path) return;
        const payload = b64Encode(JSON.stringify({ type: 'open_explorer', path }));
        executeAction(payload, { recordHistory: false, clearRedo: false });
    }

    function downloadCurrentPreview() {
        const item = previewList[previewIndex] || null;
        const origUrl = item && item.origUrl ? item.origUrl : (item ? item.src : '');
        if (!origUrl) return;

        const decoded = decodeURIComponent(String(origUrl).replace(/^\/file=/, ''));
        const fileName = decoded.split('/').pop().split('\\').pop() || 'image';

        const a = document.createElement('a');
        a.href = origUrl;
        a.download = fileName;
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        a.remove();
    }

    function hidePreview() {
        if (previewOverlay) previewOverlay.classList.remove('show');
        if (document && document.body) {
            document.body.style.overflow = previewBodyOverflowBefore || '';
        }
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
        let imgs = Array.from(gradioApp().querySelectorAll('#endgal_html .endgal-thumb img'));
        previewList = imgs
            .map(el => ({
                element: el,
                src: el.dataset.preview || el.dataset.orig || el.getAttribute('src'),
                origUrl: el.dataset.orig || '',
                infotextB64: el.dataset.infotext || '',
                endorseAction: el.dataset.endorseAction || '',
                dislikeAction: el.dataset.dislikeAction || '',
                stageAction: el.dataset.stageAction || '',
                endorseLabel: el.dataset.endorseLabel || '☆',
                dislikeLabel: el.dataset.dislikeLabel || '⬇',
                stageLabel: el.dataset.stageLabel || '📌',
                quickButtons: collectCardQuickButtons(el),
                tags: (() => {
                    try { return JSON.parse(atob(el.dataset.tags || '')); }
                    catch (e) { return []; }
                })(),
            }))
            .filter(item => Boolean(item.src));
    }

    function refreshPreviewActionButtons() {
        const item = previewList[previewIndex] || null;
        const currentPath = getCurrentPreviewPath();
        const hasDownload = Boolean(item && (item.origUrl || item.src));

        if (previewActionsEl) {
            previewActionsEl.innerHTML = '';
            if (!item || !item.quickButtons || !item.quickButtons.length) {
                const empty = document.createElement('div');
                empty.className = 'endgal-preview-actions-empty';
                empty.textContent = 'No actions available.';
                previewActionsEl.appendChild(empty);
            } else {
                item.quickButtons.forEach((sourceBtn) => {
                    const btn = document.createElement('button');
                    btn.className = 'endgal-preview-action';

                    if (sourceBtn.classList.contains('endgal-act-endorse')) {
                        btn.classList.add('endgal-preview-action-endorse');
                    } else if (sourceBtn.classList.contains('endgal-act-archive')) {
                        btn.classList.add('endgal-preview-action-archive');
                    } else if (sourceBtn.classList.contains('endgal-act-dislike')) {
                        btn.classList.add('endgal-preview-action-dislike');
                    } else if (sourceBtn.classList.contains('endgal-act-stage')) {
                        btn.classList.add('endgal-preview-action-stage');
                    }

                    if (sourceBtn.classList.contains('active')) {
                        btn.classList.add('endgal-preview-action-active');
                    }

                    const icon = (sourceBtn.dataset && sourceBtn.dataset.icon)
                        ? String(sourceBtn.dataset.icon).trim()
                        : String(sourceBtn.textContent || '').trim();
                    const hint = (sourceBtn.dataset && sourceBtn.dataset.hint)
                        ? String(sourceBtn.dataset.hint).trim()
                        : String(sourceBtn.title || '').trim();

                    btn.innerHTML = `<span class="endgal-preview-action-icon">${escapeHtml(icon || '•')}</span><span class="endgal-preview-action-label">${escapeHtml(hint || 'Action')}</span>`;
                    btn.title = hint || sourceBtn.title || 'action';
                    btn.addEventListener('click', (e) => {
                        e.stopPropagation();
                        if (sourceBtn && sourceBtn.isConnected) {
                            sourceBtn.click();
                            // If this is endorse/dislike, also step to next image.
                            if (btn.classList.contains('endgal-preview-action-endorse')) {
                                setTimeout(() => triggerPreviewAction('like'), 0);
                            } else if (btn.classList.contains('endgal-preview-action-dislike')) {
                                setTimeout(() => triggerPreviewAction('dislike'), 0);
                            }
                            return;
                        }

                        // Fallback when underlying card buttons are stale after re-render.
                        if (hint.toLowerCase().includes('endorse')) {
                            triggerPreviewAction('like');
                        } else if (hint.toLowerCase().includes('dislike')) {
                            triggerPreviewAction('dislike');
                        } else if (hint.toLowerCase().includes('stage') || hint.toLowerCase().includes('pick')) {
                            triggerPreviewAction('stage');
                        } else if (hint.toLowerCase().includes('archive')) {
                            triggerPreviewAction('archive');
                        } else if (hint.toLowerCase().includes('txt2img') && item.infotextB64) {
                            window.endorsedGallery.sendTo(item.infotextB64, 'txt2img');
                        } else if (hint.toLowerCase().includes('img2img') && item.infotextB64) {
                            const p = decodeFilePathFromFileUrl(item.origUrl);
                            window.endorsedGallery.sendTo(item.infotextB64, 'img2img', b64Encode(p));
                        } else if (hint.toLowerCase().includes('fire')) {
                            queueCurrentPreviewFire();
                        } else if (hint.toLowerCase().includes('inpaint')) {
                            const p = decodeFilePathFromFileUrl(item.origUrl);
                            if (p) window.endorsedGallery.sendToInpaint(item.infotextB64 || '', b64Encode(p));
                        }
                    });
                    previewActionsEl.appendChild(btn);
                });
            }

            const explorerBtn = document.createElement('button');
            explorerBtn.className = 'endgal-preview-action';
            explorerBtn.title = 'View in Explorer';
            explorerBtn.innerHTML = '<span class="endgal-preview-action-icon">📁</span><span class="endgal-preview-action-label">View in Explorer</span>';
            explorerBtn.disabled = !currentPath;
            explorerBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                openCurrentPreviewInExplorer();
            });
            previewActionsEl.appendChild(explorerBtn);

            const downloadBtn = document.createElement('button');
            downloadBtn.className = 'endgal-preview-action';
            downloadBtn.title = 'Download original image';
            downloadBtn.innerHTML = '<span class="endgal-preview-action-icon">⇩</span><span class="endgal-preview-action-label">Download</span>';
            downloadBtn.disabled = !hasDownload;
            downloadBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                downloadCurrentPreview();
            });
            previewActionsEl.appendChild(downloadBtn);

            const composerBtn = document.createElement('button');
            composerBtn.className = 'endgal-preview-action';
            composerBtn.title = 'Open in Composer as background';
            const composerPath = getCurrentPreviewPath();
            composerBtn.disabled = !composerPath;
            composerBtn.innerHTML = '<span class="endgal-preview-action-icon">🧩</span><span class="endgal-preview-action-label">To Composer</span>';
            composerBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                if (!composerPath) return;
                window.endorsedGallery.sendToComposer(b64Encode(composerPath), b64Encode(''));
                hidePreview();
            });
            previewActionsEl.appendChild(composerBtn);

            const censorBtn = document.createElement('button');
            censorBtn.className = 'endgal-preview-action';
            censorBtn.title = 'Open in Censor panel';
            const censorOrigUrl = item && (item.origUrl || item.src) ? (item.origUrl || item.src) : '';
            censorBtn.disabled = !censorOrigUrl;
            censorBtn.innerHTML = '<span class="endgal-preview-action-icon">🖊</span><span class="endgal-preview-action-label">To Censor</span>';
            censorBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                if (!censorOrigUrl) return;
                switchToTabByName('censor');
                setTimeout(() => {
                    if (window.censorPanel && window.censorPanel.openUrl) {
                        window.censorPanel.openUrl(censorOrigUrl);
                    }
                }, 150);
                hidePreview();
            });
            previewActionsEl.appendChild(censorBtn);

            const closeBtn = document.createElement('button');
            closeBtn.className = 'endgal-preview-action endgal-preview-action-close';
            closeBtn.title = 'Close preview';
            closeBtn.innerHTML = '<span class="endgal-preview-action-icon">✕</span><span class="endgal-preview-action-label">Close</span>';
            closeBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                hidePreview();
            });
            previewActionsEl.appendChild(closeBtn);
        }
    }

    /**
     * Escape text for HTML and wrap lines beginning with '#' in a comment span.
     * Used for prompt / negative-prompt panels in the image preview overlay.
     */
    function _formatPromptWithComments(text) {
        function escHtml(s) {
            return String(s || '')
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;');
        }
        const lines = String(text || '').split('\n');
        return lines.map(function (line) {
            var trimmed = line.replace(/^\s+/, '');
            if (trimmed.charAt(0) === '#') {
                return '<span class="prompt-comment">' + escHtml(line) + '</span>';
            }
            return escHtml(line);
        }).join('\n');
    }

    function refreshPreviewMetadata() {
        const item = previewList[previewIndex] || null;
        const parsed = parsePreviewInfotext(item && item.infotextB64 ? b64Decode(item.infotextB64) : '');

        if (previewPromptEl) {
            previewPromptEl.innerHTML = _formatPromptWithComments(parsed.prompt || '(empty)');
        }
        if (previewNegativeEl) {
            previewNegativeEl.innerHTML = _formatPromptWithComments(parsed.negative || '(empty)');
        }
        if (previewSettingsEl) {
            previewSettingsEl.textContent = parsed.settings || '(empty)';
        }

        if (!previewCaptionEl) return;
        const tags = (item && item.tags) || [];
        previewCaptionEl.innerHTML = '';
        if (!tags.length) {
            previewCaptionEl.innerHTML = '<span class="endgal-preview-tags-empty">No caption</span>';
            return;
        }

        tags.forEach((t) => {
            const pill = document.createElement('span');
            pill.className = 'endgal-tag-pill endgal-tag-pill-preview';
            pill.textContent = String(t || '').replace(/_/g, ' ');
            previewCaptionEl.appendChild(pill);
        });
    }

    function queueCurrentPreviewFire() {
        const item = previewList[previewIndex] || null;
        if (!item || !item.infotextB64) return;

        window.endorsedGallery.queueTxt2ImgFire(item.infotextB64, { keepGalleryTab: true });
    }

    function triggerPreviewAction(kind) {
        const item = previewList[previewIndex];
        if (!item) return;
        let actionB64 = null;
        if (kind === 'like') {
            actionB64 = item.endorseAction;
        } else if (kind === 'dislike') {
            actionB64 = item.dislikeAction;
        } else if (kind === 'stage') {
            actionB64 = item.stageAction;
        } else if (kind === 'archive') {
            // Archive action is collected from the corner button
            if (item.quickButtons) {
                const archiveBtn = item.quickButtons.find(b => b.classList.contains('endgal-act-archive'));
                if (archiveBtn) {
                    const onclick = archiveBtn.getAttribute('onclick') || '';
                    const match = onclick.match(/endorsedGallery\.action\('([^']+)'\)/);
                    if (match) actionB64 = match[1];
                }
            }
        }
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
        refreshPreviewMetadata();
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

        refreshGallery: function () {
            const refreshBtn = gradioApp().querySelector('#endgal_refresh_btn');
            if (refreshBtn) refreshBtn.click();
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

        copyTextB64: function (textB64, elem) {
            const text = b64Decode(textB64 || '');
            navigator.clipboard.writeText(text).then(() => {
                const target = elem || null;
                if (target && target.classList) {
                    target.classList.add('endgal-copied');
                    setTimeout(() => target.classList.remove('endgal-copied'), 900);
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

            const totalJobs = overrideSets.length;

            // Flush the fire config to the server-side file immediately so the latest
            // config is persisted even if the textarea hasn't lost focus yet.
            clickGradioBtn('endgal_fire_config_save_btn', 0);

            if (window.webuiBanner) {
                const msg = totalJobs === 1
                    ? 'Fire: queuing 1 job\u2026'
                    : `Fire: queuing ${totalJobs} jobs\u2026`;
                window.webuiBanner.show(msg, { kind: 'info', duration: totalJobs * 650 + 1800 });
            }

            suppressTxt2imgSwitch = true;
            try {
                for (let i = 0; i < overrideSets.length; i += 1) {
                    const currentSet = overrideSets[i];
                    const infotext = applyInfotextOverrides(baseInfotext, currentSet);
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

                    // Force-set batch_count and batch_size sliders directly.
                    // The infotext paste round-trip may not reliably update these sliders
                    // (batch_count was previously absent from txt2img_paste_fields; belt-and-suspenders).
                    const batchCountEntry = currentSet.find((e) => e.key === 'Batch count');
                    const batchSizeEntry = currentSet.find((e) => e.key === 'Batch size');
                    if (batchCountEntry) setGradioSlider('txt2img_batch_count', Number(batchCountEntry.value));
                    if (batchSizeEntry) setGradioSlider('txt2img_batch_size', Number(batchSizeEntry.value));

                    queueBtn.click();
                    await sleep(260);
                }
            } finally {
                suppressTxt2imgSwitch = false;
            }

            if (window.webuiBanner) {
                const msg = totalJobs === 1
                    ? 'Fire: 1 job queued'
                    : `Fire: ${totalJobs} jobs queued`;
                window.webuiBanner.show(msg, { kind: 'success', duration: 3500 });
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
            console.debug('[endorsedGallery] sendToComposer() imagePath=' + (imagePath ? imagePath.split(/[\\\\/]/).pop() : '(none)') + ' configPath=' + (configPath ? 'yes' : 'no'));
            if (!imagePath) { console.debug('[endorsedGallery] sendToComposer() ABORT: no imagePath'); return; }

            switchToTabByName('composer');
            setTimeout(async () => {
                console.debug('[endorsedGallery] sendToComposer() after 450ms, composer_load_from_gallery=' + (typeof window.composer_load_from_gallery));
                if (typeof window.composer_load_from_gallery === 'function') {
                    try {
                        await window.composer_load_from_gallery(imagePath, configPath);
                        console.debug('[endorsedGallery] sendToComposer() completed');
                    } catch (e) {
                        console.warn('[endorsedGallery] sendToComposer() ERROR:', e);
                    }
                } else {
                    console.warn('[endorsedGallery] sendToComposer() composer_load_from_gallery not available');
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

        /**
         * Send selected gallery image to img2img Inpaint tab.
         * Applies infotext to img2img (same as sendTo img2img), switches to the
         * Inpaint sub-tab within img2img, and injects the source image.
         * infotextB64 - base64(infotext string)
         * pathB64     - base64(abs_file_path)
         */
        sendToInpaint: function (infotextB64, pathB64) {
            const infotext = b64Decode(infotextB64 || '');
            const path = b64Decode(pathB64 || '');
            if (!path) return;

            // Apply infotext to img2img (same hidden bridge as sendTo img2img)
            if (infotext) {
                if (!setGradioTextbox('endorsed_gallery_infotext_apply', infotext)) {
                    console.warn('[endorsedGallery] infotext_apply textbox not found');
                } else {
                    clickGradioBtn('endorsed_gallery_apply_img2img_btn', 0);
                }
            }

            // Switch to img2img → Inpaint sub-tab using the built-in switch_to_inpaint()
            setTimeout(() => {
                if (typeof window.switch_to_inpaint === 'function') {
                    window.switch_to_inpaint();
                } else {
                    // Fallback: click img2img tab then Inpaint sub-tab
                    switchToTabByName('img2img');
                    setTimeout(() => {
                        const modeTabs = gradioApp().querySelector('#mode_img2img');
                        if (modeTabs) {
                            const buttons = modeTabs.querySelectorAll('button');
                            // Inpaint is the 3rd tab (index 2: img2img=0, Sketch=1, Inpaint=2)
                            if (buttons[2]) buttons[2].click();
                        }
                    }, 100);
                }
            }, 250);

            // Inject the source image into the Inpaint image input (#img2maskimg)
            setTimeout(() => {
                const fileInput = gradioApp().querySelector('#img2maskimg input[type="file"]');
                if (!fileInput) {
                    console.warn('[endorsedGallery] inpaint file input (#img2maskimg) not found');
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
                    .catch((err) => console.warn('[endorsedGallery] inpaint image inject failed:', err));
            }, 400);
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
                    origUrl: src,
                    endorseAction: '',
                    dislikeAction: '',
                    endorseLabel: '☆',
                    dislikeLabel: '⬇',
                    quickButtons: [],
                    tags: [],
                });
                previewIndex = previewList.length - 1;
            }

            if (!previewImage) return;
            previewImage.src = previewList[previewIndex].src;
            refreshPreviewActionButtons();
            refreshPreviewMetadata();
            resetTransform();
            updatePreviewViewportHeightVar();
            if (document && document.body) {
                previewBodyOverflowBefore = document.body.style.overflow || '';
                document.body.style.overflow = 'hidden';
            }
            overlay.classList.add('show');
        },
    };

    /**
     * Track whether the end-of-gallery hint was present before the current
     * mutation, so we only scroll to it when it *first* appears (i.e. the
     * user clicked Next past the last page), not on every single render of
     * a last-page gallery (endorse/archive/dislike, mode switch, etc.).
     */
    let _endHintWasPresent = false;

    /**
     * Monitor gallery for end-of-gallery state.
     * Only auto-scrolls to the hint when it is *newly* added, never on
     * repeated renders of the same last page.
     */
    function checkAndHandleEndOfGallery() {
        const app = gradioApp();
        if (!app) return;

        const endHint = app.querySelector('#endgal_end_hint');
        const hintNowPresent = !!endHint;

        // Scroll to hint only when it first appears (user navigated past the last page).
        // Do NOT scroll on subsequent mutations that already had the hint (e.g. endorse,
        // archive, dislike, mode switch – all of which re-render the last page).
        if (hintNowPresent && !_endHintWasPresent) {
            if (!isPreviewOpen()) {
                setTimeout(() => {
                    endHint.scrollIntoView({ behavior: 'smooth', block: 'center' });
                }, 100);
            }
        }

        _endHintWasPresent = hintNowPresent;
    }

    // Monitor gallery HTML updates for end-of-gallery state
    function setupEndOfGalleryMonitor() {
        const galleryContainer = gradioApp().querySelector('#endgal_html');
        if (!galleryContainer) return;
        if (galleryContainer.__endgalMonitored) return; // already wired up
        galleryContainer.__endgalMonitored = true;

        // --- Scroll fix state ---
        let lastThumbCount = 0;
        let lastScrollTop = 0;

        // Helper to count thumbs
        function getThumbCount() {
            return galleryContainer.querySelectorAll('.endgal-thumb').length;
        }

        // Save initial state
        lastThumbCount = getThumbCount();
        lastScrollTop = galleryContainer.scrollTop;

        // Track the actual scrollable ancestor of #endgal_html.
        // #endgal_html itself is a gr.HTML component that may not be the
        // scroll container; its parent chain (up to the tab panel) is.
        function getScrollContainer() {
            let el = galleryContainer;
            while (el && el !== document.body) {
                const style = window.getComputedStyle(el);
                const overflowY = style.overflowY;
                if (overflowY === 'auto' || overflowY === 'scroll') {
                    return el;
                }
                el = el.parentElement;
            }
            return galleryContainer; // fallback
        }

        const observer = new MutationObserver(() => {
            const scrollEl = getScrollContainer();

            // Save scroll before any DOM change
            const prevScrollTop = lastScrollTop;
            const prevThumbCount = lastThumbCount;

            // After DOM change
            const newThumbCount = getThumbCount();
            // If new image(s) added: scroll to top
            if (newThumbCount > prevThumbCount) {
                scrollEl.scrollTop = 0;
                galleryContainer.scrollTop = 0;
            } else {
                // Always restore previous scroll position (prevents scroll to bottom)
                scrollEl.scrollTop = prevScrollTop;
                galleryContainer.scrollTop = prevScrollTop;
            }
            lastThumbCount = newThumbCount;
            lastScrollTop = scrollEl.scrollTop;

            checkAndHandleEndOfGallery();
        });

        observer.observe(galleryContainer, {
            childList: true,
            subtree: true,
        });
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

    function getSelectedGalleryModeText() {
        const host = gradioApp().querySelector('#endgal_mode_radio');
        if (!host) return '';

        const checked = host.querySelector('input[type="radio"]:checked');
        if (checked) {
            const label = checked.closest('label');
            const text = (label && label.textContent) ? label.textContent.trim() : '';
            if (text) return text;
        }

        const hidden = host.querySelector('input[type="hidden"]');
        if (hidden && typeof hidden.value === 'string' && hidden.value.trim()) {
            return hidden.value.trim();
        }

        return (host.textContent || '').trim();
    }

    function isGalleryTabVisible() {
        const panel = gradioApp().getElementById('tab_endorsed_gallery');
        return Boolean(panel && panel.style.display !== 'none');
    }

    function isUnratedModeActive() {
        const mode = getSelectedGalleryModeText();
        return mode.includes('Unrated');
    }

    function parseAutoRefreshSeconds(raw) {
        const text = String(raw || '').trim();
        if (!text) return null;

        const lower = text.toLowerCase();
        if (lower === 'off' || lower.includes('off')) return 0;

        const m = text.match(/(\d+)\s*s?/i);
        if (!m) return null;

        const secs = Number(m[1]) || 0;
        return secs > 0 ? secs : 0;
    }

    let autoRefreshIntervalSecondsCache = 0;

    function getAutoRefreshIntervalSeconds() {
        const host = gradioApp().querySelector('#endgal_auto_refresh_interval');
        if (!host) return autoRefreshIntervalSecondsCache;

        const candidates = [];

        function pushCandidate(value) {
            const text = String(value == null ? '' : value).trim();
            if (!text) return;
            candidates.push(text);
        }

        // Prefer values from the currently rendered selected state first.
        const selectedAria = host.querySelector('[aria-selected="true"]');
        if (selectedAria) {
            pushCandidate(selectedAria.dataset && selectedAria.dataset.value);
            pushCandidate(selectedAria.textContent);
        }

        const selectedItem = host.querySelector('.options .item.selected');
        if (selectedItem) {
            pushCandidate(selectedItem.dataset && selectedItem.dataset.value);
            pushCandidate(selectedItem.textContent);
        }

        const hidden = host.querySelector('input[type="hidden"]');
        if (hidden) pushCandidate(hidden.value);

        const textInput = host.querySelector('input[type="text"]');
        if (textInput) pushCandidate(textInput.value);

        const single = host.querySelector('.single-select');
        if (single) pushCandidate(single.textContent);

        if (host.dataset) pushCandidate(host.dataset.value);

        const select = host.querySelector('select');
        if (select) {
            const selectedOpt = select.options && select.selectedIndex >= 0
                ? select.options[select.selectedIndex]
                : null;
            if (selectedOpt) {
                pushCandidate(selectedOpt.value);
                pushCandidate(selectedOpt.textContent);
            }
            // Keep this as lowest-priority fallback because on some Gradio builds
            // select.value can stay at the initial default while UI selection changes.
            pushCandidate(select.value);
        }

        for (const raw of candidates) {
            const secs = parseAutoRefreshSeconds(raw);
            if (secs !== null) {
                autoRefreshIntervalSecondsCache = secs;
                return secs;
            }
        }

        // Keep last known valid interval when dropdown DOM is in transition.
        return autoRefreshIntervalSecondsCache;
    }

    function ensureRefreshCountdownNode() {
        const host = gradioApp().querySelector('#endgal_refresh_btn');
        if (!host) return null;

        let node = host.querySelector('#endgal_refresh_countdown');
        if (node) return node;

        node = document.createElement('div');
        node.id = 'endgal_refresh_countdown';
        node.className = 'endgal-refresh-countdown';
        node.setAttribute('aria-live', 'polite');
        node.textContent = '';
        host.appendChild(node);
        return node;
    }

    function renderRefreshCountdown() {
        const node = ensureRefreshCountdownNode();
        if (!node) return;

        const intervalSeconds = getAutoRefreshIntervalSeconds();
        const enabled = intervalSeconds > 0 && isGalleryTabVisible() && isUnratedModeActive();

        if (!enabled) {
            node.classList.remove('show');
            node.textContent = '';
            return;
        }

        const nextAt = lastAutoRefreshAt + (intervalSeconds * 1000);
        const remainingSeconds = Math.max(0, Math.ceil((nextAt - Date.now()) / 1000));
        node.textContent = `↻ ${remainingSeconds}s`;
        node.classList.add('show');
    }

    let autoRefreshTimer = null;
    let lastAutoRefreshAt = 0;
    let periodicLastIntervalSeconds = null;
    function requestUnratedAutoRefresh(reason) {
        if (!isGalleryTabVisible() || !isUnratedModeActive()) return;
        if (isPreviewOpen()) return;
        if (getAutoRefreshIntervalSeconds() <= 0) return;

        const now = Date.now();
        if (now - lastAutoRefreshAt < 1200) return;

        if (autoRefreshTimer) {
            clearTimeout(autoRefreshTimer);
            autoRefreshTimer = null;
        }

        autoRefreshTimer = setTimeout(() => {
            autoRefreshTimer = null;
            if (!isGalleryTabVisible() || !isUnratedModeActive()) return;
            const refreshBtn = gradioApp().querySelector('#endgal_refresh_btn');
            if (refreshBtn) {
                lastAutoRefreshAt = Date.now();
                refreshBtn.click();
                renderRefreshCountdown();
            }
        }, reason === 'tab-switch' ? 150 : 320);
    }

    function setupUnratedAutoRefreshOnImageCompleted() {
        if (window.__endgalAutoRefreshBound) return;
        window.__endgalAutoRefreshBound = true;

        window.addEventListener('webui:generation', (event) => {
            const detail = event && event.detail ? event.detail : null;
            if (!detail || detail.phase !== 'finish') return;
            requestUnratedAutoRefresh('image-completed');
        });
    }

    function setupUnratedPeriodicAutoRefresh() {
        if (window.__endgalPeriodicAutoRefreshBound) return;
        window.__endgalPeriodicAutoRefreshBound = true;

        setInterval(() => {
            if (!isGalleryTabVisible() || !isUnratedModeActive()) return;

            const seconds = getAutoRefreshIntervalSeconds();
            if (seconds <= 0) {
                renderRefreshCountdown();
                return;
            }

            if (periodicLastIntervalSeconds !== seconds) {
                periodicLastIntervalSeconds = seconds;
                lastAutoRefreshAt = Date.now();
                renderRefreshCountdown();
                return;
            }

            renderRefreshCountdown();

            const now = Date.now();
            if ((now - lastAutoRefreshAt) < (seconds * 1000)) return;
            requestUnratedAutoRefresh('periodic');
        }, 1000);
    }

    function setupAutoRefreshDropdownSync() {
        if (window.__endgalAutoRefreshDropdownSyncBound) return;
        window.__endgalAutoRefreshDropdownSyncBound = true;

        const bindHost = () => {
            const host = gradioApp().querySelector('#endgal_auto_refresh_interval');
            if (!host || host.dataset.endgalAutoRefreshSyncBound === '1') return;

            host.dataset.endgalAutoRefreshSyncBound = '1';

            const onMaybeChanged = (event) => {
                const target = event && event.target ? event.target : null;
                if (target) {
                    const directCandidates = [
                        target.value,
                        target.dataset && target.dataset.value,
                        target.textContent,
                    ];

                    for (const raw of directCandidates) {
                        const secs = parseAutoRefreshSeconds(raw);
                        if (secs !== null) {
                            autoRefreshIntervalSecondsCache = secs;
                            break;
                        }
                    }
                }

                // Refresh from current host state too (this can overwrite cache with newer value).
                getAutoRefreshIntervalSeconds();

                // Re-prime cadence when interval may have changed.
                periodicLastIntervalSeconds = null;
                lastAutoRefreshAt = Date.now();
                renderRefreshCountdown();
            };

            host.addEventListener('change', onMaybeChanged, true);
            host.addEventListener('input', onMaybeChanged, true);
            host.addEventListener('click', onMaybeChanged, true);
            host.addEventListener('keydown', onMaybeChanged, true);

            const hostObserver = new MutationObserver(() => {
                onMaybeChanged();
            });

            hostObserver.observe(host, {
                attributes: true,
                childList: true,
                subtree: true,
            });

            onMaybeChanged();
        };

        bindHost();

        const app = gradioApp();
        if (!app) return;
        const appObserver = new MutationObserver(() => {
            bindHost();
        });

        appObserver.observe(app, {
            childList: true,
            subtree: true,
        });
    }

    /**
     * Intercept the "Delete Originals" button to show a confirmation dialog.
     * This prevents accidental deletion of archived image files.
     */
    function setupDeleteOriginalsConfirm() {
        const btn = gradioApp().querySelector('#endgal_delete_originals_btn');
        if (!btn || btn.__endgalDelConfirm) return;
        btn.__endgalDelConfirm = true;

        btn.addEventListener('click', function(e) {
            const confirmed = window.confirm(
                'This will permanently delete the original PNG files for ALL archived images.\n' +
                'Thumbnails and preview caches will be kept.\n\n' +
                'This action CANNOT be undone. Continue?'
            );
            if (!confirmed) {
                e.stopImmediatePropagation();
                e.preventDefault();
            }
        }, true); // use capture phase to intercept before Gradio
    }

    /**
     * Intercept the "Delete Disliked" button to show a confirmation dialog.
     * This prevents accidental deletion of disliked image files.
     */
    function setupDeleteDislikedConfirm() {
        const btn = gradioApp().querySelector('#endgal_delete_disliked_btn');
        if (!btn || btn.__endgalDelDislikeConfirm) return;
        btn.__endgalDelDislikeConfirm = true;

        btn.addEventListener('click', function(e) {
            const confirmed = window.confirm(
                'This will permanently delete the original PNG files for ALL disliked images.\n' +
                'Thumbnails and preview caches will be kept.\n\n' +
                'This action CANNOT be undone. Continue?'
            );
            if (!confirmed) {
                e.stopImmediatePropagation();
                e.preventDefault();
            }
        }, true); // use capture phase to intercept before Gradio
    }

    /**
     * Watch the hidden stats HTML component. When populated, show a modal popup
     * with the gallery statistics. Close on backdrop click or Escape.
     */
    function setupStatisticsPopup() {
        const statsEl = gradioApp().querySelector('#endgal_stats_html');
        if (!statsEl || statsEl.__endgalStatsPopup) return;
        statsEl.__endgalStatsPopup = true;

        // Create modal overlay once
        let overlay = document.getElementById('endgal_stats_overlay');
        if (!overlay) {
            overlay = document.createElement('div');
            overlay.id = 'endgal_stats_overlay';
            overlay.className = 'endgal-stats-overlay';
            overlay.innerHTML = '<div class="endgal-stats-modal"><div class="endgal-stats-close">&times;</div><div class="endgal-stats-body"></div></div>';
            document.body.appendChild(overlay);

            // Close on backdrop click
            overlay.addEventListener('click', function(e) {
                if (e.target === overlay) closeStats();
            });
            // Close on X button
            overlay.querySelector('.endgal-stats-close').addEventListener('click', closeStats);
            // Close on Escape
            document.addEventListener('keydown', function(e) {
                if (e.key === 'Escape' && overlay.classList.contains('show')) closeStats();
            });
        }

        function closeStats() {
            overlay.classList.remove('show');
            document.body.style.overflow = '';
        }

        // Watch for content changes
        const observer = new MutationObserver(function() {
            // Check for our specific stats wrapper injected by Python backend
            const wrapper = statsEl.querySelector('.endgal-stats-wrap');
            if (!wrapper) return;
            
            // Move content into modal
            const body = overlay.querySelector('.endgal-stats-body');
            body.innerHTML = wrapper.outerHTML;
            
            overlay.classList.add('show');
            document.body.style.overflow = 'hidden';
            
            // Clear the hidden component so it can be re-triggered on next click
            statsEl.innerHTML = '';
        });

        observer.observe(statsEl, { childList: true, subtree: true, characterData: true });
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
            setTimeout(setupUnratedAutoRefreshOnImageCompleted, 600);
            setTimeout(setupUnratedPeriodicAutoRefresh, 700);
            setTimeout(setupAutoRefreshDropdownSync, 800);
            setTimeout(setupEndOfGalleryMonitor, 1200);
            setTimeout(setupEndOfGalleryMonitor, 3000);
            setTimeout(setupReverseUnratedSync, 1500);
            setTimeout(setupReverseUnratedSync, 3000);
            setTimeout(setupDeleteOriginalsConfirm, 1500);
            setTimeout(setupDeleteOriginalsConfirm, 3000);
            setTimeout(setupDeleteDislikedConfirm, 1500);
            setTimeout(setupDeleteDislikedConfirm, 3000);
            setTimeout(setupStatisticsPopup, 1500);
            setTimeout(setupStatisticsPopup, 3000);
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
        setTimeout(setupUnratedAutoRefreshOnImageCompleted, 600);
        setTimeout(setupUnratedPeriodicAutoRefresh, 700);
        setTimeout(setupAutoRefreshDropdownSync, 800);
        setTimeout(setupEndOfGalleryMonitor, 1200);
        setTimeout(setupEndOfGalleryMonitor, 3000);
        setTimeout(setupReverseUnratedSync, 1500);
        setTimeout(setupReverseUnratedSync, 3000);
        setTimeout(setupDeleteOriginalsConfirm, 1500);
        setTimeout(setupDeleteOriginalsConfirm, 3000);
        setTimeout(setupDeleteDislikedConfirm, 1500);
        setTimeout(setupDeleteDislikedConfirm, 3000);
        setTimeout(setupStatisticsPopup, 1500);
        setTimeout(setupStatisticsPopup, 3000);
    }

})();
