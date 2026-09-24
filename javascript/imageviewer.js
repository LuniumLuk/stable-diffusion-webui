// A full size 'lightbox' preview modal shown when left clicking on gallery previews

// ── Zoom & pan state ──────────────────────────────────────────────
let _modalZoom  = 1;
let _modalPanX  = 0;
let _modalPanY  = 0;
let _modalDragging     = false;
let _modalDragStartX   = 0;
let _modalDragStartY   = 0;
let _modalDragOriginX  = 0;
let _modalDragOriginY  = 0;
let _modalDragMoved    = false;  // true if cursor moved >3px during drag
let _modalImageNaturalW = 0;
let _modalImageNaturalH = 0;
let _modalCompareActive = false; // true while the modal shows the img2img input image
let _modalResultSrc = null;      // the generated (result) image currently opened
let _modalInputSrc = null;       // img2img input image src used for compare

function _modalApplyTransform() {
    const img = gradioApp().getElementById('modalImage');
    if (!img) return;
    img.style.transform = `translate(${_modalPanX}px, ${_modalPanY}px) scale(${_modalZoom})`;
    // Update cursor: grab when zoomed in, default otherwise
    img.style.cursor = (_modalZoom > 1.005) ? 'grab' : 'default';
}

function _modalResetTransform() {
    _modalZoom = 1;
    _modalPanX = 0;
    _modalPanY = 0;
    _modalApplyTransform();
}

function _modalFitToViewport(img) {
    // CSS max-width/max-height already constrains the image to the viewport,
    // so zoom=1 / pan=0 is the correct initial fit.
    _modalZoom = 1;
    _modalPanX = 0;
    _modalPanY = 0;
    if (img) {
        _modalImageNaturalW = img.naturalWidth || 0;
        _modalImageNaturalH = img.naturalHeight || 0;
    }
    _modalApplyTransform();
}

function _updateModalCompareButton() {
    const btn = gradioApp().getElementById('modalCompare');
    if (!btn) return;
    btn.classList.toggle('active', _modalCompareActive);
    btn.title = _modalCompareActive ? 'Show result image (C)' : 'Compare with input image (C)';
}

function _findImg2imgInputImage() {
    const mode = gradioApp().getElementById('mode_img2img');
    if (!mode) return null;

    // Look for the image inside the currently visible img2img sub-tab.
    const panels = Array.from(mode.children || []);
    for (const panel of panels) {
        if (panel.style.display === 'block') {
            const img = panel.querySelector('img');
            if (img && img.src) return img;
        }
    }

    const any = mode.querySelector('img');
    return any && any.src ? any : null;
}

function _prepareModalCompare() {
    const compareBtn = gradioApp().getElementById('modalCompare');
    const tabImg2Img = gradioApp().getElementById('tab_img2img');
    _modalCompareActive = false;
    _modalInputSrc = null;

    if (!compareBtn) return;

    const onImg2img = tabImg2Img && tabImg2Img.style.display !== 'none';
    if (!onImg2img) {
        compareBtn.style.display = 'none';
        _updateModalCompareButton();
        return;
    }

    const inputImg = _findImg2imgInputImage();
    if (!inputImg) {
        compareBtn.style.display = 'none';
        _updateModalCompareButton();
        return;
    }

    _modalInputSrc = inputImg.src;
    compareBtn.style.display = 'inline';
    _updateModalCompareButton();
}

function closeModal() {
    gradioApp().getElementById("lightboxModal").style.display = "none";
    _modalDragging = false;
}

