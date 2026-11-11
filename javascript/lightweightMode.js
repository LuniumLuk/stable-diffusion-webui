// Lightweight mode: the server keeps every model unloaded, so generation buttons become a
// no-op with a hint instead of sending a request that would only be refused.
// Buttons are matched by id, so the extension tabs (Qwen / Krea 2 / Video) are covered too.

const lightweightGenerateIds = [
    'txt2img_generate',
    'txt2img_quick_generate',
    'img2img_generate',
    'img2img_quick_generate',
    'extras_generate',
    'qwen_generate_btn',
    'krea2_generate_btn',
    'video_generate_btn',
    'train_train_embedding',
    'train_train_hypernetwork',
];

const lightweightGenerateSelector = lightweightGenerateIds.map(id => '#' + id).join(',');

function lightweightModeEnabled() {
    return typeof opts !== 'undefined' && !!opts.lightweight_mode;
}

function lightweightModeMessage() {
    return 'Lightweight mode is on: models are unloaded and generation is disabled. '
        + 'Turn it off in Settings -> System -> Lightweight mode.';
}

let lightweightHintNode = null;
let lightweightHintTimer = null;

function showLightweightHint() {
    if (!lightweightHintNode) {
        lightweightHintNode = document.createElement('div');
        lightweightHintNode.id = 'lightweight_mode_hint';
        lightweightHintNode.setAttribute('role', 'status');
        document.body.appendChild(lightweightHintNode);
    }

    lightweightHintNode.textContent = lightweightModeMessage();
    lightweightHintNode.classList.add('show');

    clearTimeout(lightweightHintTimer);
    lightweightHintTimer = setTimeout(function() {
        if (lightweightHintNode) lightweightHintNode.classList.remove('show');
    }, 4000);
}

function applyLightweightMode() {
    document.documentElement.classList.toggle('lightweight-mode', lightweightModeEnabled());
}

onUiLoaded(applyLightweightMode);
onOptionsChanged(applyLightweightMode);

document.addEventListener('click', function(event) {
    if (!lightweightModeEnabled() || !event.target || !event.target.closest) return;

    const button = event.target.closest(lightweightGenerateSelector);
    if (!button) return;

    // capture phase: stop the event before Gradio's own click handler submits a job
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    showLightweightHint();
}, true);
