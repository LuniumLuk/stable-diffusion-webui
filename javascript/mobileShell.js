/**
 * Mobile shell: turns the desktop-shaped WebUI into an image-first phone layout.
 *
 *  - fixed TOP bar   : tab switcher (☰), horizontal chip strip of "features",
 *                      fold/expand toggle. Chips open a DOWN sheet (drops from the top).
 *  - fixed BOTTOM bar: Prompt / Params / Extra / Images + the primary Generate button.
 *                      Items open an UP sheet (rises from the bottom, like a mobile app).
 *  - sheets          : the *existing* gradio containers are promoted to a fixed panel via a
 *                      CSS class (no re-parenting, no inline-style surgery) so gradio keeps
 *                      working and closing a sheet is a single class removal.
 *  - image first     : the results area of the active tab is ordered above the controls and
 *                      the extra-networks block; on img2img the input image and the result
 *                      gallery end up stacked vertically (both full width).
 *  - bars fold away  : auto-hide when scrolling down, come back on scroll up, plus a manual
 *                      fold button (persisted in localStorage).
 *
 * Everything is scoped to `body.mshell`, applied only on narrow/coarse-pointer devices, so
 * the desktop layout is untouched.
 */
(function () {
    'use strict';

    const MQ = '(max-width: 900px), (pointer: coarse)';
    const LS_FOLD = 'mshell.folded';
    const LS_AUTOHIDE = 'mshell.autohide';

    // The shell is its own dark chrome outside <gradio-app>: never inherit page colours
    // (the inherited colour there is the browser default - black - even in the dark theme).
    const TAB_TEXT = '#f3f4f6';

    const readLS = (key, fallback) => {
        try {
            const v = window.localStorage ? window.localStorage.getItem(key) : null;
            return v === null || v === undefined ? fallback : v;
        } catch (e) {
            return fallback;
        }
    };
    const writeLS = (key, value) => {
        try {
            window.localStorage && window.localStorage.setItem(key, String(value));
        } catch (e) {
            /* ignore */
        }
    };

    function escapeHtml(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    // ── per-tab wiring ──────────────────────────────────────────────────────
    // Each entry maps a bar item / chip to an existing gradio container.
    const TABS = {
        txt2img: {
            label: 'txt2img',
            sheetUp: { prompt: 'txt2img_prompt_container', params: 'txt2img_settings', extra: 'txt2img_extra_tabs' },
            sheetDown: { hires: 'txt2img_hr_settings', styles: 'txt2img_styles' },
            results: 'txt2img_results',
            // the prompt + the whole settings column are reachable through the sheets
            sheetable: ['_prompt_container', '_settings'],
            imageFirst: 'txt2img_results',
            primary: 'txt2img_generate',
            busy: 'txt2img_interrupt',
        },
        img2img: {
            label: 'img2img',
            sheetUp: { prompt: 'img2img_prompt_container', params: 'img2img_settings', extra: 'img2img_extra_tabs' },
            sheetDown: { hires: 'img2img_hr_settings', styles: 'img2img_styles', controlnet: 'img2img_controlnet' },
            results: 'img2img_results',
            // the init-image tool lives INSIDE img2img_settings, so it stays in the page flow
            sheetable: ['_prompt_container'],
            imageFirst: 'img2img_settings',
            primary: 'img2img_generate',
            busy: 'img2img_interrupt',
        },
    };

    const state = {
        activeTab: 'txt2img',
        sheetElement: null,
        sheetName: null,
        lastScroll: 0,
        barsHidden: false,
    };

    const el = (tag, cls, html) => {
        const node = document.createElement(tag);
        if (cls) node.className = cls;
        if (html !== undefined) node.innerHTML = html;
        return node;
    };

    const app = () => (typeof gradioApp === 'function' ? gradioApp() : document);
    // shell-owned nodes (bars, tab list) live outside the gradio container
    const byId = (id) => app().querySelector('#' + id) || document.querySelector('#' + id);

    function activeTabKey() {
        const selected = document.querySelector('#tabs > .tab-nav .selected');
        const text = selected ? (selected.textContent || '').trim() : '';
        if (text.indexOf('img2img') >= 0) return 'img2img';
        if (text.indexOf('txt2img') >= 0) return 'txt2img';
        return null; // Extras / Gallery / Settings / ... keep the plain layout + the bars
    }

    function tabConfig() {
        return TABS[activeTabKey()] || null;
    }

    // ── sheets ──────────────────────────────────────────────────────────────

    function closeSheet() {
        if (state.sheetElement) {
            state.sheetElement.classList.remove('mshell-sheet', 'mshell-sheet-up', 'mshell-sheet-down');
            state.sheetElement.style.removeProperty('background');
        }
        state.sheetElement = null;
        state.sheetName = null;
        document.body.classList.remove('mshell-sheet-active');
        document.querySelectorAll('.mshell-sheet-title').forEach((t) => t.remove());
        syncBarState();
    }

    function openSheet(name, id, direction) {
        const target = id ? byId(id) : null;
        if (!target) {
            flash('not available on this tab');
            return;
        }
        if (state.sheetElement === target && state.sheetName === name) {
            closeSheet();
            return;
        }
        closeSheet();
        state.sheetElement = target;
        state.sheetName = name;
        target.classList.add('mshell-sheet', direction === 'down' ? 'mshell-sheet-down' : 'mshell-sheet-up');
        document.body.classList.add('mshell-sheet-active');

        // A promoted gradio column has no background of its own (gradio's `.compact` rule
        // even forces `transparent !important`), and the padded area of the sheet is where
        // the page would show through. Set it inline so it holds regardless of stylesheet.
        target.style.setProperty('background', 'var(--background-fill-primary, #0b0f19)', 'important');

        // a small header with the sheet name + close button, injected inside the panel
        const title = el('div', 'mshell-sheet-title');
        title.innerHTML = `<span class="mshell-sheet-grip"></span><span class="mshell-sheet-name">${escapeHtml(name)}</span>`
            + '<button type="button" class="mshell-sheet-close" title="Close">✕</button>';
        title.querySelector('.mshell-sheet-close').addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            closeSheet();
        });
        target.insertBefore(title, target.firstChild);
        // remember where the user was so the scroll position survives the sheet
        title.dataset.scrollBack = String(window.scrollY);
        syncBarState();
    }

    function flash(text) {
        let node = document.querySelector('.mshell-flash');
        if (!node) {
            node = el('div', 'mshell-flash');
            document.body.appendChild(node);
        }
        node.textContent = text;
        node.classList.add('is-visible');
        clearTimeout(flash.timer);
        flash.timer = setTimeout(() => node.classList.remove('is-visible'), 1600);
    }

    // ── viewport lock ───────────────────────────────────────────────────────
    //
    // Phones have no room for a page that scrolls as a whole - and dragging on a canvas
    // never scrolls the page anyway, which is exactly what makes the old layout awkward.
    // So the document stops scrolling and the tab body becomes the only scroll pane.

    function paneElement() {
        return app().querySelector('#tabs') || document.querySelector('#tabs');
    }

    /** A new tab always starts at its top (the pane itself keeps its scroll otherwise). */
    function resetPaneScroll() {
        const pane = paneElement();
        if (pane) pane.scrollTop = 0;
        state.lastScroll = 0;
        document.body.classList.remove('mshell-bars-hidden');
        state.barsHidden = false;
    }

    function applyViewportLock() {
        if (!document.body || !document.body.classList.contains('mshell')) return;
        const pane = paneElement();
        if (!pane) return;
        // a reload can restore a document scroll offset which would then be unreachable
        // (the document is locked) - park it at the top
        const scroller = document.scrollingElement || document.documentElement;
        if (scroller && scroller.scrollTop) scroller.scrollTop = 0;
        const top = pane.getBoundingClientRect().top;
        const bottomBar = document.getElementById('mshell_bottom');
        const barHeight = bottomBar && !document.body.classList.contains('mshell-folded')
            ? bottomBar.getBoundingClientRect().height
            : 12;
        const height = Math.max(220, Math.round(window.innerHeight - top - barHeight - 6));
        document.documentElement.style.setProperty('--mshell-pane-h', height + 'px');
    }

    function onPaneScroll(event) {
        const pane = event.target;
        if (!pane || pane.id !== 'tabs') return;
        autoHide(pane.scrollTop);
    }

    // ── bars ────────────────────────────────────────────────────────────────

    function buildBars() {
        if (document.querySelector('#mshell_top')) return;

        const top = el('div', '', '');
        top.id = 'mshell_top';
        top.innerHTML = `
            <button type="button" class="mshell-btn mshell-tab" id="mshell_tab_btn" title="Switch tab">☰</button>
            <div class="mshell-strip" id="mshell_top_strip"></div>
            <button type="button" class="mshell-btn" id="mshell_fold_top" title="Fold the toolbars">⌃</button>
        `;
        document.body.appendChild(top);

        const bottom = el('div', '', '');
        bottom.id = 'mshell_bottom';
        bottom.innerHTML = `
            <div class="mshell-strip" id="mshell_bottom_strip"></div>
            <button type="button" class="mshell-primary" id="mshell_generate">▶ Generate</button>
        `;
        document.body.appendChild(bottom);

        const handle = el('button', '', '⌄');
        handle.id = 'mshell_handle';
        handle.title = 'Show the toolbars';
        document.body.appendChild(handle);

        handle.addEventListener('click', () => setFolded(false));

        top.querySelector('#mshell_fold_top').addEventListener('click', () => setFolded(true));
        top.querySelector('#mshell_tab_btn').addEventListener('click', () => openSheet('tabs', 'mshell_tab_list', 'down'));
        bottom.querySelector('#mshell_generate').addEventListener('click', onPrimary);

        // the tab list lives in its own (hidden) container so it can be a sheet
        const tabList = el('div', '', '');
        tabList.id = 'mshell_tab_list';
        document.body.appendChild(tabList);
    }

    function refreshTabList() {
        const list = document.querySelector('#mshell_tab_list');
        if (!list) return;
        const nav = document.querySelector('#tabs > .tab-nav');
        if (!nav) return;
        const items = Array.from(nav.children).filter((b) => (b.textContent || '').trim());
        list.innerHTML = items.map((b, i) => `<button type="button" class="mshell-tab-item${b.classList.contains('selected') ? ' is-current' : ''}" data-i="${i}">${escapeHtml((b.textContent || '').trim())}</button>`).join('');
        list.querySelectorAll('.mshell-tab-item').forEach((btn, i) => {
            // The shell lives outside <gradio-app>, so the inherited colour is the browser default
            // (black on the dark sheet) - pin the colours inline, with priority, so neither a
            // stale stylesheet nor any `!important` theme rule can make the labels unreadable.
            btn.style.setProperty('color', TAB_TEXT, 'important');
            if (btn.classList.contains('is-current')) btn.style.setProperty('border-color', '#f97316', 'important');
            btn.addEventListener('click', () => {
                items[i].click();
                closeSheet();
                setTimeout(syncBarState, 350);
            });
        });
    }

    function refreshStrips() {
        const cfg = tabConfig();
        if (!cfg) return; // non-generator tab: the strips stay hidden (see .mshell-no-tab)
        const topStrip = document.querySelector('#mshell_top_strip');
        const bottomStrip = document.querySelector('#mshell_bottom_strip');
        if (!topStrip || !bottomStrip) return;

        const topItems = [
            ['✍ Prompt', 'prompt'],
            ['⚙ Params', 'params'],
            ['🧩 Extra', 'extra'],
            ['🖼 Results', 'results'],
        ];
        const bottomItems = [
            ['✍ Prompt', 'prompt'],
            ['⚙ Params', 'params'],
            ['🧩 Extra', 'extra'],
            ['🖼 Images', 'images'],
        ];

        const render = (strip, items, dir) => {
            strip.innerHTML = items.map(([label, key]) => `<button type="button" class="mshell-btn mshell-chip" data-key="${key}">${label}</button>`).join('');
            strip.querySelectorAll('.mshell-chip').forEach((btn) => {
                btn.addEventListener('click', () => {
                    // resolve the tab config at click time: the strip is rendered once but the
                    // user may have switched tabs in the meantime
                    const cfg = tabConfig();
                    const key = btn.dataset.key;
                    if (key === 'results') {
                        scrollToResults(cfg.results);
                        return;
                    }
                    if (key === 'images') {
                        // img2img has two points of interest: the input image (kept in the
                        // page flow) comes first, the result gallery right below it
                        const image = byId('img2img_image');
                        if (cfg.imageFirst === 'img2img_settings' && image && image.getBoundingClientRect().height > 0) {
                            closeSheet();
                            image.scrollIntoView({ block: 'start', behavior: 'smooth' });
                            return;
                        }
                        scrollToResults(cfg.results);
                        return;
                    }
                    openSheet(key, cfg.sheetUp[key], dir);
                });
            });
        };
        render(topStrip, topItems, 'down');
        render(bottomStrip, bottomItems, 'up');
    }

    function scrollToResults(id) {
        const target = id ? byId(id) : null;
        if (!target) {
            flash('no results area here');
            return;
        }
        closeSheet();
        target.scrollIntoView({ block: 'start', behavior: 'smooth' });
    }

    function onPrimary() {
        const cfg = tabConfig();
        if (!cfg) {
            flash('no generator on this tab');
            openSheet('tabs', 'mshell_tab_list', 'down');
            return;
        }
        const busy = cfg.busy ? byId(cfg.busy) : null;
        if (busy && busy.getBoundingClientRect().width > 0) {
            busy.click();
            return;
        }
        const target = cfg.primary ? byId(cfg.primary) : null;
        if (!target) {
            flash('no generate button on this tab');
            return;
        }
        target.click();
        flash('generation queued');
    }

    function syncBarState() {
        const cfg = tabConfig();
        document.body.classList.toggle('mshell-no-tab', !cfg);
        const primary = document.querySelector('#mshell_generate');
        if (primary) {
            const busy = cfg && cfg.busy ? byId(cfg.busy) : null;
            const running = busy && busy.getBoundingClientRect().width > 0;
            primary.textContent = running ? '⏹ Stop' : '▶ Generate';
            primary.classList.toggle('is-busy', !!running);
        }
        refreshTabList();
    }

    function setFolded(folded) {
        writeLS(LS_FOLD, folded ? '1' : '0');
        applyFold();
    }

    function applyFold() {
        const folded = readLS(LS_FOLD, '0') === '1';
        document.body.classList.toggle('mshell-folded', folded);
    }

    // ── auto-hide while scrolling down (classic mobile behaviour) ────────────

    function autoHide(y) {
        if (readLS(LS_AUTOHIDE, '1') !== '1') return;
        const delta = y - state.lastScroll;
        state.lastScroll = y;
        if (Math.abs(delta) < 12) return;
        const hide = delta > 0 && y > 60;
        if (hide !== state.barsHidden) {
            state.barsHidden = hide;
            document.body.classList.toggle('mshell-bars-hidden', hide);
        }
    }

    // ── boot ────────────────────────────────────────────────────────────────

    // ── image first ─────────────────────────────────────────────────────────
    //
    // The desktop layout puts the prompt, the action column and the whole extra-networks
    // block above the results - on a phone that means the image you just generated sits two
    // screens down.  Instead of moving DOM nodes around (which gradio dislikes) we flip the
    // flex order of the existing parents so the results (and for img2img the input image)
    // come first, and hide the containers that the sheets already provide.

    // In this fork the generation results live inside the extra-networks tab group
    // (`#txt2img_results` -> `#txt2img_extra_tabs` -> `.gap` -> `#txt2img_toprow`), so the shell
    // promotes that whole branch above the prompt/top row instead of moving anything.
    const SHEETABLE = ['_prompt_container', '_settings'];

    // Inline styles are the only way to reorder foreign DOM safely, so remember the original
    // values to be able to hand the layout back to the desktop stylesheet.
    const touched = new Map();

    function touch(node) {
        if (!node || touched.has(node)) return;
        touched.set(node, { order: node.style.order, display: node.style.display, flexDirection: node.style.flexDirection });
    }

    function untouch() {
        touched.forEach((previous, node) => {
            node.style.order = previous.order;
            node.style.display = previous.display;
            node.style.flexDirection = previous.flexDirection;
        });
        touched.clear();
    }

    function makeColumn(node) {
        if (!node) return;
        if (window.getComputedStyle(node).flexDirection !== 'column') {
            touch(node);
            node.style.display = 'flex';
            node.style.flexDirection = 'column';
        }
    }

    /** Raise `node` (and its ancestor chain) above the block containing `above`. */
    function promote(node, above) {
        if (!node) return;
        let current = node;
        while (current && current.parentElement && current.parentElement !== document.body) {
            const parent = current.parentElement;
            makeColumn(parent);
            touch(current);
            current.style.order = '-1';
            if (!above || parent.contains(above)) break;
            current = parent;
        }
        // and push the prompt / top row block below the promoted branch
        if (above && node.parentElement && node.parentElement.contains(above) && above !== node) {
            let sibling = above;
            while (sibling.parentElement && sibling.parentElement !== node.parentElement) sibling = sibling.parentElement;
            if (sibling !== node) {
                touch(sibling);
                sibling.style.order = '20';
            }
        }
    }

    function applyImageFirst() {
        const key = activeTabKey();
        const cfg = key ? TABS[key] : null;
        if (!cfg) return;
        const toprow = byId(key + '_toprow');
        const results = cfg.results ? byId(cfg.results) : null;
        const first = cfg.imageFirst ? byId(cfg.imageFirst) : results;

        // containers the bottom-bar sheets own - hidden from the page flow
        (cfg.sheetable || []).forEach((suffix) => {
            const node = byId(key + suffix);
            if (node) node.classList.add('mshell-sheetable');
        });
        // the other tab must not keep the class when it becomes active
        Object.keys(TABS).forEach((other) => {
            if (other === key) return;
            (TABS[other].sheetable || []).forEach((suffix) => {
                const node = byId(other + suffix);
                if (node) node.classList.remove('mshell-sheetable');
            });
        });

        if (key === 'img2img') {
            // input image (inside img2img_settings) first, results right after it,
            // the action buttons last
            if (first === results || !results) {
                if (results) promote(results, toprow);
                return;
            }
            if (toprow && !first.contains(toprow)) promote(first, toprow);
            if (results && first.parentElement === results.parentElement) {
                touch(results);
                results.style.order = '5';
            }
        } else if (results && toprow && !results.contains(toprow)) {
            promote(results, toprow);
        } else if (results) {
            promote(results, null);
        }
    }

    function enable() {
        document.documentElement.classList.add('mshell');
        document.body.classList.add('mshell');
        buildBars();
        refreshStrips();
        applyFold();
        applyImageFirst();
        applyViewportLock();
        syncBarState();
    }

    /** Hand the layout back to the desktop stylesheet (narrow window resize back to wide). */
    function disable() {
        closeSheet();
        untouch();
        document.querySelectorAll('.mshell-sheetable').forEach((n) => n.classList.remove('mshell-sheetable'));
        document.documentElement.style.removeProperty('--mshell-pane-h');
        document.documentElement.classList.remove('mshell');
        document.body.classList.remove('mshell', 'mshell-folded', 'mshell-bars-hidden', 'mshell-sheet-active');
    }

    function boot() {
        const mq = window.matchMedia(MQ);
        const apply = () => {
            if (mq.matches) enable();
            else disable();
        };
        apply();
        if (mq.addEventListener) mq.addEventListener('change', apply);
        else if (mq.addListener) mq.addListener(apply);

        // iOS Safari sometimes scrolls the document even with overflow:hidden - snap it back
        window.addEventListener('scroll', () => {
            const scroller = document.scrollingElement || document.documentElement;
            if (scroller && scroller.scrollTop) scroller.scrollTop = 0;
            autoHide(scroller ? scroller.scrollTop : 0);
        }, { passive: true });
        document.addEventListener('scroll', onPaneScroll, { passive: true, capture: true });
        window.addEventListener('resize', () => applyViewportLock());
        window.addEventListener('orientationchange', () => setTimeout(applyViewportLock, 250));
        if (window.visualViewport && window.visualViewport.addEventListener) {
            window.visualViewport.addEventListener('resize', applyViewportLock);
        }
        document.addEventListener('click', (e) => {
            // keep the bars in sync when the user switches tabs / starts a job
            if (e.target && e.target.closest && e.target.closest('#tabs > .tab-nav')) setTimeout(() => { syncBarState(); applyImageFirst(); applyViewportLock(); resetPaneScroll(); }, 300);
        }, true);

        // A dropdown inside a sheet opens its list right under the input. Centre the row
        // first, so the list fits inside the sheet instead of spilling off the screen.
        // Capture phase + pointer/mouse down, so this runs before gradio measures the input.
        const centreRow = (target) => {
            if (!document.body.classList.contains('mshell') || !target || !target.closest) return;
            const dd = target.closest('.mshell-sheet .gradio-dropdown, .mshell-sheet .gradio-multiselect');
            if (!dd) return;
            const sheet = dd.closest('.mshell-sheet');
            const sr = sheet.getBoundingClientRect();
            const dr = dd.getBoundingClientRect();
            const delta = dr.top + dr.height / 2 - (sr.top + sr.height / 2);
            if (Math.abs(delta) > 24) sheet.scrollTop += delta;
        };
        document.addEventListener('pointerdown', (e) => centreRow(e.target), true);
        document.addEventListener('mousedown', (e) => centreRow(e.target), true);

        // Phone dropdowns: gradio's list is `position: fixed` with a viewport `top`.
        // (a) pickers are not text fields - `inputmode=none` keeps the iOS keyboard down, so
        //     the list is not pushed under it, and (b) whatever the list ends up doing, keep
        //     it inside the *visual* viewport (iOS shrinks it by the keyboard height).
        const decorateDropdowns = () => {
            if (!document.body.classList.contains('mshell')) return;
            document.querySelectorAll('.gradio-dropdown input:not([inputmode])').forEach((input) => {
                input.setAttribute('inputmode', 'none');
                input.setAttribute('autocomplete', 'off');
                input.setAttribute('spellcheck', 'false');
            });
        };

        const fitFloatingLists = () => {
            if (!document.body.classList.contains('mshell')) return;
            const vv = window.visualViewport;
            const top = Math.round(vv ? vv.offsetTop : 0);
            const height = Math.round(vv ? vv.height : window.innerHeight);
            const bottom = top + height;
            document.querySelectorAll('.gradio-dropdown ul.options, .gradio-dropdown .options').forEach((list) => {
                const rect = list.getBoundingClientRect();
                const roomy = rect.height <= height - 12;
                if (roomy && rect.top >= top + 2 && rect.bottom <= bottom - 4) return;
                const listH = Math.min(rect.height, height - 12);
                const wantTop = Math.min(Math.max(rect.top, top + 6), bottom - 6 - listH);
                list.style.setProperty('max-height', Math.max(160, height - 12) + 'px', 'important');
                list.style.setProperty('top', Math.round(wantTop) + 'px', 'important');
            });
        };

        window.addEventListener('resize', decorateDropdowns);
        setInterval(() => { decorateDropdowns(); fitFloatingLists(); }, 250);
        setInterval(() => {
            const key = activeTabKey();
            if (key !== state.activeTab) {
                state.activeTab = key;
                applyImageFirst();
                const fresh = tabConfig();
                if (fresh) refreshStrips();
                resetPaneScroll();
                applyViewportLock();
            }
            syncBarState();
        }, 1200);

        window.mobileShell = {
            enable: enable,
            openSheet: (name, id, dir) => openSheet(name, id || state.sheetName, dir || 'up'),
            close: closeSheet,
            fold: setFolded,
            imageFirst: applyImageFirst,
            lock: applyViewportLock,
            refresh: () => {
                refreshStrips();
                applyImageFirst();
                applyViewportLock();
                syncBarState();
            },
        };
    }

    if (typeof onUiLoaded === 'function') onUiLoaded(boot);
    else if (document.readyState === 'complete') boot();
    else window.addEventListener('load', boot);
})();
