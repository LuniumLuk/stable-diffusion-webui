/**
 * endorsedGallery.js
 * Handles all client-side interactions for the Endorsed Gallery tab.
 *
 * Exposed on window.endorsedGallery:
 *   .action(actionDataB64)       – endorse or remove a card via hidden Gradio bus
 *   .copyParams(infotextB64)     – copy raw infotext to clipboard
 *   .sendTo(infotextB64, target) – paste params into txt2img or img2img
 *   .queueTxt2ImgHires(...)      – queue txt2img with the gallery hires preset
 */

(function () {
    'use strict';

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

    const DEFAULT_GALLERY_HIRES_PRESET = Object.freeze({
        upscaler: 'Latent',
        steps: 20,
        denoising: 0.85,
        scale: 1.5,
        resizeX: 0,
        resizeY: 0,
    });

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

    function clampNumber(value, fallback, min, max) {
        const n = Number(value);
        if (!Number.isFinite(n)) return fallback;
        return Math.min(max, Math.max(min, n));
    }

    function readGalleryHiresPreset() {
        const upscalerRaw = getComponentInputValue('endgal_hires_upscaler_preset');
        const stepsRaw = getComponentInputValue('endgal_hires_steps_preset');
        const denoiseRaw = getComponentInputValue('endgal_hires_denoise_preset');
        const scaleRaw = getComponentInputValue('endgal_hires_scale_preset');

        return {
            upscaler: upscalerRaw || DEFAULT_GALLERY_HIRES_PRESET.upscaler,
            steps: Math.round(clampNumber(stepsRaw, DEFAULT_GALLERY_HIRES_PRESET.steps, 0, 150)),
            denoising: clampNumber(denoiseRaw, DEFAULT_GALLERY_HIRES_PRESET.denoising, 0, 1),
            scale: clampNumber(scaleRaw, DEFAULT_GALLERY_HIRES_PRESET.scale, 1, 4),
            resizeX: 0,
            resizeY: 0,
        };
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

    function withGalleryHiresPreset(infotext, preset) {
        const use = preset || DEFAULT_GALLERY_HIRES_PRESET;
        let updated = String(infotext || '').trim();
        updated = upsertInfotextParam(updated, 'Denoising strength', String(use.denoising));
        updated = upsertInfotextParam(updated, 'Hires upscale', String(use.scale));
        updated = upsertInfotextParam(updated, 'Hires upscaler', use.upscaler);
        updated = upsertInfotextParam(updated, 'Hires steps', String(use.steps));
        updated = upsertInfotextParam(updated, 'Hires resize-1', String(use.resizeX));
        updated = upsertInfotextParam(updated, 'Hires resize-2', String(use.resizeY));
        return updated;
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
                queueCurrentPreviewHires();
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

    function queueCurrentPreviewHires() {
        const item = previewList[previewIndex] || null;
        if (!item || !item.infotextB64) return;

        window.endorsedGallery.queueTxt2ImgHires(item.infotextB64, { keepGalleryTab: true });
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

        queueTxt2ImgHires: function (infotextB64, options) {
            const opts = options || {};
            const preset = readGalleryHiresPreset();
            const infotext = withGalleryHiresPreset(b64Decode(infotextB64 || ''), preset);
            if (!setGradioTextbox('endorsed_gallery_infotext_apply', infotext)) {
                console.warn('[endorsedGallery] infotext_apply textbox not found');
                return;
            }

            clickGradioBtn('endorsed_gallery_apply_txt2img_btn', 0);

            // Paste binding auto-switches to txt2img; keep user on Gallery for this quick action.
            if (opts.keepGalleryTab !== false) {
                setTimeout(() => {
                    switchToTabByName('gallery');
                }, 20);
            }

            setTimeout(() => {
                const queueBtn = gradioApp().querySelector('#txt2img_queue_btn');
                if (!queueBtn) {
                    console.warn('[endorsedGallery] txt2img queue button not found');
                    return;
                }

                queueBtn.click();
            }, 450);
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
            bootstrapClearSearchTextbox();
            setTimeout(onTabSwitch, 1500);
        });
    } else {
        bootstrapClearSearchTextbox();
        setTimeout(onTabSwitch, 1500);
    }

})();
