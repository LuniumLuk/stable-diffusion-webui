// img2img staging panel: add / apply / drop stages of generation settings.
//
// The field list is injected by the backend into #img2img_stage_list's
// data-fields attribute (must match IMG2IMG_STAGE_FIELDS in modules/ui_toprow.py).
// All backend communication goes through hidden Gradio controls:
//   #img2img_stage_payload (textbox) + #img2img_stage_{capture,apply,drop}_btn.

const IMG2IMG_STAGE_FALLBACK_FIELDS = [
    { key: "prompt", label: "Prompt" },
    { key: "negative_prompt", label: "Negative prompt" },
    { key: "steps", label: "Sampling steps" },
    { key: "sampler_name", label: "Sampling method" },
    { key: "scheduler", label: "Schedule type" },
    { key: "seed", label: "Seed" },
    { key: "cfg_scale", label: "CFG Scale" },
    { key: "image_cfg_scale", label: "Image CFG Scale" },
    { key: "width", label: "Width" },
    { key: "height", label: "Height" },
    { key: "resize_tab", label: "Resize To/By/Mask" },
    { key: "scale_by", label: "Scale (Resize by / By mask)" },
    { key: "batch_count", label: "Batch count" },
    { key: "batch_size", label: "Batch size" },
    { key: "denoising_strength", label: "Denoising strength" },
    { key: "resize_mode", label: "Resize mode" },
    { key: "mask_blur", label: "Mask blur" },
    { key: "mask_mode", label: "Mask mode" },
    { key: "masked_content", label: "Masked content" },
    { key: "inpaint_area", label: "Inpaint area" },
    { key: "only_masked_padding", label: "Only masked padding" },
];

function getImg2imgStageFields() {
    const listEl = gradioApp().getElementById('img2img_stage_list');
    if (listEl && listEl.dataset && listEl.dataset.fields) {
        try {
            const parsed = JSON.parse(listEl.dataset.fields);
            if (Array.isArray(parsed) && parsed.length > 0) return parsed;
        } catch (e) {
            // fall through to fallback
        }
    }
    return IMG2IMG_STAGE_FALLBACK_FIELDS;
}

// The result panel's ➕ Stage button (ui_common.create_output_panel) captures the
// same settings through its own hidden bridge; modules/ui.py wires only these
// components into the txt2img bridge, so img2img-only fields are not offered.
const TXT2IMG_STAGE_KEYS = [
    'prompt', 'negative_prompt', 'steps', 'sampler_name', 'scheduler', 'seed',
    'cfg_scale', 'width', 'height', 'batch_count', 'batch_size',
];

/** Hidden capture bridge of one generation tab (img2img toprow by default). */
function stageBridgeFor(tabname) {
    if (tabname === 'txt2img' || tabname === 'img2img') {
        return {
            payloadId: tabname + '_stage_quick_payload',
            captureId: tabname + '_stage_quick_capture',
            keys: tabname === 'txt2img' ? TXT2IMG_STAGE_KEYS : null,
        };
    }
    return { payloadId: 'img2img_stage_payload', captureId: 'img2img_stage_capture_btn', keys: null };
}

function setStagePayload(payloadId, value) {
    const wrap = gradioApp().getElementById(payloadId);
    if (!wrap) return false;
    const ta = wrap.querySelector('textarea');
    if (!ta) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    setter.call(ta, value);
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
}

function clickStageButton(btnId) {
    setTimeout(function() {
        const btn = gradioApp().getElementById(btnId);
        if (btn) btn.click();
    }, 60);
}

