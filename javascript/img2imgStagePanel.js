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
    { key: "resize_tab", label: "Resize To/By" },
    { key: "scale_by", label: "Scale (Resize by)" },
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

function setImg2imgStagePayload(value) {
    const wrap = gradioApp().getElementById('img2img_stage_payload');
    if (!wrap) return false;
    const ta = wrap.querySelector('textarea');
    if (!ta) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    setter.call(ta, value);
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
}

function clickImg2imgStageButton(btnId) {
    setTimeout(function() {
        const btn = gradioApp().getElementById(btnId);
        if (btn) btn.click();
    }, 60);
}

function openImg2imgStagePopup() {
    const fields = getImg2imgStageFields();

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
        if (!setImg2imgStagePayload(payload)) {
            console.warn('[img2imgStagePanel] payload textbox not found');
            return;
        }
        if (typeof closePopup === 'function') closePopup();
        clickImg2imgStageButton('img2img_stage_capture_btn');
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
    if (!setImg2imgStagePayload(name)) {
        console.warn('[img2imgStagePanel] payload textbox not found');
        return;
    }
    clickImg2imgStageButton('img2img_stage_apply_btn');
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
    if (!setImg2imgStagePayload(name)) {
        console.warn('[img2imgStagePanel] payload textbox not found');
        return;
    }
    clickImg2imgStageButton('img2img_stage_drop_btn');
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
 * Visually select the Resize To/By tab matching the hidden selector value
 * (0 = Resize to, 1 = Resize by). Called from the selector's change event,
 * which gradio fires for both user clicks and stage-apply output updates.
 */
function syncImg2imgResizeTab(value) {
    const tabsEl = gradioApp().getElementById('img2img_tabs_resize');
    if (!tabsEl) return [];

    const idx = Number(value);
    if (idx !== 0 && idx !== 1) return [];

    const buttons = tabsEl.querySelectorAll('button');
    const target = buttons[idx];
    if (target && !target.classList.contains('selected')) {
        target.click();
    }
    return [];
}

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