function showModal(event) {
    const source = event.target || event.srcElement;
    const modalImage = gradioApp().getElementById("modalImage");
    const modalToggleLivePreviewBtn = gradioApp().getElementById("modal_toggle_live_preview");
    modalToggleLivePreviewBtn.innerHTML = opts.js_live_preview_in_modal_lightbox ? "&#x1F5C7;" : "&#x1F5C6;";
    const lb = gradioApp().getElementById("lightboxModal");
    modalImage.src = source.src;
    _modalResultSrc = source.src;
    _prepareModalCompare();
    if (modalImage.style.display === 'none') {
        lb.style.setProperty('background-image', 'url(' + source.src + ')');
    }

    // Reset transform and fit image to viewport (handles async load internally)
    _modalResetTransform();
    _modalFitToViewport(modalImage);

    lb.style.display = "flex";
    lb.focus();

    const tabTxt2Img = gradioApp().getElementById("tab_txt2img");
    const tabImg2Img = gradioApp().getElementById("tab_img2img");
    // show the save button in modal only on txt2img or img2img tabs
    if (tabTxt2Img.style.display != "none" || tabImg2Img.style.display != "none") {
        gradioApp().getElementById("modal_save").style.display = "inline";
    } else {
        gradioApp().getElementById("modal_save").style.display = "none";
    }
    event.stopPropagation();
}

function negmod(n, m) {
    return ((n % m) + m) % m;
}

function updateOnBackgroundChange() {
    const modalImage = gradioApp().getElementById("modalImage");
    if (modalImage && modalImage.offsetParent) {
        if (_modalCompareActive) {
            _modalCompareActive = false;
            _updateModalCompareButton();
        }
        let currentButton = selected_gallery_button();
        let preview = gradioApp().querySelectorAll('.livePreview > img');
        if (opts.js_live_preview_in_modal_lightbox && preview.length > 0) {
            // show preview image if available
            modalImage.src = preview[preview.length - 1].src;
            _modalResultSrc = modalImage.src;
            _modalFitToViewport(modalImage);
        } else if (currentButton?.children?.length > 0 && modalImage.src != currentButton.children[0].src) {
            modalImage.src = currentButton.children[0].src;
            _modalResultSrc = modalImage.src;
            _modalFitToViewport(modalImage);
            if (modalImage.style.display === 'none') {
                const modal = gradioApp().getElementById("lightboxModal");
                modal.style.setProperty('background-image', `url(${modalImage.src})`);
            }
        }
    }
}

function modalImageSwitch(offset) {
    var galleryButtons = all_gallery_buttons();

    if (galleryButtons.length > 1) {
        var result = selected_gallery_index();

        if (result != -1) {
            var nextButton = galleryButtons[negmod((result + offset), galleryButtons.length)];
            nextButton.click();
            const modalImage = gradioApp().getElementById("modalImage");
            const modal = gradioApp().getElementById("lightboxModal");
            modalImage.src = nextButton.children[0].src;
            _modalResultSrc = modalImage.src;
            _prepareModalCompare();
            _modalFitToViewport(modalImage);
            if (modalImage.style.display === 'none') {
                modal.style.setProperty('background-image', `url(${modalImage.src})`);
            }
            setTimeout(function() {
                modal.focus();
            }, 10);
        }
    }
}

function saveImage() {
    const tabTxt2Img = gradioApp().getElementById("tab_txt2img");
    const tabImg2Img = gradioApp().getElementById("tab_img2img");
    const saveTxt2Img = "save_txt2img";
    const saveImg2Img = "save_img2img";
    if (tabTxt2Img.style.display != "none") {
        gradioApp().getElementById(saveTxt2Img).click();
    } else if (tabImg2Img.style.display != "none") {
        gradioApp().getElementById(saveImg2Img).click();
    } else {
        console.error("missing implementation for saving modal of this type");
    }
}

function modalSaveImage(event) {
    saveImage();
    event.stopPropagation();
}

function modalNextImage(event) {
    modalImageSwitch(1);
    event.stopPropagation();
}

function modalPrevImage(event) {
    modalImageSwitch(-1);
    event.stopPropagation();
}

function modalKeyHandler(event) {
    switch (event.key) {
    case "s":
        saveImage();
        break;
    case "ArrowLeft":
        modalPrevImage(event);
        break;
    case "ArrowRight":
        modalNextImage(event);
        break;
    case "c":
    case "C":
        modalCompareToggle(event);
        break;
    case "Escape":
        closeModal();
        break;
    }
}