function openImg2imgStagePopup(bridge) {
    // Gradio calls this from the toprow "Add stage" button without arguments
    if (!bridge || !bridge.payloadId) bridge = stageBridgeFor('img2img');

    const fields = getImg2imgStageFields().filter(function(field) {
        return !bridge.keys || bridge.keys.indexOf(field.key) >= 0;
    });

    const wrapper = document.createElement('div');
    wrapper.className = 'img2img-stage-popup';

    const title = document.createElement('h3');
    title.textContent = 'Stage settings';
    wrapper.appendChild(title);

    const nameRow = document.createElement('div');
    nameRow.className = 'img2img-stage-popup-name-row';
    const nameLabel = document.createElement('label');
    nameLabel.textContent = 'Name';
    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.id = 'img2img_stage_popup_name';
    nameInput.placeholder = 'Leave empty to auto-name (#1, #2, ...)';
    nameRow.appendChild(nameLabel);
    nameRow.appendChild(nameInput);
    wrapper.appendChild(nameRow);

    const fieldBox = document.createElement('div');
    fieldBox.className = 'img2img-stage-popup-fields';
    fields.forEach(function(field) {
        const row = document.createElement('label');
        row.className = 'img2img-stage-popup-field';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = true;
        cb.dataset.key = field.key;
        const span = document.createElement('span');
        span.textContent = field.label || field.key;
        row.appendChild(cb);
        row.appendChild(span);
        fieldBox.appendChild(row);
    });
    wrapper.appendChild(fieldBox);

    const btnRow = document.createElement('div');
    btnRow.className = 'img2img-stage-popup-buttons';
    const applyBtn = document.createElement('button');
    applyBtn.type = 'button';
    applyBtn.className = 'img2img-stage-popup-apply';
    applyBtn.textContent = 'Apply';
    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'img2img-stage-popup-cancel';
    cancelBtn.textContent = 'Cancel';
    btnRow.appendChild(applyBtn);
    btnRow.appendChild(cancelBtn);
    wrapper.appendChild(btnRow);

    applyBtn.addEventListener('click', function() {
        const selected = [];
        fieldBox.querySelectorAll('input[type="checkbox"]:checked').forEach(function(cb) {
            selected.push(cb.dataset.key);
        });
        if (!selected.length) {
            console.warn('[img2imgStagePanel] no fields selected');
            return;
        }
        const name = (nameInput.value || '').trim();
        const payload = JSON.stringify({ name: name, fields: selected });
        if (!setStagePayload(bridge.payloadId, payload)) {
            console.warn('[img2imgStagePanel] payload textbox not found');
            return;
        }
        if (typeof closePopup === 'function') closePopup();
        clickStageButton(bridge.captureId);
    });

    cancelBtn.addEventListener('click', function() {
        if (typeof closePopup === 'function') closePopup();
    });

    if (typeof popup === 'function') {
        popup(wrapper);
    } else {
        console.warn('[img2imgStagePanel] global popup helper not found');
    }
}

function img2imgStageApply(btnEl) {
    const name = (btnEl && btnEl.dataset && btnEl.dataset.stage) || '';
    if (!name) return;
    if (!setStagePayload('img2img_stage_payload', name)) {
        console.warn('[img2imgStagePanel] payload textbox not found');
        return;
    }
    clickStageButton('img2img_stage_apply_btn');
    notifyStageApplied(name);
}

/** Pop a global banner hint, styled like the "img2img finished: N images" banners. */
function notifyStageApplied(name) {
    if (window.webuiBanner && typeof window.webuiBanner.show === 'function') {
        window.webuiBanner.show('img2img stage applied: ' + name, {
            key: 'stage-apply-' + name,
            kind: 'success',
            duration: 3200,
        });
    }
}

function img2imgStageDrop(btnEl) {
    const name = (btnEl && btnEl.dataset && btnEl.dataset.stage) || '';
    if (!name) return;
    if (!setStagePayload('img2img_stage_payload', name)) {
        console.warn('[img2imgStagePanel] payload textbox not found');
        return;
    }
    clickStageButton('img2img_stage_drop_btn');
}

/**
 * Apply the stage at the given 0-based position in the stage list.
 * Returns true when a stage was applied.
 */
