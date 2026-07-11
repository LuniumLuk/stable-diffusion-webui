(function () {
    // ── Tooltip for queue job rows ──────────────────────────────────────────
    var jqTooltip = null;
    var jqTooltipTimer = null;
    var jqTooltipCurrentRow = null;

    function ensureTooltip() {
        if (jqTooltip) return jqTooltip;
        jqTooltip = document.createElement('div');
        jqTooltip.className = 'jq-tooltip';
        jqTooltip.style.display = 'none';
        document.body.appendChild(jqTooltip);
        return jqTooltip;
    }

    function escapeHtml(text) {
        var div = document.createElement('div');
        div.appendChild(document.createTextNode(text));
        return div.innerHTML;
    }

    function buildTooltipHtml(details) {
        var order = ['Prompt', 'Negative prompt', 'Styles', 'Steps', 'Sampler', 'Scheduler',
            'CFG scale', 'Seed', 'Size', 'Batch', 'Denoising', 'Resize mode',
            'Mask blur', 'Hires fix', 'Hires scale', 'Hires upscaler',
            'Hires steps', 'Hires checkpoint', 'Image count', 'Job ID', 'Type', 'Status'];
        var html = '<table class="jq-tooltip-table">';
        for (var i = 0; i < order.length; i++) {
            var key = order[i];
            if (!(key in details)) continue;
            var val = details[key];
            if (!val && val !== 0) continue;
            // Highlight certain values
            var valClass = '';
            if (key === 'Prompt' || key === 'Negative prompt') {
                valClass = ' class="jq-tt-prompt"';
            }
            html += '<tr><th>' + escapeHtml(key) + '</th><td' + valClass + '>' + escapeHtml(String(val)) + '</td></tr>';
        }
        // Render any remaining keys not in the order list
        for (var k in details) {
            if (!details.hasOwnProperty(k)) continue;
            if (order.indexOf(k) >= 0) continue;
            var v = details[k];
            if (!v && v !== 0) continue;
            html += '<tr><th>' + escapeHtml(k) + '</th><td>' + escapeHtml(String(v)) + '</td></tr>';
        }
        html += '</table>';
        return html;
    }

    function showTooltip(row, details) {
        var tip = ensureTooltip();
        tip.innerHTML = buildTooltipHtml(details);
        tip.style.display = 'block';

        // Position to the right of the row, or below if near right edge
        var rect = row.getBoundingClientRect();
        var tipWidth = tip.offsetWidth || 360;
        var tipHeight = tip.offsetHeight || 200;
        var viewW = window.innerWidth;
        var viewH = window.innerHeight;

        var left = rect.right + 10;
        var top = rect.top;

        // If too close to right edge, position to the left of the row
        if (left + tipWidth > viewW - 10) {
            left = rect.left - tipWidth - 10;
        }
        // If too close to left edge, fall back to right side
        if (left < 5) {
            left = 5;
        }

        // Keep within vertical viewport
        if (top + tipHeight > viewH - 10) {
            top = Math.max(5, viewH - tipHeight - 10);
        }
        if (top < 5) top = 5;

        tip.style.left = left + 'px';
        tip.style.top = top + 'px';

        jqTooltipCurrentRow = row;
    }

    function hideTooltip() {
        if (jqTooltip) {
            jqTooltip.style.display = 'none';
        }
        jqTooltipCurrentRow = null;
        if (jqTooltipTimer) {
            clearTimeout(jqTooltipTimer);
            jqTooltipTimer = null;
        }
    }

    function onQueueRowEnter(e) {
        var row = e.target.closest('tr.jq-row');
        if (!row) return;
        // Check if we actually entered a new row (not just moved between cells)
        if (jqTooltipCurrentRow === row) return;

        // Hide any previous tooltip
        hideTooltip();

        // Debounce: wait 300ms before showing
        jqTooltipTimer = setTimeout(function () {
            try {
                var raw = row.getAttribute('data-job-details');
                if (!raw) return;
                var details = JSON.parse(raw);
                if (!details || Object.keys(details).length === 0) return;
                showTooltip(row, details);
            } catch (_e) {
                // ignore parse errors
            }
        }, 300);
    }

    function onQueueRowLeave(e) {
        var row = e.target.closest('tr.jq-row');
        if (!row) return;
        // Check if the mouse moved to a child of the same row
        var related = e.relatedTarget;
        if (related && row.contains(related)) return;

        if (jqTooltipTimer) {
            clearTimeout(jqTooltipTimer);
            jqTooltipTimer = null;
        }
        // Small delay to allow moving mouse to tooltip
        setTimeout(function () {
            // Check if mouse is now over the tooltip
            if (jqTooltip && jqTooltip.matches(':hover')) return;
            hideTooltip();
        }, 100);
    }

    function onTooltipLeave() {
        hideTooltip();
    }

    function setupQueueTooltips() {
        var table = document.querySelector('#jq_queue_html .jq-table tbody');
        if (!table) return;

        if (table.dataset.jqTooltipBound) return;
        table.dataset.jqTooltipBound = '1';

        table.addEventListener('mouseover', onQueueRowEnter, true);
        table.addEventListener('mouseout', onQueueRowLeave, true);

        // Also bind to the tooltip itself so it stays visible when hovering over it
        var tip = ensureTooltip();
        tip.addEventListener('mouseleave', onTooltipLeave);
        tip.addEventListener('mouseenter', function () {
            if (jqTooltipTimer) {
                clearTimeout(jqTooltipTimer);
                jqTooltipTimer = null;
            }
        });
    }

    // Try to bind on load, and also after each queue refresh
    onUiLoaded(function () {
        setupQueueTooltips();
    });

    // Re-bind after every queue refresh (the table body gets replaced)
    var queueObserver = new MutationObserver(function (mutations) {
        for (var i = 0; i < mutations.length; i++) {
            var m = mutations[i];
            if (m.type === 'childList' && m.target.id === 'jq_queue_html') {
                // Reset binding flag so tooltips get re-bound to new DOM
                var tbody = document.querySelector('#jq_queue_html .jq-table tbody');
                if (tbody) {
                    delete tbody.dataset.jqTooltipBound;
                }
                setupQueueTooltips();
                break;
            }
        }
    });

    onUiLoaded(function () {
        var container = document.getElementById('jq_queue_html');
        if (container) {
            queueObserver.observe(container, { childList: true, subtree: true });
        }
    });

    // ── Existing queue action helpers ───────────────────────────────────────

    function setTextboxValue(elemId, value) {
        var el = gradioApp().querySelector('#' + elemId + ' textarea');
        if (!el) return false;
        var setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
        setter.call(el, value);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
    }

    window.queueTabAction = function (action, jobId) {
        var payload = JSON.stringify({ action: action, job_id: jobId || '' });
        if (!setTextboxValue('jq_action_input', payload)) {
            return;
        }

        var btn = gradioApp().getElementById('jq_action_btn');
        if (btn) {
            btn.click();
        }
    };

    // ── Global keybinding: Escape to close tooltip ──────────────────────────
    document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape') {
            hideTooltip();
        }
    });
})();