function setupImageForLightbox(e) {
    if (e.dataset.modded) {
        return;
    }

    e.dataset.modded = true;
    e.style.cursor = 'pointer';
    e.style.userSelect = 'none';

    e.addEventListener('mousedown', function(evt) {
        if (evt.button == 1) {
            open(evt.target.src);
            evt.preventDefault();
            return;
        }
    }, true);

    e.addEventListener('click', function(evt) {
        if (!opts.js_modal_lightbox || evt.button != 0) return;

        evt.preventDefault();
        showModal(evt);
    }, true);

}

function modalZoomSet(modalImage, enable) {
    // Toggle between 100% actual size and fit-to-viewport.
    if (!modalImage) return;
    if (enable) {
        _modalFitToViewport(modalImage);
    } else {
        _modalZoom = 1;
        _modalPanX = 0;
        _modalPanY = 0;
    }
    _modalApplyTransform();
}

function modalZoomToggle(event) {
    var modalImage = gradioApp().getElementById("modalImage");
    if (!modalImage) { event.stopPropagation(); return; }
    // Toggle between fit-to-viewport and 1:1 actual pixel size.
    // zoom=1 = CSS-fitted; to show 1:1 we need zoom = natural / rendered.
    if (Math.abs(_modalZoom - 1) < 0.005 && Math.abs(_modalPanX) < 1 && Math.abs(_modalPanY) < 1) {
        // Currently fitted — zoom to 1:1 actual size
        var rect = modalImage.getBoundingClientRect();
        var nw = modalImage.naturalWidth || _modalImageNaturalW;
        var nh = modalImage.naturalHeight || _modalImageNaturalH;
        if (nw && nh && rect.width > 0 && rect.height > 0) {
            _modalZoom = Math.max(nw / rect.width, nh / rect.height);
            _modalPanX = 0;
            _modalPanY = 0;
        } else {
            _modalZoom = 2; // fallback if dimensions unavailable
        }
    } else {
        // Currently zoomed — reset to fit
        _modalZoom = 1;
        _modalPanX = 0;
        _modalPanY = 0;
    }
    _modalApplyTransform();
    event.stopPropagation();
}

function modalLivePreviewToggle(event) {
    const modalToggleLivePreview = gradioApp().getElementById("modal_toggle_live_preview");
    opts.js_live_preview_in_modal_lightbox = !opts.js_live_preview_in_modal_lightbox;
    modalToggleLivePreview.innerHTML = opts.js_live_preview_in_modal_lightbox ? "&#x1F5C7;" : "&#x1F5C6;";
    event.stopPropagation();
}

function modalTileImageToggle(event) {
    const modalImage = gradioApp().getElementById("modalImage");
    const modal = gradioApp().getElementById("lightboxModal");
    const isTiling = modalImage.style.display === 'none';
    if (isTiling) {
        modalImage.style.display = 'block';
        modal.style.setProperty('background-image', 'none');
    } else {
        modalImage.style.display = 'none';
        modal.style.setProperty('background-image', `url(${modalImage.src})`);
    }

    event.stopPropagation();
}