function img2imgStageApplyByIndex(index) {
    const tabImg2Img = gradioApp().getElementById('tab_img2img');
    if (!tabImg2Img || tabImg2Img.style.display === 'none') return false;

    const list = gradioApp().getElementById('img2img_stage_list');
    if (!list) return false;

    const items = list.querySelectorAll('.img2img-stage-item');
    if (items.length <= index) return false;

    const applyBtn = items[index].querySelector('button.apply');
    if (!applyBtn) return false;

    applyBtn.click();
    return true;
}

/**
 * The "By mask" resize tab measures the inpaint mask, so it only exists in the inpaint
 * modes (2 = inpaint, 3 = inpaint sketch, 4 = inpaint upload).
 */
function img2imgMaskScaleTabVisible() {
    const modeNav = gradioApp().querySelector('#mode_img2img .tab-nav');
    if (!modeNav) return false;

    const buttons = Array.prototype.slice.call(modeNav.querySelectorAll('button'));
    const idx = buttons.findIndex(function (button) { return button.classList.contains('selected'); });
    return idx >= 2 && idx <= 4;
}

/**
 * Hide the "By mask" resize tab outside the inpaint modes, and leave it selected only
 * where it means something: a hidden tab must never stay the active one.
 */
function syncImg2imgMaskScaleTab() {
    const tabsEl = gradioApp().getElementById('img2img_tabs_resize');
    if (!tabsEl) return;

    const nav = tabsEl.querySelector('.tab-nav');
    const buttons = nav ? Array.prototype.slice.call(nav.querySelectorAll('button')) : [];
    if (buttons.length < 3) return;

    const show = img2imgMaskScaleTabVisible();
    buttons[2].classList.toggle('img2img-mask-tab-hidden', !show);

    if (!show && buttons[2].classList.contains('selected')) {
        buttons[0].click();
    }
}

/**
 * Visually select the Resize To/By/Mask tab matching the hidden selector value
 * (0 = Resize to, 1 = Resize by, 2 = By mask). Called from the selector's change event,
 * which gradio fires for both user clicks and stage-apply output updates.
 */
function syncImg2imgResizeTab(value) {
    const tabsEl = gradioApp().getElementById('img2img_tabs_resize');
    if (!tabsEl) return [];

    const idx = Number(value);
    if (idx !== 0 && idx !== 1 && idx !== 2) return [];

    syncImg2imgMaskScaleTab();

    const buttons = tabsEl.querySelectorAll('button');
    // a Resize-by-mask state restored outside the inpaint modes falls back to "Resize to"
    const target = buttons[idx === 2 && !img2imgMaskScaleTabVisible() ? 0 : idx];
    if (target && !target.classList.contains('selected')) {
        target.click();
    }
    return [];
}

// Quick action in the result panel (ui_common.create_output_panel): the ➕ Stage
// button opens the same field picker and captures through that tab's hidden
// bridge, so it works from both txt2img and img2img results.
document.addEventListener('click', function(event) {
    const btn = event.target instanceof Element ? event.target.closest('button[id]') : null;
    if (!btn || (btn.id !== 'txt2img_stage' && btn.id !== 'img2img_stage')) return;

    event.preventDefault();
    event.stopPropagation();
    openImg2imgStagePopup(stageBridgeFor(btn.id === 'txt2img_stage' ? 'txt2img' : 'img2img'));
}, true);

// Alt+1..9 applies the 1st..9th stage in the list (img2img tab only).
document.addEventListener('keydown', function(event) {
    if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const match = /^([1-9])$/.exec(event.key || '');
    if (!match) return;

    if (img2imgStageApplyByIndex(parseInt(match[1], 10) - 1)) {
        event.preventDefault();
        event.stopPropagation();
    }
});

// The resize tabs follow the img2img sub-mode: keep "By mask" in sync with it.
// Bubble phase, so gradio has already moved `selected` to the clicked sub-mode tab.
document.addEventListener('click', function(event) {
    if (!(event.target instanceof Element) || !event.target.closest('#mode_img2img .tab-nav')) return;
    setTimeout(syncImg2imgMaskScaleTab, 0);
    setTimeout(syncImg2imgMaskScaleTab, 300);
});

onUiLoaded(syncImg2imgMaskScaleTab);
