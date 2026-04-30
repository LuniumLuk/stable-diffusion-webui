/**
 * gen_tools.js
 * Handles the Gen Tools tab:
 *   - Renders the generation history grid from JSON state
 *   - Selecting a history card populates the hidden infotext textarea so the
 *     "Apply → txt2img / img2img" buttons (wired server-side via ParamBinding)
 *     can pick up the infotext and fill all paste fields.
 *   - Auto-refreshes when the Gen Tools tab is first opened.
 */
(function () {
    "use strict";

    // -----------------------------------------------------------------------
    // Helpers
    // -----------------------------------------------------------------------

    /**
     * Set a Gradio textbox value from JavaScript by bypassing React's
     * synthetic event system (standard trick in SD-WebUI extensions).
     */
    function setGradioTextbox(elemId, value) {
        const el = document.getElementById(elemId);
        if (!el) return false;
        const textarea = el.tagName === "TEXTAREA" ? el : el.querySelector("textarea");
        if (!textarea) return false;
        const nativeSetter = Object.getOwnPropertyDescriptor(
            HTMLTextAreaElement.prototype, "value"
        ).set;
        nativeSetter.call(textarea, value);
        textarea.dispatchEvent(new Event("input",  { bubbles: true }));
        textarea.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
    }

    function getTextboxValue(elemId) {
        const el = document.getElementById(elemId);
        if (!el) return "";
        const textarea = el.tagName === "TEXTAREA" ? el : el.querySelector("textarea");
        return textarea ? textarea.value : "";
    }

    // -----------------------------------------------------------------------
    // History grid
    // -----------------------------------------------------------------------

    let historyEntries = [];
    let selectedIndex  = -1;

    function renderHistoryGrid(entries) {
        historyEntries = entries || [];
        selectedIndex  = -1;

        const grid = document.getElementById("gen_tools_history_grid");
        if (!grid) return;

        grid.innerHTML = "";

        if (historyEntries.length === 0) {
            grid.innerHTML =
                '<div style="color:#64748b;font-size:13px;padding:16px;">' +
                "No history yet. Images will appear here after generation." +
                "</div>";
            return;
        }

        historyEntries.forEach(function (entry, idx) {
            const card = document.createElement("div");
            card.className = "gentools-card";
            card.dataset.index = String(idx);

            if (entry.thumb) {
                const img = document.createElement("img");
                img.src = entry.thumb;
                img.alt = "thumb";
                img.loading = "lazy";
                card.appendChild(img);
            } else {
                const placeholder = document.createElement("div");
                placeholder.className = "gt-no-thumb";
                placeholder.textContent = "No preview";
                card.appendChild(placeholder);
            }

            const meta = document.createElement("div");
            meta.className = "gt-meta";
            meta.textContent = entry.ts || "";
            card.appendChild(meta);

            if (entry.prompt_preview) {
                const prompt = document.createElement("div");
                prompt.className = "gt-prompt";
                prompt.textContent = entry.prompt_preview;
                card.appendChild(prompt);
            }

            card.addEventListener("click", function () {
                selectHistoryEntry(idx);
            });

            grid.appendChild(card);
        });
    }

    function selectHistoryEntry(idx) {
        const grid = document.getElementById("gen_tools_history_grid");
        if (!grid) return;

        // Update visual selection
        grid.querySelectorAll(".gentools-card").forEach(function (c) {
            c.classList.remove("active");
        });
        const card = grid.querySelector('[data-index="' + idx + '"]');
        if (card) {
            card.classList.add("active");
            card.scrollIntoView({ block: "nearest", behavior: "smooth" });
        }

        selectedIndex = idx;
        const entry = historyEntries[idx];
        if (entry && entry.infotext) {
            setGradioTextbox("gen_tools_infotext_for_apply", entry.infotext);
        }
    }

    // -----------------------------------------------------------------------
    // Watch the hidden history_json_state textbox for updates from Python
    // -----------------------------------------------------------------------

    function watchHistoryJsonState() {
        const pollInterval = 400; // ms
        let lastSeen = "";

        function check() {
            const val = getTextboxValue("gen_tools_history_json_state");
            if (val && val !== lastSeen) {
                lastSeen = val;
                try {
                    renderHistoryGrid(JSON.parse(val));
                } catch (e) {
                    // malformed JSON – skip
                }
            }
        }

        setInterval(check, pollInterval);
    }

    // -----------------------------------------------------------------------
    // Auto-refresh when the Gen Tools tab is first made visible
    // -----------------------------------------------------------------------

    function setupAutoRefresh() {
        let loaded = false;

        function tryRefresh() {
            if (loaded) return;
            // Gradio wraps each tab in a div with id="tab_{tab_id}"
            const tabEl = document.getElementById("tab_gen_tools");
            if (!tabEl) return;
            // Gradio hides inactive tabs with display:none
            if (tabEl.style.display === "none") return;

            loaded = true;
            const btn = document.getElementById("gen_tools_refresh");
            if (btn) btn.click();
        }

        // Poll until the tab is first shown
        const interval = setInterval(function () {
            tryRefresh();
            if (loaded) clearInterval(interval);
        }, 600);

        // Also react to tab-click events via MutationObserver on the tab container
        const observer = new MutationObserver(tryRefresh);
        observer.observe(document.body, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ["style", "class"],
        });
    }

    // -----------------------------------------------------------------------
    // Auto-distribute params when a file is dropped onto a prompt textarea
    // -----------------------------------------------------------------------

    /**
     * Returns the first visible paste (↙️) button.
     * Both txt2img and img2img toprows render a button with elem_id="paste";
     * pick the one whose ancestor tab is currently active (visible).
     */
    function findActivePasteBtn() {
        const all = document.querySelectorAll('[id="paste"]');
        for (const el of all) {
            // offsetParent is null for display:none elements
            if (el.offsetParent !== null) {
                return el.tagName === "BUTTON" ? el : el.querySelector("button");
            }
        }
        return null;
    }

    /**
     * Infotext always contains a "Steps: <number>" token.
     * Use this to distinguish params text from a normal prompt.
     */
    const INFOTEXT_RE = /\bSteps:\s*\d+/;

    function setupDropAutoPaste() {
        document.addEventListener("drop", function (e) {
            const target = e.composedPath ? e.composedPath()[0] : e.target;
            if (!target || target.tagName !== "TEXTAREA") return;

            // Only care about the prompt textareas (placeholder contains "Prompt")
            if (!(target.placeholder || "").includes("Prompt")) return;

            const files = e.dataTransfer && e.dataTransfer.files;
            if (!files || files.length === 0) return;

            const file = files[0];
            const name  = (file.name || "").toLowerCase();
            const isImg = file.type.startsWith("image/");
            const isTxt = name.endsWith(".txt");
            if (!isImg && !isTxt) return;

            const valueBefore = target.value;
            let attempts      = 0;
            const MAX         = 50; // poll up to 5 s

            const poll = setInterval(function () {
                attempts++;
                const cur = target.value;

                if (cur !== valueBefore && INFOTEXT_RE.test(cur)) {
                    clearInterval(poll);
                    const btn = findActivePasteBtn();
                    if (btn) btn.click();
                    return;
                }

                if (attempts >= MAX) clearInterval(poll);
            }, 100);
        });
    }

    // -----------------------------------------------------------------------
    // Diff compare drop zone
    // -----------------------------------------------------------------------

    function parseInfotext(text) {
        const info = {
            prompt: "",
            negative: "",
            params: {},
        };

        const lines = (text || "").split(/\r?\n/).map((x) => x.trim());
        if (lines.length > 0) {
            info.prompt = lines[0] || "";
        }

        const negLine = lines.find((line) => line.startsWith("Negative prompt:"));
        if (negLine) {
            info.negative = negLine.slice("Negative prompt:".length).trim();
        }

        const paramsLine = lines.find((line) => line.includes("Steps:")) || "";
        for (const part of paramsLine.split(",")) {
            const idx = part.indexOf(":");
            if (idx <= 0) continue;
            const key = part.slice(0, idx).trim();
            const value = part.slice(idx + 1).trim();
            if (key) {
                info.params[key] = value;
            }
        }

        return info;
    }

    function renderDiffText(beforeText, afterText) {
        const before = parseInfotext(beforeText);
        const after = parseInfotext(afterText);
        const lines = [];

        if ((before.prompt || "") !== (after.prompt || "")) {
            lines.push("Prompt:");
            lines.push("- " + (before.prompt || "(empty)"));
            lines.push("+ " + (after.prompt || "(empty)"));
            lines.push("");
        }

        if ((before.negative || "") !== (after.negative || "")) {
            lines.push("Negative prompt:");
            lines.push("- " + (before.negative || "(empty)"));
            lines.push("+ " + (after.negative || "(empty)"));
            lines.push("");
        }

        const keys = new Set([...Object.keys(before.params), ...Object.keys(after.params)]);
        const changed = [];
        for (const key of keys) {
            const oldVal = before.params[key] || "";
            const newVal = after.params[key] || "";
            if (oldVal !== newVal) {
                changed.push({ key, oldVal, newVal });
            }
        }

        if (changed.length > 0) {
            lines.push("Parameters:");
            for (const item of changed.sort((a, b) => a.key.localeCompare(b.key))) {
                lines.push(`- ${item.key}: ${item.oldVal || "(empty)"}`);
                lines.push(`+ ${item.key}: ${item.newVal || "(empty)"}`);
            }
        }

        if (lines.length === 0) {
            return "No differences found.";
        }

        return lines.join("\n");
    }

    function setupDiffCompareDropZone() {
        const dropZone = document.getElementById("gen_tools_diff_dropzone");
        const diffSummary = document.getElementById("gen_tools_diff_summary");
        const diffOutput = document.getElementById("gen_tools_diff_output");
        const fileWrap = document.getElementById("gen_tools_drop_file");

        if (!dropZone || !diffSummary || !diffOutput || !fileWrap) return;
        if (dropZone.dataset.bound === "1") return;
        dropZone.dataset.bound = "1";

        function setDragVisual(on) {
            dropZone.classList.toggle("drag-over", !!on);
        }

        function hasFiles(event) {
            const dt = event && event.dataTransfer;
            if (!dt) return false;
            if (dt.files && dt.files.length > 0) return true;
            if (dt.items && dt.items.length > 0) {
                return Array.from(dt.items).some((item) => item.kind === "file");
            }
            return false;
        }

        function dispatchToParser(files) {
            const fileInput = fileWrap.querySelector('input[type="file"]');
            if (!fileInput || !files || files.length === 0) return false;

            const data = new DataTransfer();
            for (const file of files) {
                data.items.add(file);
            }

            fileInput.files = data.files;
            fileInput.dispatchEvent(new Event("change", { bubbles: true }));
            return true;
        }

        dropZone.addEventListener("dragover", (e) => {
            if (!hasFiles(e)) return;
            e.preventDefault();
            e.stopPropagation();
            e.dataTransfer.dropEffect = "copy";
            setDragVisual(true);
        });

        dropZone.addEventListener("dragleave", () => {
            setDragVisual(false);
        });

        dropZone.addEventListener("drop", (e) => {
            setDragVisual(false);
            if (!hasFiles(e)) return;

            e.preventDefault();
            e.stopPropagation();

            const before = getTextboxValue("gen_tools_infotext_for_apply") || "";
            const files = e.dataTransfer.files;
            if (!dispatchToParser(files)) {
                diffSummary.textContent = "Could not send dropped file to parser.";
                return;
            }

            diffSummary.textContent = "Parsing dropped file and comparing...";

            let tries = 0;
            const maxTries = 60;
            const poll = setInterval(() => {
                tries += 1;
                const after = getTextboxValue("gen_tools_infotext_for_apply") || "";
                if (after && after !== before) {
                    clearInterval(poll);
                    const diffText = renderDiffText(before, after);
                    const changedCount = diffText === "No differences found." ? 0 : diffText.split("\n").filter((x) => x.startsWith("- ")).length;
                    diffSummary.textContent = `Compared dropped content against current params. Changed entries: ${changedCount}.`;
                    diffOutput.textContent = diffText;
                    return;
                }

                if (tries >= maxTries) {
                    clearInterval(poll);
                    diffSummary.textContent = "Timed out while waiting for parsed params.";
                }
            }, 100);
        });
    }

    // -----------------------------------------------------------------------
    // Initialisation
    // -----------------------------------------------------------------------

    function init() {
        watchHistoryJsonState();
        setupAutoRefresh();
        setupDropAutoPaste();
        setupDiffCompareDropZone();
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", function () {
            setTimeout(init, 600);
        });
    } else {
        setTimeout(init, 600);
    }
})();
