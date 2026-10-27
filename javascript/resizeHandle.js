(function() {
    const GRADIO_MIN_WIDTH = 320;
    const PAD = 16;
    const DEBOUNCE_TIME = 100;
    const DOUBLE_TAP_DELAY = 200; //ms

    const R = {
        tracking: false,
        pointer: null,
        parent: null,
        parentWidth: null,
        leftCol: null,
        leftColStartWidth: null,
        screenX: null,
        lastTapTime: null,
    };

    let resizeTimer;
    let parents = [];

    /**
     * Ends the drag.  `body.resizing` turns off pointer events for the whole UI
     * (`body.resizing * { pointer-events: none }`), so a drag that never sees its
     * mouseup - released over another monitor or window, swallowed by an iframe or a
     * native menu - used to leave every real click dead: the Generate button stopped
     * reacting while Ctrl+Enter kept working, because a programmatic `.click()` does
     * not hit-test.  Ending the drag is idempotent and is also driven from events
     * that cannot be missed (blur, hidden tab, pointercancel).
     */
    function stopTracking() {
        if (!R.tracking) return;

        R.tracking = false;
        document.body.classList.remove('resizing');
    }

    function setLeftColGridTemplate(el, width) {
        el.style.gridTemplateColumns = `${width}px 16px 1fr`;
    }

    function displayResizeHandle(parent) {
        if (!parent.needHideOnMoblie) {
            return true;
        }
        if (window.innerWidth < GRADIO_MIN_WIDTH * 2 + PAD * 4) {
            parent.style.display = 'flex';
            parent.resizeHandle.style.display = "none";
            return false;
        } else {
            parent.style.display = 'grid';
            parent.resizeHandle.style.display = "block";
            return true;
        }
    }

    function afterResize(parent) {
        if (displayResizeHandle(parent) && parent.style.gridTemplateColumns != parent.style.originalGridTemplateColumns) {
            const oldParentWidth = R.parentWidth;
            const newParentWidth = parent.offsetWidth;
            const widthL = parseInt(parent.style.gridTemplateColumns.split(' ')[0]);

            const ratio = newParentWidth / oldParentWidth;

            const newWidthL = Math.max(Math.floor(ratio * widthL), parent.minLeftColWidth);
            setLeftColGridTemplate(parent, newWidthL);

            R.parentWidth = newParentWidth;
        }
    }

    function setup(parent) {

        function onDoubleClick(evt) {
            evt.preventDefault();
            evt.stopPropagation();

            parent.style.gridTemplateColumns = parent.style.originalGridTemplateColumns;
        }

        const leftCol = parent.firstElementChild;
        const rightCol = parent.lastElementChild;

        parents.push(parent);

        parent.style.display = 'grid';
        parent.style.gap = '0';
        let leftColTemplate = "";
        if (parent.children[0].style.flexGrow) {
            leftColTemplate = `${parent.children[0].style.flexGrow}fr`;
            parent.minLeftColWidth = GRADIO_MIN_WIDTH;
            parent.minRightColWidth = GRADIO_MIN_WIDTH;
            parent.needHideOnMoblie = true;
        } else {
            leftColTemplate = parent.children[0].style.flexBasis;
            parent.minLeftColWidth = parent.children[0].style.flexBasis.slice(0, -2) / 2;
            parent.minRightColWidth = 0;
            parent.needHideOnMoblie = false;
        }

        if (!leftColTemplate) {
            leftColTemplate = '1fr';
        }

        const gridTemplateColumns = `${leftColTemplate} ${PAD}px ${parent.children[1].style.flexGrow}fr`;
        parent.style.gridTemplateColumns = gridTemplateColumns;
        parent.style.originalGridTemplateColumns = gridTemplateColumns;

        const resizeHandle = document.createElement('div');
        resizeHandle.classList.add('resize-handle');
        parent.insertBefore(resizeHandle, rightCol);
        parent.resizeHandle = resizeHandle;

        ['mousedown', 'touchstart'].forEach((eventType) => {
            resizeHandle.addEventListener(eventType, (evt) => {
                if (eventType.startsWith('mouse')) {
                    if (evt.button !== 0) return;
                } else {
                    if (evt.changedTouches.length !== 1) return;

                    const currentTime = new Date().getTime();
                    if (R.lastTapTime && currentTime - R.lastTapTime <= DOUBLE_TAP_DELAY) {
                        onDoubleClick(evt);
                        return;
                    }

                    R.lastTapTime = currentTime;
                }

                evt.preventDefault();
                evt.stopPropagation();

                document.body.classList.add('resizing');

                R.tracking = true;
                R.pointer = eventType.startsWith('mouse') ? 'mouse' : 'touch';
                R.parent = parent;
                R.parentWidth = parent.offsetWidth;
                R.leftCol = leftCol;
                R.leftColStartWidth = leftCol.offsetWidth;
                if (eventType.startsWith('mouse')) {
                    R.screenX = evt.screenX;
                } else {
                    R.screenX = evt.changedTouches[0].screenX;
                }
            });
        });

        resizeHandle.addEventListener('dblclick', onDoubleClick);

        afterResize(parent);
    }

    ['mousemove', 'touchmove'].forEach((eventType) => {
        window.addEventListener(eventType, (evt) => {
            if (!R.tracking) return;

            const isMouseMove = eventType.startsWith('mouse');

            // no button / finger held any more: the release happened where we cannot see it
            // (released over another monitor or window, swallowed by a native menu, ...)
            const released = R.pointer === 'mouse'
                ? (!isMouseMove || evt.buttons === 0)
                : (isMouseMove || evt.touches.length === 0);
            if (released) {
                stopTracking();
                return;
            }

            if (isMouseMove ? evt.button !== 0 : evt.changedTouches.length !== 1) return;

            if (isMouseMove) {
                evt.preventDefault();
            }
            evt.stopPropagation();

            let delta = 0;
            if (isMouseMove) {
                delta = R.screenX - evt.screenX;
            } else {
                delta = R.screenX - evt.changedTouches[0].screenX;
            }
            const leftColWidth = Math.max(Math.min(R.leftColStartWidth - delta, R.parent.offsetWidth - R.parent.minRightColWidth - PAD), R.parent.minLeftColWidth);
            setLeftColGridTemplate(R.parent, leftColWidth);
        });
    });

    ['mouseup', 'touchend', 'touchcancel', 'pointercancel'].forEach((eventType) => {
        window.addEventListener(eventType, (evt) => {
            if (!R.tracking) return;

            // no button/touch filter: any release has to end the drag, or `resizing`
            // stays on the body and the next clicks go nowhere
            if (eventType.startsWith('mouse')) {
                if (evt.preventDefault) evt.preventDefault();
                if (evt.stopPropagation) evt.stopPropagation();
            }

            stopTracking();
        });
    });

    // a drag cannot survive the window losing focus (alt+tab, devtools, native menu)
    window.addEventListener('blur', stopTracking);
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState !== 'visible') stopTracking();
    });


    window.addEventListener('resize', () => {
        clearTimeout(resizeTimer);

        resizeTimer = setTimeout(function() {
            for (const parent of parents) {
                afterResize(parent);
            }
        }, DEBOUNCE_TIME);
    });

    setupResizeHandle = setup;
})();


function setupAllResizeHandles() {
    for (var elem of gradioApp().querySelectorAll('.resize-handle-row')) {
        if (!elem.querySelector('.resize-handle') && !elem.children[0].classList.contains("hidden")) {
            setupResizeHandle(elem);
        }
    }
}


onUiLoaded(setupAllResizeHandles);

