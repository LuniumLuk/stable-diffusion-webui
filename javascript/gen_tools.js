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
    // Initialisation
    // -----------------------------------------------------------------------

    function init() {
        watchHistoryJsonState();
        setupAutoRefresh();
        setupDropAutoPaste();
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", function () {
            setTimeout(init, 600);
        });
    } else {
        setTimeout(init, 600);
    }
})();
