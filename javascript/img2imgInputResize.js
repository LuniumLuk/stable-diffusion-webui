// Effective init-image size for the "Resize-by" preview and the auto-detected size.
//
// The optional "Resize Input" accordion pre-resizes the picture before img2img encodes it, so the
// Resize-by factor applies to the pre-resized size, not to the raw source dimensions.
// This mirrors modules/input_resize.py::plan_resize (authoritative) and the Mobile Lite twin in
// mobile_lite/js/resize-plan.js; keep the three in sync.

function img2imgInputResizeRound8(value) {
    return Math.min(2048, Math.max(64, Math.round(value / 8) * 8));
}

function img2imgInputResizeNumber(root, elemId, fallback) {
    var host = root.querySelector('#' + elemId);
    if (!host) return fallback;

    var input = host.querySelector('input[type="number"]') || host.querySelector('input[type="range"]');
    var value = input ? parseFloat(input.value) : NaN;
    return isNaN(value) ? fallback : value;
}

function img2imgInputResizeRadioValue(root, elemId) {
    var checked = root.querySelector('#' + elemId + ' input[type="radio"]:checked');
    if (!checked) return '';

    if (checked.__value !== undefined) return String(checked.__value).trim().toLowerCase();

    var label = checked.closest('label');
    if (label && label.dataset && label.dataset.testid) {
        return label.dataset.testid.replace(/-radio-label$/, '').trim().toLowerCase();
    }
    return '';
}

/** Size after the "Resize Input" pre-resize, or null when it is off (or a no-op). */
function img2imgEffectiveInputSize(sourceWidth, sourceHeight) {
    var root = gradioApp();
    var enable = root.querySelector('#resize_input_enable-checkbox input[type="checkbox"]');
    if (!enable || !enable.checked) return null;

    var width = Math.max(1, Math.trunc(Number(sourceWidth) || 0));
    var height = Math.max(1, Math.trunc(Number(sourceHeight) || 0));
    if (!width || !height) return null;

    var mode = img2imgInputResizeRadioValue(root, 'resize_input_mode');
    var targetWidth, targetHeight;
    if (mode === 'scale') {
        var factor = Math.min(4, Math.max(0.1, img2imgInputResizeNumber(root, 'resize_input_scale', 1)));
        targetWidth = img2imgInputResizeRound8(width * factor);
        targetHeight = img2imgInputResizeRound8(height * factor);
    } else if (mode === 'size') {
        // same fallback as plan_resize: an empty target follows the source
        var wantedWidth = img2imgInputResizeNumber(root, 'resize_input_width', 0) || width;
        var wantedHeight = img2imgInputResizeNumber(root, 'resize_input_height', 0) || height;
        targetWidth = img2imgInputResizeRound8(wantedWidth);
        targetHeight = img2imgInputResizeRound8(wantedHeight);
    } else {
        return null;
    }

    if (targetWidth === width && targetHeight === height) return null;

    return {width: targetWidth, height: targetHeight};
}

/** Refresh the Resize-by preview after a Resize Input control changed.
 *
 * Coalesced: dragging a slider fires change on every step, but the preview only needs one
 * refresh once the value settles. Typed values commit through change (no release), so both
 * events funnel here.
 */
var img2imgResizePreviewTimer = null;

function refreshImg2imgResizePreview() {
    if (img2imgResizePreviewTimer) clearTimeout(img2imgResizePreviewTimer);

    img2imgResizePreviewTimer = setTimeout(function() {
        img2imgResizePreviewTimer = null;
        var button = gradioApp().getElementById('img2img_update_resize_to');
        if (button) button.click();
    }, 200);

    return [];
}
