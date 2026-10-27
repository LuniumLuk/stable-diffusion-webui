/**
 * Inpaint pose masks
 * ==================
 * Adds a compact "Pose masks" section to the inpaint batch-mask panel
 * (javascript/inpaintBatchMask.js).  It runs a local pose network on the picture
 * currently loaded in the Inpaint tab, then creates one point-expanded mask per body
 * part (face, left/right hand, left/right foot) and hands them to the batch-mask layer
 * list, so Generate inpaints them as a chain.
 *
 * The heavy lifting is in modules/inpaint_pose.py; this file only talks to
 * /inpaint-pose/status and /inpaint-pose/detect, keeps the small settings row in sync
 * with localStorage, and draws the returned skeleton as a transparent overlay.
 */
(() => {
    "use strict";

    const ROOT_SEL = "#img2maskimg";
    const STATUS_URL = "/inpaint-pose/status";
    const DETECT_URL = "/inpaint-pose/detect";
    const DOWNLOAD_URL = "/inpaint-pose/download";
    const ORIGIN = "pose";

    const LS = {
        radius: "inppose.radius",
        radiusMode: "inppose.radiusMode",
        radiusPercent: "inppose.radiusPercent",
        maxPeople: "inppose.maxPeople",
        backend: "inppose.backend",
        extend: "inppose.extend",
        face: "inppose.face",
        hands: "inppose.hands",
        feet: "inppose.feet",
        skeleton: "inppose.skeleton",
    };

    const PARTS = ["face", "hands", "feet"];
    const BACKENDS = ["auto", "dwpose", "torchvision"];

    const state = {
        booted: false,
        busy: false,
        downloading: false,
        section: null,
        statusEl: null,
        buttonEl: null,
        radiusEl: null,
        radiusLabel: null,
        modeEls: [],
        backendEls: [],
        dwposeReady: false,
        peopleEl: null,
        peopleLabel: null,
        extendEl: null,
        extendLabel: null,
        statusFetched: false,
        statusRetry: null,
        skeletonUrl: "",
        drawnUrl: "",
        imageSrc: "",
        width: 40,
        radiusMode: "percent",
        radiusPercent: 5,
        maxPeople: 4,
        backend: "auto",
        extend: 0.5,
        parts: {face: true, hands: true, feet: true},
        showSkeleton: true,
    };

    function app() {
        return typeof gradioApp === "function" ? gradioApp() : document;
    }

    function getRoot() {
        return app().querySelector(ROOT_SEL);
    }

    function getParts() {
        const root = getRoot();
        if (!root) return null;
        const iface = root.querySelector('canvas[key="interface"]');
        const maskCanvas = root.querySelector('canvas[key="mask"]');
        const wrap = iface ? iface.closest(".wrap") : null;
        if (!iface || !maskCanvas || !wrap) return null;
        return {root, iface, maskCanvas, wrap, img: root.querySelector("img.absolute-img")};
    }

    function readBool(key, fallback) {
        const value = typeof localGet === "function" ? localGet(key, null) : null;
        if (value === null || value === undefined) return fallback;
        return value === "1" || value === "true";
    }

    function writeBool(key, value) {
        if (typeof localSet === "function") localSet(key, value ? "1" : "0");
    }

    function readInt(key, fallback) {
        const value = typeof localGet === "function" ? localGet(key, null) : null;
        const number = parseInt(value, 10);
        return Number.isFinite(number) ? number : fallback;
    }

    function readFloat(key, fallback) {
        const value = typeof localGet === "function" ? localGet(key, null) : null;
        const number = parseFloat(value);
        return Number.isFinite(number) ? number : fallback;
    }

    function readString(key, fallback) {
        const value = typeof localGet === "function" ? localGet(key, null) : null;
        return value === null || value === undefined ? fallback : String(value);
    }

    function clamp(value, min, max) {
        return Math.max(min, Math.min(max, value));
    }

    function normSrc(src) {
        if (!src) return "";
        let value = String(src).split("?")[0];
        try {
            value = decodeURIComponent(value);
        } catch (e) {
            // malformed escape: keep the raw value
        }
        return value;
    }

    async function srcToDataURL(src) {
        if (!src) throw new Error("no source image");
        if (src.startsWith("data:")) return src;
        const blob = await (await fetch(src)).blob();
        return await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = () => reject(new Error("failed to read the image"));
            reader.readAsDataURL(blob);
        });
    }

    /* ------------------------------------ panel ------------------------------------- */

    function setStatus(text, isError) {
        if (!state.statusEl) return;
        state.statusEl.textContent = text || "";
        state.statusEl.classList.toggle("inppose-error", !!isError);
    }

    function backendLabel(backend) {
        if (backend === "dwpose") return "DWPose";
        if (backend === "torchvision") return "COCO 17";
        return "local net";
    }

    function updateRadiusLabel() {
        if (!state.radiusLabel) return;
        state.radiusLabel.textContent = state.radiusMode === "percent"
            ? `${Number(state.radiusPercent).toFixed(1)}%`
            : `${state.width}px`;
    }

    function applyRadiusMode() {
        state.modeEls.forEach((button) => {
            button.classList.toggle("inppose-mode-on", button.dataset.mode === state.radiusMode);
        });
        if (state.radiusEl) {
            if (state.radiusMode === "percent") {
                state.radiusEl.min = "0.5";
                state.radiusEl.max = "25";
                state.radiusEl.step = "0.5";
                state.radiusEl.value = String(state.radiusPercent);
            } else {
                state.radiusEl.min = "8";
                state.radiusEl.max = "400";
                state.radiusEl.step = "2";
                state.radiusEl.value = String(state.width);
            }
        }
        updateRadiusLabel();
    }

    function updateExtendLabel() {
        if (state.extendLabel) state.extendLabel.textContent = Number(state.extend).toFixed(2);
    }

    function updatePeopleLabel() {
        if (state.peopleLabel) state.peopleLabel.textContent = String(state.maxPeople);
    }

    function applyBackend() {
        state.backendEls.forEach((button) => {
            const name = button.dataset.backend;
            button.classList.toggle("inppose-mode-on", name === state.backend);
            const missing = name === "dwpose" && !state.dwposeReady;
            button.disabled = missing;
            button.classList.toggle("inppose-mode-off", missing);
            button.title = missing
                ? "DWPose models are not installed - press Get DWPose below"
                : (button.dataset.tip || "");
        });
    }

    function updateSkeleton() {
        const p = getParts();
        if (!p) return;

        let overlay = p.wrap.querySelector("canvas.inppose-skeleton");
        if (!overlay) {
            overlay = document.createElement("canvas");
            overlay.className = "inppose-skeleton";
            p.wrap.appendChild(overlay);
            state.drawnUrl = "";
        }

        const maskStyle = getComputedStyle(p.maskCanvas);
        if (overlay.style.width !== maskStyle.width) overlay.style.width = maskStyle.width;
        if (overlay.style.height !== maskStyle.height) overlay.style.height = maskStyle.height;
        if (overlay.style.transform !== p.maskCanvas.style.transform) {
            overlay.style.transformOrigin = "0 0";
            overlay.style.transform = p.maskCanvas.style.transform;
        }

        const visible = state.showSkeleton && !!state.skeletonUrl;
        overlay.style.display = visible ? "block" : "none";

        if (!visible) {
            if (state.drawnUrl) {
                const ctx = overlay.getContext("2d");
                ctx.clearRect(0, 0, overlay.width, overlay.height);
                state.drawnUrl = "";
            }
            return;
        }

        if (state.drawnUrl === state.skeletonUrl) return;
        const url = state.skeletonUrl;
        const image = new Image();
        image.onload = () => {
            if (state.skeletonUrl !== url) return;
            if (overlay.width !== image.naturalWidth || overlay.height !== image.naturalHeight) {
                overlay.width = image.naturalWidth;
                overlay.height = image.naturalHeight;
            }
            const ctx = overlay.getContext("2d");
            ctx.clearRect(0, 0, overlay.width, overlay.height);
            ctx.drawImage(image, 0, 0);
            state.drawnUrl = url;
        };
        image.src = url;
    }

    function clearSkeleton() {
        state.skeletonUrl = "";
        updateSkeleton();
    }

    async function loadStatus() {
        if (state.statusFetched) return;
        state.statusFetched = true;
        clearTimeout(state.statusRetry);

        try {
            const response = await fetch(STATUS_URL);
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const data = await response.json();
            state.dwposeReady = !!data.dwpose_ready;
            const el = state.section ? state.section.querySelector(".inppose-backend") : null;
            if (el) {
                el.textContent = data.available ? backendLabel(data.backend) : "unavailable";
                el.title = data.message || "";
                el.classList.toggle("inppose-unavailable", !data.available);
            }
            const getRow = state.section ? state.section.querySelector(".inppose-getrow") : null;
            if (getRow) getRow.hidden = !!data.dwpose;
            applyBackend();
        } catch (error) {
            state.statusFetched = false;
            const el = state.section ? state.section.querySelector(".inppose-backend") : null;
            if (el) {
                el.textContent = "API off";
                el.title = "Restart the WebUI to load the pose API";
            }
            // the page may be open while the server is still starting: retry a few times
            state.statusRetry = setTimeout(loadStatus, 5000);
        }
    }

    function setBusy(busy) {
        state.busy = busy;
        if (!state.buttonEl) return;
        state.buttonEl.disabled = busy;
        state.buttonEl.textContent = busy ? "Analysing\u2026" : "Detect pose";
        state.buttonEl.classList.toggle("inppose-working", busy);
    }

    function selectedRegions() {
        return PARTS.filter((part) => state.parts[part]);
    }

    function bindSection(section) {
        state.section = section;
        state.statusEl = section.querySelector(".inppose-status");
        state.buttonEl = section.querySelector(".inppose-detect");
        state.radiusEl = section.querySelector(".inppose-radius input");
        state.radiusLabel = section.querySelector(".inppose-radius-val");
        state.modeEls = Array.from(section.querySelectorAll(".inppose-mode[data-mode]"));
        state.backendEls = Array.from(section.querySelectorAll(".inppose-provider"));
        state.peopleEl = section.querySelector(".inppose-people input");
        state.peopleLabel = section.querySelector(".inppose-people-val");
        state.extendEl = section.querySelector(".inppose-extend input");
        state.extendLabel = section.querySelector(".inppose-extend-val");
    }

    function buildSection() {
        const section = document.createElement("div");
        section.className = "inppose-section";
        section.innerHTML = `
      <div class="inppose-head">
        <span class="inppose-title">Pose masks</span>
        <span class="inppose-backend" title="Local pose network">checking\u2026</span>
      </div>
      <div class="inppose-row">
        <button type="button" class="inppose-btn inppose-detect" title="Find face/hand/foot points with the local pose network">Detect pose</button>
        <button type="button" class="inppose-btn inppose-clear" title="Remove the masks generated by Detect pose">Clear</button>
      </div>
      <div class="inppose-row inppose-providers">
        <span class="inppose-mode-title" title="Pose provider used by Detect pose">provider</span>
        <button type="button" class="inppose-mode inppose-provider" data-backend="auto" data-tip="Prefer DWPose when its models are installed, otherwise COCO 17">auto</button>
        <button type="button" class="inppose-mode inppose-provider" data-backend="dwpose" data-tip="DWPose ONNX: 68 face points, 21 per hand, 3 per foot">DWPose</button>
        <button type="button" class="inppose-mode inppose-provider" data-backend="torchvision" data-tip="torchvision Keypoint R-CNN (COCO 17); no extra models needed">COCO</button>
      </div>
      <div class="inppose-row inppose-parts">
        <label title="Cover the detected face points"><input type="checkbox" data-part="face" checked> face</label>
        <label title="Cover the detected hand points"><input type="checkbox" data-part="hands" checked> hands</label>
        <label title="Cover the detected foot points"><input type="checkbox" data-part="feet" checked> feet</label>
      </div>
      <div class="inppose-row inppose-modes">
        <span class="inppose-mode-title" title="Point size: a fixed pixel radius, or a percentage of each skeleton">size</span>
        <button type="button" class="inppose-mode" data-mode="px" title="Fixed radius in pixels">px</button>
        <button type="button" class="inppose-mode" data-mode="percent" title="Radius follows every skeleton: this percentage of its longest side">%</button>
      </div>
      <div class="inppose-row">
        <label class="inppose-radius" title="Radius of the circle drawn around every detected point">
          <input type="range" min="8" max="400" step="2" value="40">
          <span class="inppose-radius-val">40px</span>
        </label>
      </div>
      <div class="inppose-row">
        <label class="inppose-extend" title="Push hand and foot points further along the forearm/shin (multiples of that bone) so fingers and toes past the detected wrist/ankle are covered">ext
          <input type="range" min="0" max="2" step="0.05" value="0.5">
          <span class="inppose-extend-val">0.50</span>
        </label>
      </div>
      <div class="inppose-row">
        <label class="inppose-people" title="Use at most this many skeletons; the most confident and largest ones are kept and each gets its own masks">max skel
          <input type="range" min="1" max="16" step="1" value="4">
          <span class="inppose-people-val">4</span>
        </label>
      </div>
      <div class="inppose-row">
        <label title="Show the detected skeleton over the picture"><input type="checkbox" data-toggle="skeleton" checked> skeleton</label>
      </div>
      <div class="inppose-row inppose-getrow" hidden>
        <button type="button" class="inppose-btn inppose-get" title="Download the DWPose ONNX models into models/pose (about 330 MB)">Get DWPose</button>
        <span class="inppose-get-hint">sharper anime face/hand/foot points</span>
      </div>
      <div class="inppose-status"></div>`;

        bindSection(section);

        state.extend = clamp(readFloat(LS.extend, state.extend), 0, 2);
        state.extendEl.value = String(state.extend);
        updateExtendLabel();

        state.maxPeople = clamp(readInt(LS.maxPeople, state.maxPeople), 1, 16);
        state.peopleEl.value = String(state.maxPeople);
        updatePeopleLabel();

        PARTS.forEach((part) => {
            const input = section.querySelector(`[data-part="${part}"]`);
            input.checked = state.parts[part];
            input.addEventListener("change", () => {
                state.parts[part] = input.checked;
                writeBool(LS[part], input.checked);
            });
        });

        const skeletonInput = section.querySelector('[data-toggle="skeleton"]');
        skeletonInput.checked = state.showSkeleton;
        skeletonInput.addEventListener("change", () => {
            state.showSkeleton = skeletonInput.checked;
            writeBool(LS.skeleton, state.showSkeleton);
            updateSkeleton();
        });

        state.modeEls.forEach((button) => {
            button.addEventListener("click", () => {
                state.radiusMode = button.dataset.mode === "px" ? "px" : "percent";
                if (typeof localSet === "function") localSet(LS.radiusMode, state.radiusMode);
                applyRadiusMode();
            });
        });

        state.backendEls.forEach((button) => {
            button.addEventListener("click", () => {
                const name = button.dataset.backend;
                if (!BACKENDS.includes(name)) return;
                state.backend = name;
                if (typeof localSet === "function") localSet(LS.backend, state.backend);
                applyBackend();
            });
        });

        state.radiusEl.addEventListener("input", () => {
            if (state.radiusMode === "percent") {
                state.radiusPercent = clamp(parseFloat(state.radiusEl.value) || 5, 0.5, 25);
                if (typeof localSet === "function") localSet(LS.radiusPercent, String(state.radiusPercent));
            } else {
                state.width = clamp(parseInt(state.radiusEl.value, 10) || 40, 8, 400);
                if (typeof localSet === "function") localSet(LS.radius, String(state.width));
            }
            updateRadiusLabel();
        });

        state.extendEl.addEventListener("input", () => {
            state.extend = clamp(parseFloat(state.extendEl.value) || 0, 0, 2);
            updateExtendLabel();
            if (typeof localSet === "function") localSet(LS.extend, String(state.extend));
        });

        state.peopleEl.addEventListener("input", () => {
            state.maxPeople = clamp(parseInt(state.peopleEl.value, 10) || 4, 1, 16);
            updatePeopleLabel();
            if (typeof localSet === "function") localSet(LS.maxPeople, String(state.maxPeople));
        });

        state.buttonEl.addEventListener("click", () => detect());
        section.querySelector(".inppose-clear").addEventListener("click", () => clearPose());
        section.querySelector(".inppose-get").addEventListener("click", () => downloadModels());

        applyRadiusMode();
        applyBackend();
        return section;
    }

    /* ----------------------------------- detection ---------------------------------- */

    async function downloadModels() {
        if (state.downloading || state.busy) return;

        const button = state.section ? state.section.querySelector(".inppose-get") : null;
        state.downloading = true;
        if (button) {
            button.disabled = true;
            button.textContent = "Downloading\u2026";
        }
        if (state.buttonEl) state.buttonEl.disabled = true;
        setStatus("Downloading DWPose (~330 MB, one time)\u2026");

        try {
            const response = await fetch(DOWNLOAD_URL, {method: "POST"});
            const data = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(data.detail || data.msg || `HTTP ${response.status}`);
            state.statusFetched = false;
            await loadStatus();
            setStatus("DWPose ready \u00B7 press Detect pose again");
        } catch (error) {
            setStatus(error.message || "DWPose download failed", true);
        } finally {
            state.downloading = false;
            if (button) {
                button.disabled = false;
                button.textContent = "Get DWPose";
            }
            if (state.buttonEl) state.buttonEl.disabled = state.busy;
        }
    }

    async function detect() {
        if (state.busy) return;

        const p = getParts();
        if (!p || !p.img || !p.img.src) {
            setStatus("Load an image in the Inpaint tab first", true);
            return;
        }

        const regions = selectedRegions();
        if (!regions.length) {
            setStatus("Pick face, hands or feet", true);
            return;
        }

        if (!window.inpaintBatchMask || typeof window.inpaintBatchMask.addMasks !== "function") {
            setStatus("Batch mask panel is not ready", true);
            return;
        }

        setBusy(true);
        setStatus("Analysing pose\u2026");

        try {
            const image = await srcToDataURL(p.img.src);
            const response = await fetch(DETECT_URL, {
                method: "POST",
                headers: {"Content-Type": "application/json"},
                body: JSON.stringify({
                    input_image: image,
                    regions,
                    radius: state.width,
                    radius_mode: state.radiusMode,
                    radius_percent: state.radiusPercent,
                    extend: state.extend,
                    max_people: state.maxPeople,
                    backend: state.backend,
                    include_skeleton: true,
                }),
            });

            const data = await response.json().catch(() => ({}));
            if (!response.ok) {
                throw new Error(data.detail || data.msg || `HTTP ${response.status}`);
            }

            if (Array.isArray(data.warnings)) {
                data.warnings.forEach((warning) => console.warn("[inppose]", warning));
            }

            const masks = Array.isArray(data.masks) ? data.masks : [];
            const added = window.inpaintBatchMask.addMasks(
                masks.map((mask) => ({name: mask.name, dataUrl: mask.data})),
                {origin: ORIGIN}
            );

            if (data.skeleton) {
                state.skeletonUrl = data.skeleton;
                updateSkeleton();
            } else {
                clearSkeleton();
            }

            if (!added) {
                setStatus(data.msg || "No face, hand or foot points found", !data.people);
                return;
            }

            const people = Number(data.people) || 0;
            const total = Number(data.people_total) || people;
            const backend = backendLabel(data.backend);
            const peopleText = data.limited
                ? `${people}/${total} skeletons`
                : `${people} person${people === 1 ? "" : "s"}`;
            setStatus(`${added} mask${added === 1 ? "" : "s"} \u00B7 ${peopleText} \u00B7 r ${data.radius}px \u00B7 ${backend}`);
        } catch (error) {
            setStatus(error.message || "Pose analysis failed", true);
        } finally {
            setBusy(false);
        }
    }

    function clearPose() {
        if (!window.inpaintBatchMask || typeof window.inpaintBatchMask.clearOrigin !== "function") return;
        const removed = window.inpaintBatchMask.clearOrigin(ORIGIN);
        clearSkeleton();
        setStatus(removed ? `Removed ${removed} pose mask${removed === 1 ? "" : "s"}` : "No pose masks to remove");
    }

    /* ------------------------------------ boot -------------------------------------- */

    function watchImage() {
        const p = getParts();
        if (!p || !p.img) return;

        const src = normSrc(p.img.src);
        if (state.imageSrc && src && src !== state.imageSrc) {
            // masks belong to the previous picture; dropping them avoids inpainting the
            // new image with invisible points from the old one
            clearSkeleton();
            if (window.inpaintBatchMask && typeof window.inpaintBatchMask.clearOrigin === "function") {
                const removed = window.inpaintBatchMask.clearOrigin(ORIGIN);
                if (removed) setStatus("Image changed \u00B7 pose masks cleared");
            }
        }
        if (src) state.imageSrc = src;
        updateSkeleton();
    }

    function ensure() {
        const root = getRoot();
        if (!root) return;

        const panel = root.querySelector(".inpbatch-panel");
        if (!panel) return;

        let section = panel.querySelector(".inppose-section");
        if (!section) {
            section = buildSection();
            const body = panel.querySelector(".inpbatch-body");
            if (body) panel.insertBefore(section, body);
            else panel.appendChild(section);
            state.statusFetched = false;
            loadStatus();
        } else if (section !== state.section) {
            bindSection(section);
            applyRadiusMode();
            applyBackend();
        } else {
            // keep the pose controls above the (possibly long) mask list on live reloads
            const body = panel.querySelector(".inpbatch-body");
            if (body && section.nextElementSibling !== body) panel.insertBefore(section, body);
        }

        watchImage();
    }

    function boot() {
        if (state.booted) return;
        state.booted = true;

        state.width = clamp(readInt(LS.radius, 40), 8, 400);
        state.radiusMode = readString(LS.radiusMode, "percent") === "px" ? "px" : "percent";
        state.radiusPercent = clamp(readFloat(LS.radiusPercent, 5), 0.5, 25);
        state.maxPeople = clamp(readInt(LS.maxPeople, 4), 1, 16);
        const savedBackend = readString(LS.backend, "auto");
        state.backend = BACKENDS.includes(savedBackend) ? savedBackend : "auto";
        PARTS.forEach((part) => {
            state.parts[part] = readBool(LS[part], true);
        });
        state.showSkeleton = readBool(LS.skeleton, true);

        ensure();
        if (typeof onAfterUiUpdate === "function") onAfterUiUpdate(ensure);
        setInterval(ensure, 1000);
    }

    if (typeof onUiLoaded === "function") onUiLoaded(boot);
    else if (document.readyState === "complete") boot();
    else window.addEventListener("load", boot);
})();
