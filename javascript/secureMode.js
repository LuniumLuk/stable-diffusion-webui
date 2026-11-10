// Global secure mode: mask every image surface (gallery thumbnails and previews, results,
// input images, inpaint canvases, the full page viewer) with a blank placeholder.
// The mask is a CSS class on <html>, so surfaces created later are covered as well.

const secureModeClass = 'secure-mode-hide-images';

function secureModeEnabled() {
    return typeof opts !== 'undefined' && !!opts.secure_mode_hide_images;
}

function applySecureMode() {
    document.documentElement.classList.toggle(secureModeClass, secureModeEnabled());
}

function secureModeBlocksEvent(event) {
    if (!secureModeEnabled() || !event.target || !event.target.closest) return false;

    return !!event.target.closest('img, canvas, video');
}

onUiLoaded(applySecureMode);
onOptionsChanged(applySecureMode);

document.addEventListener('contextmenu', function(event) {
    if (secureModeBlocksEvent(event)) event.preventDefault();
}, true);

document.addEventListener('dragstart', function(event) {
    if (secureModeBlocksEvent(event)) event.preventDefault();
}, true);