function modalCompareToggle(event) {
    if (event) event.stopPropagation();

    const modalImage = gradioApp().getElementById("modalImage");
    if (!modalImage) return;

    // Toggle back to the result image.
    if (_modalCompareActive) {
        _modalCompareActive = false;
        modalImage.style.display = 'block';
        modalImage.src = _modalResultSrc;
        _modalApplyTransform();
        _updateModalCompareButton();
        return;
    }

    if (!_modalInputSrc) return;

    const targetW = modalImage.naturalWidth || _modalImageNaturalW;
    const targetH = modalImage.naturalHeight || _modalImageNaturalH;

    _modalCompareActive = true;
    _updateModalCompareButton();

    const showInput = function(src) {
        const current = gradioApp().getElementById("modalImage");
        if (!current || !_modalCompareActive) return;
        current.style.display = 'block';
        current.src = src;
        // Keep the current zoom/pan so the comparison is aligned instead of
        // resetting to the default fit on every toggle.
        _modalApplyTransform();
    };

    if (!targetW || !targetH) {
        showInput(_modalInputSrc);
        return;
    }

    // Resize the input image to the result resolution when they don't match.
    const probe = new Image();
    probe.onload = function() {
        if (probe.naturalWidth === targetW && probe.naturalHeight === targetH) {
            showInput(_modalInputSrc);
            return;
        }
        try {
            const canvas = document.createElement('canvas');
            canvas.width = targetW;
            canvas.height = targetH;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(probe, 0, 0, targetW, targetH);
            showInput(canvas.toDataURL('image/png'));
        } catch (err) {
            showInput(_modalInputSrc);
        }
    };
    probe.onerror = function() {
        showInput(_modalInputSrc);
    };
    probe.src = _modalInputSrc;
}

onAfterUiUpdate(function() {
    var fullImg_preview = gradioApp().querySelectorAll('.gradio-gallery > div > img');
    if (fullImg_preview != null) {
        fullImg_preview.forEach(setupImageForLightbox);
    }
    updateOnBackgroundChange();
});

