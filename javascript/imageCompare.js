/**
 * Image Comparison Tool
 * Provides dual-image selection and sliding comparison view
 */

(function() {
    'use strict';

    let selectedImages = [];
    let compareModal = null;
    
    /**
     * Launch the image comparison window with two selected images
     */
    window.launchImageCompare = function(galleryData, selectedIndex) {
        if (!galleryData || galleryData.length === 0) {
            gr.Info('No images in gallery');
            return;
        }

        // Create modal if it doesn't exist
        if (!compareModal) {
            compareModal = createCompareModal();
            document.body.appendChild(compareModal);
        }

        // If only one image selected, use current and previous
        if (!selectedImages || selectedImages.length === 0) {
            selectedImages = [];
            if (selectedIndex >= 1) {
                selectedImages.push(galleryData[selectedIndex - 1]);
                selectedImages.push(galleryData[selectedIndex]);
            } else if (selectedIndex === 0 && galleryData.length > 1) {
                selectedImages.push(galleryData[0]);
                selectedImages.push(galleryData[1]);
            } else {
                gr.Info('Need at least 2 images to compare');
                return;
            }
        }

        // Load images into the comparison view
        const img1 = compareModal.querySelector('#compare-img1');
        const img2 = compareModal.querySelector('#compare-img2');
        const label1 = compareModal.querySelector('#compare-label1');
        const label2 = compareModal.querySelector('#compare-label2');

        if (selectedImages.length >= 2) {
            // Load first image
            if (selectedImages[0].name) {
                img1.src = selectedImages[0].name;
                label1.textContent = 'Image 1: ' + extractFilename(selectedImages[0].name);
            }

            // Load second image
            if (selectedImages[1].name) {
                img2.src = selectedImages[1].name;
                label2.textContent = 'Image 2: ' + extractFilename(selectedImages[1].name);
            }

            // Show modal
            compareModal.style.display = 'flex';
            compareModal.classList.add('visible');
        }
    };

    /**
     * Create the comparison modal HTML structure
     */
    function createCompareModal() {
        const modal = document.createElement('div');
        modal.id = 'image-compare-modal';
        modal.className = 'image-compare-modal';
        
        modal.innerHTML = `
            <div class="compare-container">
                <div class="compare-header">
                    <h2>Image Comparison</h2>
                    <button class="compare-close" aria-label="Close">&times;</button>
                </div>
                <div class="compare-content">
                    <div class="compare-wrapper">
                        <div class="compare-image-container">
                            <img id="compare-img1" src="" alt="Image 1" class="compare-image compare-image-base">
                            <div class="compare-label" id="compare-label1">Image 1</div>
                        </div>
                        <div class="compare-image-container compare-overlay">
                            <img id="compare-img2" src="" alt="Image 2" class="compare-image compare-image-overlay">
                            <div class="compare-label compare-label-overlay" id="compare-label2">Image 2</div>
                        </div>
                        <input type="range" min="0" max="100" value="50" class="compare-slider" id="compare-slider" aria-label="Image comparison slider">
                    </div>
                </div>
                <div class="compare-footer">
                    <button class="compare-btn" id="compare-swap">Swap Images</button>
                    <button class="compare-btn" id="compare-select">Select Different Images</button>
                    <button class="compare-btn compare-btn-close">Close</button>
                </div>
            </div>
        `;

        // Add styles
        addCompareStyles();

        // Setup event listeners
        const closeBtn = modal.querySelector('.compare-close');
        const closeBtnFooter = modal.querySelector('.compare-btn-close');
        const slider = modal.querySelector('#compare-slider');
        const swapBtn = modal.querySelector('#compare-swap');
        const selectBtn = modal.querySelector('#compare-select');

        closeBtn.addEventListener('click', () => hideCompareModal(modal));
        closeBtnFooter.addEventListener('click', () => hideCompareModal(modal));
        
        modal.addEventListener('click', (e) => {
            if (e.target === modal) hideCompareModal(modal);
        });

        slider.addEventListener('input', (e) => {
            updateComparePosition(modal, e.target.value);
        });

        swapBtn.addEventListener('click', () => {
            const temp = selectedImages[0];
            selectedImages[0] = selectedImages[1];
            selectedImages[1] = temp;
            window.launchImageCompare(selectedImages, -1);
        });

        selectBtn.addEventListener('click', () => {
            hideCompareModal(modal);
            selectedImages = [];
            promptImageSelection();
        });

        // Update comparison on load
        const img1 = modal.querySelector('#compare-img1');
        img1.addEventListener('load', () => {
            updateComparePosition(modal, 50);
        });

        return modal;
    }

    /**
     * Update the overlay position based on slider value
     */
    function updateComparePosition(modal, value) {
        const overlay = modal.querySelector('.compare-overlay');
        overlay.style.clipPath = `inset(0 ${100 - value}% 0 0)`;
    }

    /**
     * Hide the comparison modal
     */
    function hideCompareModal(modal) {
        modal.classList.remove('visible');
        modal.style.display = 'none';
        selectedImages = [];
    }

    /**
     * Prompt user to select images for comparison
     */
    function promptImageSelection() {
        const message = 'Click on images in the gallery to select them for comparison. Select two images.';
        console.log('[ImageCompare]', message);
        gr.Info(message);
    }

    /**
     * Extract filename from path
     */
    function extractFilename(path) {
        if (!path) return 'Unknown';
        return path.split(/[\\/]/).pop().split('?')[0] || 'Image';
    }

    /**
     * Add CSS styles for the comparison modal
     */
    function addCompareStyles() {
        if (document.getElementById('image-compare-styles')) return;

        const style = document.createElement('style');
        style.id = 'image-compare-styles';
        style.textContent = `
            .image-compare-modal {
                display: none;
                position: fixed;
                top: 0;
                left: 0;
                width: 100%;
                height: 100%;
                background: rgba(0, 0, 0, 0.7);
                z-index: 10000;
                justify-content: center;
                align-items: center;
                opacity: 0;
                transition: opacity 0.3s ease;
            }

            .image-compare-modal.visible {
                opacity: 1;
            }

            .compare-container {
                background: white;
                border-radius: 8px;
                box-shadow: 0 10px 40px rgba(0, 0, 0, 0.3);
                display: flex;
                flex-direction: column;
                max-width: 90%;
                max-height: 90vh;
                width: 1200px;
                overflow: hidden;
            }

            .compare-header {
                display: flex;
                justify-content: space-between;
                align-items: center;
                padding: 16px 20px;
                border-bottom: 1px solid #e0e0e0;
                background: #f5f5f5;
            }

            .compare-header h2 {
                margin: 0;
                font-size: 18px;
                font-weight: 600;
            }

            .compare-close {
                background: none;
                border: none;
                font-size: 28px;
                cursor: pointer;
                color: #666;
                padding: 0;
                width: 32px;
                height: 32px;
                display: flex;
                align-items: center;
                justify-content: center;
                border-radius: 4px;
                transition: all 0.2s;
            }

            .compare-close:hover {
                background: #e0e0e0;
                color: #000;
            }

            .compare-content {
                flex: 1;
                overflow: auto;
                display: flex;
                justify-content: center;
                align-items: center;
                padding: 20px;
                background: #fafafa;
            }

            .compare-wrapper {
                position: relative;
                max-width: 100%;
                max-height: 100%;
                display: flex;
                justify-content: center;
                align-items: center;
            }

            .compare-image-container {
                position: relative;
                display: inline-block;
            }

            .compare-image {
                display: block;
                max-width: 100%;
                max-height: 60vh;
                width: auto;
                height: auto;
            }

            .compare-image-base {
                z-index: 1;
            }

            .compare-overlay {
                position: absolute;
                top: 0;
                left: 0;
                z-index: 2;
            }

            .compare-label {
                position: absolute;
                top: 10px;
                left: 10px;
                background: rgba(0, 0, 0, 0.7);
                color: white;
                padding: 6px 12px;
                border-radius: 4px;
                font-size: 12px;
                font-weight: 500;
                z-index: 3;
            }

            .compare-label-overlay {
                right: 10px;
                left: auto;
            }

            .compare-slider {
                position: absolute;
                top: 50%;
                left: 0;
                width: 100%;
                height: 100%;
                -webkit-appearance: none;
                appearance: none;
                background: transparent;
                cursor: col-resize;
                z-index: 4;
                margin: 0;
                padding: 0;
            }

            .compare-slider::-webkit-slider-thumb {
                -webkit-appearance: none;
                appearance: none;
                width: 50px;
                height: 100%;
                background: linear-gradient(to right, rgba(255,255,255,0.3), rgba(255,255,255,0.8), rgba(255,255,255,0.3));
                border: 2px solid white;
                cursor: col-resize;
                box-shadow: -4px 0 8px rgba(0, 0, 0, 0.3), 4px 0 8px rgba(0, 0, 0, 0.3);
            }

            .compare-slider::-moz-range-thumb {
                width: 50px;
                height: 100%;
                background: linear-gradient(to right, rgba(255,255,255,0.3), rgba(255,255,255,0.8), rgba(255,255,255,0.3));
                border: 2px solid white;
                cursor: col-resize;
                box-shadow: -4px 0 8px rgba(0, 0, 0, 0.3), 4px 0 8px rgba(0, 0, 0, 0.3);
                border-radius: 0;
            }

            .compare-footer {
                display: flex;
                gap: 10px;
                padding: 16px 20px;
                border-top: 1px solid #e0e0e0;
                background: #f5f5f5;
                justify-content: flex-end;
            }

            .compare-btn {
                padding: 8px 16px;
                border: 1px solid #d0d0d0;
                background: white;
                border-radius: 4px;
                cursor: pointer;
                font-size: 14px;
                font-weight: 500;
                transition: all 0.2s;
            }

            .compare-btn:hover {
                background: #f0f0f0;
                border-color: #999;
            }

            .compare-btn-close {
                background: #666;
                color: white;
                border-color: #666;
            }

            .compare-btn-close:hover {
                background: #555;
                border-color: #555;
            }

            @media (max-width: 768px) {
                .compare-container {
                    width: 95%;
                    max-height: 85vh;
                }

                .compare-content {
                    padding: 10px;
                }

                .compare-image {
                    max-height: 50vh;
                }

                .compare-footer {
                    flex-direction: column;
                }

                .compare-btn {
                    width: 100%;
                }
            }
        `;

        document.head.appendChild(style);
    }

    /**
     * Setup gallery image selection mode
     */
    window.setupGalleryCompareSelection = function(tabname) {
        const gallery = gradioApp().querySelector(`#${tabname}_gallery`);
        if (!gallery) return;

        selectedImages = [];
        let mode = 'selecting';
        
        // Intercept gallery clicks
        const galleryDiv = gallery.querySelector('.gradio-gallery');
        if (!galleryDiv) return;

        // Override gallery behavior temporarily
        galleryDiv.addEventListener('click', (e) => {
            const item = e.target.closest('[data-index]');
            if (item && mode === 'selecting') {
                const index = parseInt(item.dataset.index);
                // Get image from gallery data
                // This is a simplified approach - may need adjustment based on actual gallery structure
                const img = item.querySelector('img');
                if (img) {
                    selectedImages.push({ name: img.src });
                    if (selectedImages.length === 2) {
                        mode = 'done';
                        window.launchImageCompare(selectedImages, 0);
                    }
                }
            }
        }, true);
    };
})();
