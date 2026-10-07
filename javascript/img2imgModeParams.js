/**
 * javascript/img2imgModeParams.js
 *
 * Per-mode parameter separation for the img2img tab. The generation settings
 * (prompt, negative prompt, steps, sampler, scheduler, seed, CFG, sizes, batch,
 * denoising, resize mode and the inpaint controls) are SHARED between the six
 * img2img modes (img2img / Sketch / Inpaint / Inpaint sketch / Inpaint upload /
 * Batch). This keeps a private copy per mode:
 *
 *   - switching modes manually saves the outgoing mode's current values and
 *     restores the incoming mode's stored values;
 *   - "Send to img2img / inpaint" pastes (output gallery, PNG info, gen tools,
 *     composer, gallery cards) are routed into the TARGET mode only: the
 *     source mode keeps its pre-paste parameters, and only the fields the
 *     paste actually changed are merged into the target mode's parameters.
 *
 * Values are kept in localStorage (`img2img.mode_params.v1`) so they survive
 * UI reloads.
 */
(function () {
    'use strict';

    var LS_KEY = 'img2img.mode_params.v1';
    var SNAP_TTL = 2500; // ms a pre-paste snapshot stays valid
    var MODE_KEYS = ['img2img', 'sketch', 'inpaint', 'inpaint_sketch', 'inpaint_upload', 'batch'];

    var FIELDS = [
        { key: 'prompt',              el: 'img2img_prompt',                  type: 'textarea' },
        { key: 'negative_prompt',     el: 'img2img_neg_prompt',              type: 'textarea' },
        { key: 'steps',               el: 'img2img_steps',                   type: 'slider' },
        { key: 'sampler_name',        el: 'img2img_sampling',                type: 'dropdown' },
        { key: 'scheduler',           el: 'img2img_scheduler',               type: 'dropdown' },
        { key: 'seed',                el: 'img2img_seed',                    type: 'number' },
        { key: 'cfg_scale',           el: 'img2img_cfg_scale',               type: 'slider' },
        { key: 'image_cfg_scale',     el: 'img2img_image_cfg_scale',         type: 'slider' },
        { key: 'width',               el: 'img2img_width',                   type: 'slider' },
        { key: 'height',              el: 'img2img_height',                  type: 'slider' },
        { key: 'resize_tab',          el: 'img2img_selected_scale_tab',      type: 'number' },
        { key: 'scale_by',            el: 'img2img_scale',                   type: 'slider' },
        { key: 'batch_count',         el: 'img2img_batch_count',             type: 'slider' },
        { key: 'batch_size',          el: 'img2img_batch_size',              type: 'slider' },
        { key: 'denoising_strength',  el: 'img2img_denoising_strength',      type: 'slider' },
        { key: 'resize_mode',         el: 'resize_mode',                     type: 'radio' },
        { key: 'mask_blur',           el: 'img2img_mask_blur',               type: 'slider' },
        { key: 'mask_mode',           el: 'img2img_mask_mode',               type: 'radio' },
        { key: 'masked_content',      el: 'img2img_inpainting_fill',         type: 'radio' },
        { key: 'inpaint_area',        el: 'img2img_inpaint_full_res',        type: 'radio' },
        { key: 'only_masked_padding', el: 'img2img_inpaint_full_res_padding', type: 'slider' },
    ];

    var store = loadStore();
    var currentMode = -1;
    var suppressRestore = false;
    var manualPending = -1;
    var snapshot = null; // { at, values } captured on pointerdown, before any paste
    var wrappedSwitches = {}; // switch function name -> true (prevents double wrapping)
    var restoredOnLoad = false;

    function loadStore() {
        var out = {};
        try {
            var raw = window.localStorage && window.localStorage.getItem(LS_KEY);
            if (raw) {
                var parsed = JSON.parse(raw);
                if (parsed && typeof parsed === 'object') out = parsed;
            }
        } catch (e) { /* ignore */ }
        return out;
    }

    function persist() {
        try {
            if (window.localStorage) window.localStorage.setItem(LS_KEY, JSON.stringify(store));
        } catch (e) { /* ignore */ }
    }

    function app() {
        return typeof gradioApp === 'function' ? gradioApp() : null;
    }

    function hostEl(field) {
        var a = app();
        if (!a || !a.querySelector) return null;
        return a.querySelector('#' + field.el);
    }

    // ── reads ───────────────────────────────────────────────────────────────

    function radioValueOf(input) {
        if (!input) return undefined;
        // gradio 3.41 Radio stores the choice value in a __value property
        if (input.__value !== undefined) return input.__value;
        var label = input.closest && input.closest('label');
        if (label && label.dataset && label.dataset.testid) {
            return label.dataset.testid.replace(/-radio-label$/, '');
        }
        return input.value !== undefined && input.value !== '' ? input.value : undefined;
    }

    function readField(field) {
        var host = hostEl(field);
        if (!host) return undefined;
        var el;
        switch (field.type) {
            case 'textarea':
                el = host.querySelector('textarea');
                return el ? el.value : undefined;
            case 'slider': {
                var num = host.querySelector('input[type="number"]');
                var rng = host.querySelector('input[type="range"]');
                el = num || rng;
                if (!el) return undefined;
                var v = parseFloat(el.value);
                return isNaN(v) ? undefined : v;
            }
            case 'number': {
                var n = host.querySelector('input[type="number"]');
                if (n) {
                    var nv = parseFloat(n.value);
                    return isNaN(nv) ? undefined : nv;
                }
                var ta = host.querySelector('textarea');
                return ta ? ta.value : undefined;
            }
            case 'dropdown': {
                var sel = host.querySelector('select');
                if (sel) return sel.value;
                var list = host.querySelector('ul.options');
                if (list) {
                    var inp = host.querySelector('input');
                    return inp ? inp.value : undefined;
                }
                return radioValueOf(host.querySelector('input[type="radio"]:checked'));
            }
            case 'radio':
                return radioValueOf(host.querySelector('input[type="radio"]:checked'));
        }
        return undefined;
    }

    function captureAll() {
        var out = {};
        FIELDS.forEach(function (f) {
            var v = readField(f);
            if (v !== undefined && v !== null) out[f.key] = v;
        });
        return out;
    }

    // ── writes ───────────────────────────────────────────────────────────────

    function textSetter(el, value) {
        var set = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
        set.call(el, String(value));
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
    }

    function inputSetter(el, value) {
        var set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        set.call(el, String(value));
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
    }

    function setNativeSelect(sel, value) {
        var target = String(value);
        var opts = sel.options;
        for (var i = 0; i < opts.length; i++) {
            var opt = opts[i];
            var v = opt.__value !== undefined ? opt.__value : (opt.value !== undefined ? opt.value : opt.textContent);
            if (String(v) === target) {
                sel.selectedIndex = i;
                break;
            }
        }
        sel.dispatchEvent(new Event('change', { bubbles: true }));
    }

    function setRadio(host, value) {
        var target = String(value);
        var inputs = host.querySelectorAll('input[type="radio"]');
        for (var i = 0; i < inputs.length; i++) {
            if (String(radioValueOf(inputs[i])) === target) {
                inputs[i].checked = true;
                inputs[i].dispatchEvent(new Event('change', { bubbles: true }));
                return true;
            }
        }
        return false;
    }

    /**
     * Gradio 3.41 dropdowns are custom listboxes (`<ul class="options">` with
     * `li[data-value]` options). Picking a value = dispatching mousedown on the
     * matching option; the component then updates its state and closes.
     */
    function setDropdown(host, value, retried) {
        var target = String(value);
        var sel = host.querySelector('select');
        if (sel) {
            setNativeSelect(sel, target);
            return true;
        }
        var input = host.querySelector('input');
        if (input && String(input.value || '') === target) return true; // already selected

        var list = host.querySelector('ul.options');
        if (!list) {
            if (!retried && input) {
                // the options list is created lazily in some builds: open it once
                try { input.click(); } catch (e) { /* ignore */ }
                setTimeout(function () { setDropdown(host, value, true); }, 60);
                return false;
            }
            return setRadio(host, value); // sampler rendered as a radio group
        }

        var options = list.querySelectorAll('li[data-value]');
        for (var i = 0; i < options.length; i++) {
            if (options[i].getAttribute('data-value') === target) {
                options[i].dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
                return true;
            }
        }
        return false;
    }

    function writeField(field, value) {
        if (value === undefined || value === null) return;
        var host = hostEl(field);
        if (!host) return;
        switch (field.type) {
            case 'textarea': {
                var ta = host.querySelector('textarea');
                if (!ta || ta.value === String(value)) return;
                textSetter(ta, value);
                break;
            }
            case 'slider': {
                var num = host.querySelector('input[type="number"]');
                var rng = host.querySelector('input[type="range"]');
                var cur = parseFloat(num ? num.value : rng ? rng.value : 'NaN');
                if (isNaN(cur) || Math.abs(cur - Number(value)) > 1e-9) {
                    if (num) inputSetter(num, value);
                    if (rng) inputSetter(rng, value);
                }
                break;
            }
            case 'number': {
                var n = host.querySelector('input[type="number"]');
                if (n) {
                    if (String(n.value) !== String(value)) inputSetter(n, value);
                    return;
                }
                var ta2 = host.querySelector('textarea');
                if (ta2 && ta2.value !== String(value)) textSetter(ta2, value);
                break;
            }
            case 'dropdown':
                setDropdown(host, value, false);
                break;
            case 'radio':
                setRadio(host, value);
                break;
        }
    }

    function restoreMode(idx) {
        var params = store[String(idx)];
        if (!params) return;
        FIELDS.forEach(function (f) {
            if (params[f.key] !== undefined) writeField(f, params[f.key]);
        });
    }

    function saveMode(idx) {
        if (idx < 0 || idx >= MODE_KEYS.length) return;
        store[String(idx)] = captureAll();
        persist();
    }

    function diffValues(before, after) {
        var changed = {};
        Object.keys(after || {}).forEach(function (k) {
            if (before[k] === undefined || after[k] === undefined) return;
            if (before[k] !== after[k]) changed[k] = after[k];
        });
        return changed;
    }

    function currentModeIndex() {
        var a = app();
        if (!a) return currentMode;
        var tabs = a.querySelector('#mode_img2img .tab-nav');
        if (!tabs) return currentMode;
        var buttons = tabs.querySelectorAll('button');
        for (var i = 0; i < buttons.length; i++) {
            if (buttons[i].classList.contains('selected')) return i;
        }
        return currentMode;
    }

    function modeIndexOfButton(btn) {
        if (!btn || !btn.closest) return -1;
        var tabs = btn.closest('#mode_img2img');
        if (!tabs) return -1;
        var buttons = tabs.querySelectorAll('.tab-nav button');
        return Array.prototype.indexOf.call(buttons, btn);
    }

    function takeSnapshot() {
        snapshot = { at: Date.now(), values: captureAll() };
    }

    function freshSnapshot() {
        if (snapshot && Date.now() - snapshot.at < SNAP_TTL) return snapshot.values;
        return null;
    }

    // ── programmatic switches (send-to / copy-to) ────────────────────────────

    function performSwitch(target) {
        if (typeof target !== 'number' || isNaN(target)) target = 0;
        target = Math.max(0, Math.min(MODE_KEYS.length - 1, Math.round(target)));
        var outgoing = currentModeIndex();
        var before = freshSnapshot();
        var changed = null;
        if (before) changed = diffValues(before, captureAll());

        if (outgoing !== target) {
            // the outgoing mode keeps its pre-paste parameters
            if (outgoing >= 0) store[String(outgoing)] = before || captureAll();
        }
        if (changed) {
            store[String(target)] = Object.assign({}, store[String(target)] || {}, changed);
        }
        persist();
        currentMode = target;

        suppressRestore = true;
        if (typeof window.switch_to_img2img_tab === 'function') {
            window.switch_to_img2img_tab(target);
        } else {
            var a = app();
            var buttons = a ? a.querySelectorAll('#mode_img2img .tab-nav button') : [];
            if (buttons[target]) buttons[target].click();
        }

        if (outgoing !== target) {
            setTimeout(function () { restoreMode(target); }, 50);
        }
    }

    function wrapSwitch(name, index) {
        var orig = window[name];
        if (typeof orig !== 'function' || wrappedSwitches[name]) return;
        wrappedSwitches[name] = true;
        window[name] = function () {
            performSwitch(index);
            return Array.from(arguments);
        };
    }

    // ── installation ─────────────────────────────────────────────────────────

    function install() {
        if (window.__img2imgModeParamsInstalled) return;
        window.__img2imgModeParamsInstalled = true;

        currentMode = currentModeIndex();
        if (currentMode < 0) currentMode = 0;

        wrapSwitch('switch_to_img2img', 0);
        wrapSwitch('switch_to_sketch', 1);
        wrapSwitch('switch_to_inpaint', 2);
        wrapSwitch('switch_to_inpaint_sketch', 3);

        // capture the current parameters on every pointerdown, so a following
        // send-to paste can be diffed against the pre-paste state
        document.addEventListener('pointerdown', function (e) {
            var t = e.target;
            if (!t || !t.closest) return;
            var modeBtn = t.closest('#mode_img2img .tab-nav button');
            if (modeBtn) {
                var idx = modeIndexOfButton(modeBtn);
                if (idx >= 0 && idx !== currentModeIndex()) {
                    saveMode(currentModeIndex());
                    manualPending = idx;
                }
                return;
            }
            takeSnapshot();
        }, true);

        // after a user-driven mode switch, restore that mode's stored parameters
        document.addEventListener('click', function (e) {
            var t = e.target;
            if (!t || !t.closest) return;
            var modeBtn = t.closest('#mode_img2img .tab-nav button');
            if (!modeBtn) return;
            if (suppressRestore) { // programmatic switch handled by performSwitch
                suppressRestore = false;
                return;
            }
            var idx = modeIndexOfButton(modeBtn);
            if (idx >= 0 && manualPending === idx) {
                manualPending = -1;
                currentMode = idx;
                setTimeout(function () { restoreMode(idx); }, 50);
            }
        }, true);

        window.addEventListener('beforeunload', function () {
            var idx = currentModeIndex();
            if (idx >= 0) saveMode(idx);
        });

        // keep the active mode's store fresh while the user keeps editing
        // (skipped right after a pointerdown so paste flows are never saved
        // into the wrong mode mid-flight)
        setInterval(function () {
            if (snapshot && Date.now() - snapshot.at < SNAP_TTL) return;
            var idx = currentModeIndex();
            if (idx >= 0) saveMode(idx);
        }, 4000);

        restoreOnceOnLoad();
    }

    // Restore the initially active mode's stored parameters once the UI is up,
    // so per-mode separation survives a page reload.
    function restoreOnceOnLoad() {
        if (restoredOnLoad) return;
        var idx = currentModeIndex();
        if (idx < 0) return;
        restoredOnLoad = true;
        setTimeout(function () { restoreMode(idx); }, 300);
    }

    if (typeof onUiLoaded === 'function') {
        onUiLoaded(install);
        if (typeof onAfterUiUpdate === 'function') onAfterUiUpdate(restoreOnceOnLoad);
    }

    // exposed for node tests (tmp/img2img_mode_params_test.js): pure helpers only
    window.img2imgModeParamsDebug = {
        modeKeys: MODE_KEYS,
        fields: FIELDS,
        diffValues: diffValues,
    };
})();