document.addEventListener("DOMContentLoaded", function() {
    //const modalFragment = document.createDocumentFragment();
    const modal = document.createElement('div');
    modal.onclick = closeModal;
    modal.id = "lightboxModal";
    modal.tabIndex = 0;
    modal.addEventListener('keydown', modalKeyHandler, true);

    const modalControls = document.createElement('div');
    modalControls.className = 'modalControls gradio-container';
    modal.append(modalControls);

    const modalZoom = document.createElement('span');
    modalZoom.className = 'modalZoom cursor';
    modalZoom.innerHTML = '&#10529;';
    modalZoom.addEventListener('click', modalZoomToggle, true);
    modalZoom.title = "Toggle zoomed view";
    modalControls.appendChild(modalZoom);

    const modalTileImage = document.createElement('span');
    modalTileImage.className = 'modalTileImage cursor';
    modalTileImage.innerHTML = '&#8862;';
    modalTileImage.addEventListener('click', modalTileImageToggle, true);
    modalTileImage.title = "Preview tiling";
    modalControls.appendChild(modalTileImage);

    const modalCompare = document.createElement('span');
    modalCompare.className = 'modalCompare cursor';
    modalCompare.id = 'modalCompare';
    modalCompare.innerHTML = '&#8646;';
    modalCompare.addEventListener('click', modalCompareToggle, true);
    modalCompare.title = 'Compare with input image (C)';
    modalCompare.style.display = 'none';
    modalControls.appendChild(modalCompare);

    const modalSave = document.createElement("span");
    modalSave.className = "modalSave cursor";
    modalSave.id = "modal_save";
    modalSave.innerHTML = "&#x1F5AB;";
    modalSave.addEventListener("click", modalSaveImage, true);
    modalSave.title = "Save Image(s)";
    modalControls.appendChild(modalSave);

    const modalToggleLivePreview = document.createElement('span');
    modalToggleLivePreview.className = 'modalToggleLivePreview cursor';
    modalToggleLivePreview.id = "modal_toggle_live_preview";
    modalToggleLivePreview.innerHTML = "&#x1F5C6;";
    modalToggleLivePreview.onclick = modalLivePreviewToggle;
    modalToggleLivePreview.title = "Toggle live preview";
    modalControls.appendChild(modalToggleLivePreview);

    const modalClose = document.createElement('span');
    modalClose.className = 'modalClose cursor';
    modalClose.innerHTML = '&times;';
    modalClose.onclick = closeModal;
    modalClose.title = "Close image viewer";
    modalControls.appendChild(modalClose);

    const modalImage = document.createElement('img');
    modalImage.id = 'modalImage';
    modalImage.tabIndex = 0;
    modalImage.draggable = false;
    modalImage.style.transformOrigin = 'center center';
    modalImage.style.transition = 'none';
    modalImage.addEventListener('keydown', modalKeyHandler, true);

    // Track the natural size of whatever image is currently shown so the
    // 1:1 zoom toggle works after compare switches without refitting.
    modalImage.addEventListener('load', function() {
        _modalImageNaturalW = modalImage.naturalWidth || _modalImageNaturalW;
        _modalImageNaturalH = modalImage.naturalHeight || _modalImageNaturalH;
        _modalApplyTransform();
    });

    // ── Wheel zoom (cursor-anchored) ──────────────────────────
    modalImage.addEventListener('wheel', function(e) {
        e.preventDefault();
        e.stopPropagation();
        const rect = modalImage.getBoundingClientRect();
        const cx = e.clientX - (rect.left + rect.width / 2);
        const cy = e.clientY - (rect.top + rect.height / 2);
        const oldScale = _modalZoom;
        const factor = e.deltaY < 0 ? 1.12 : 0.89;
        _modalZoom = Math.min(8, Math.max(0.15, _modalZoom * factor));
        const ratio = _modalZoom / oldScale;
        _modalPanX = _modalPanX * ratio - cx * (ratio - 1);
        _modalPanY = _modalPanY * ratio - cy * (ratio - 1);
        _modalApplyTransform();
    }, { passive: false });

    // ── Drag to pan ───────────────────────────────────────────
    modalImage.addEventListener('mousedown', function(e) {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        _modalDragging = true;
        _modalDragMoved = false;
        _modalDragStartX = e.clientX;
        _modalDragStartY = e.clientY;
        _modalDragOriginX = _modalPanX;
        _modalDragOriginY = _modalPanY;
        modalImage.style.cursor = 'grabbing';
        modalImage.style.transition = 'none';
    });

    document.addEventListener('mousemove', function(e) {
        if (!_modalDragging) return;
        var dx = e.clientX - _modalDragStartX;
        var dy = e.clientY - _modalDragStartY;
        if (!_modalDragMoved && (Math.abs(dx) > 3 || Math.abs(dy) > 3)) {
            _modalDragMoved = true;
        }
        _modalPanX = _modalDragOriginX + dx;
        _modalPanY = _modalDragOriginY + dy;
        _modalApplyTransform();
    });

    document.addEventListener('mouseup', function() {
        if (!_modalDragging) return;
        _modalDragging = false;
        var img = gradioApp().getElementById('modalImage');
        if (img) img.style.cursor = (_modalZoom > 1.005) ? 'grab' : 'default';
    });

    // ── Double-click to reset ─────────────────────────────────
    modalImage.addEventListener('dblclick', function(e) {
        e.preventDefault();
        e.stopPropagation();
        _modalFitToViewport(modalImage);
    });

    // ── Click on image: prevent bubbling to backdrop (backdrop click closes) ──
    modalImage.addEventListener('click', function(e) {
        e.stopPropagation();
        // Do NOT close — only backdrop clicks close the modal.
    });

    modal.appendChild(modalImage);

    const modalPrev = document.createElement('a');
    modalPrev.className = 'modalPrev';
    modalPrev.innerHTML = '&#10094;';
    modalPrev.tabIndex = 0;
    modalPrev.addEventListener('click', modalPrevImage, true);
    modalPrev.addEventListener('keydown', modalKeyHandler, true);
    modal.appendChild(modalPrev);

    const modalNext = document.createElement('a');
    modalNext.className = 'modalNext';
    modalNext.innerHTML = '&#10095;';
    modalNext.tabIndex = 0;
    modalNext.addEventListener('click', modalNextImage, true);
    modalNext.addEventListener('keydown', modalKeyHandler, true);

    modal.appendChild(modalNext);

    try {
        gradioApp().appendChild(modal);
    } catch (e) {
        gradioApp().body.appendChild(modal);
    }

    document.body.appendChild(modal);

});
