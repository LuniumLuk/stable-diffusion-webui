/* Gallery v2 front-end: /gallery/api driven cards, filters, batch actions.
   Mounts into #gallery-v2-root (scripts/gallery_v2_tab.py). ASCII source. */
(function () {
  'use strict';

  var ROOT_ID = 'gallery-v2-root';
  var PAGE = 60;
  var SORTS = [
    ['time_desc', 'Newest first'],
    ['time_asc', 'Oldest first'],
    ['resolution', 'Resolution'],
    ['size', 'File size'],
    ['random', 'Random']
  ];
  var TIMES = [
    ['all', 'Any time'],
    ['1h', 'Last hour'],
    ['1d', 'Last 24h'],
    ['3d', 'Last 3 days'],
    ['7d', 'Last 7 days'],
    ['30d', 'Last 30 days'],
    ['1y', 'Last year']
  ];
  var STATES = [
    ['', 'All'],
    ['active', '\u2728 Active'],
    ['staged', '\u{1F4CC} Staged'],
    ['archived', '\u{1F4E6} Archived'],
    ['trashed', '\u{1F5D1} Trash']
  ];
  var RATINGS = [
    ['', 'Any rating'],
    ['endorsed', '\u2B50 Endorsed'],
    ['disliked', '\u{1F44E} Disliked'],
    ['none', '\u2B1C Unrated']
  ];
  var RESOLUTIONS = [
    ['', 'Any size'],
    ['min1024', '>= 1K'],
    ['min2048', '>= 2K'],
    ['landscape', 'Landscape'],
    ['portrait', 'Portrait'],
    ['square', 'Square']
  ];

  var GROUP_EMOJI = {
    sdxl: '\u{1F5BC}',
    nonesdxl: '\u{1F6AB}',
    composed: '\u{1F3A8}',
    imagemaker: '\u{1F4F7}',
    otherengines: '\u2728',
    endorsed: '\u2B50',
    disliked: '\u{1F44E}',
    unrated: '\u2B1C'
  };

  var state = {
    filters: { q: '', preset: 'all', states: [], sources: [], albums: [], show_albumed: false, rating: '', tags: {} },
    sort: 'time_desc',
    limit: PAGE,
    offset: 0,
    pageMode: 'scroll',
    pageSize: PAGE,
    thumbSize: 'm',
    page: 1,
    total: 0,
    rows: [],
    selected: new Set(),
    facets: null,
    views: [],
    albums: [],
    selectMode: false,
    lastIndex: -1,
    detailKey: null,
    detailMediaLeft: false, // detail drawer: preview on the left stage instead of in the panel
    promptVariant: 'source', // 'source' or 'compiled' - which prompt the info panel shows / sends
    busy: false,
    loadedOnce: false
  };

  function el(id) { return document.getElementById(id); }

  function esc(text) {
    return String(text == null ? '' : text)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function api(path, body) {
    var opts = body === undefined
      ? { method: 'GET' }
      : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
    return fetch(path, opts).then(function (r) {
      return r.json().catch(function () { return null; }).then(function (data) {
        if (!r.ok) throw new Error((data && data.detail) || ('HTTP ' + r.status));
        return data;
      });
    });
  }

  function blobUrl(row, kind) {
    return '/gallery/api/blob?id=' + encodeURIComponent(row.uid) + '&kind=' + kind;
  }

  function fmtTime(mtime) {
    if (!mtime) return '';
    var d = new Date(mtime * 1000);
    return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function fmtCardTime(mtime) {
    if (!mtime) return '';
    var d = new Date(mtime * 1000);
    var p = function (v) { return (v < 10 ? '0' : '') + v; };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' +
      p(d.getHours()) + ':' + p(d.getMinutes());
  }

  // ---------------------------------------------------------------- send to

  var SEND_ACTIONS = [
    ['txt2img', '\u270E  txt2img', 'Apply the prompt + parameters to txt2img'],
    ['img2img', '\u{1F5BC}\uFE0F  Image', 'Send only the image to img2img (right-click: prompt-only / image + prompt / send all)'],
    ['inpaint', '\u{1F3A8}  Inpaint', 'Send only the image to inpaint (right-click: prompt-only / image + prompt / send all)'],
    ['composer', '\u{1F9E9}  Composer', 'Open the image in the Composer tab'],
    ['censor', '\u{1F58A}\uFE0F  Censor', 'Open the image in the Censor panel']
  ];

  function setGradioTextbox(elemId, value) {
    var host = gradioApp().querySelector('#' + elemId);
    var el = host ? host.querySelector('textarea') : null;
    if (!el) return false;
    var setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  }

  function clickGradioBtn(elemId, delay) {
    setTimeout(function () {
      var btn = gradioApp().querySelector('#' + elemId);
      if (btn) btn.click();
    }, delay == null ? 80 : delay);
  }

  function fileServeUrl(absPath) {
    return '/file=' + encodeURIComponent(String(absPath || '').replace(/\\/g, '/'));
  }

  function switchToTabByName(name) {
    var tabHost = gradioApp().querySelector('#tabs div');
    if (!tabHost) return;
    var target = (name || '').trim().toLowerCase();
    tabHost.querySelectorAll('button').forEach(function (btn) {
      if (btn.textContent.trim().toLowerCase().includes(target)) btn.click();
    });
  }

  function applyInfotext(text, target) {
    if (!text) return true;
    if (!setGradioTextbox('gv2_infotext_apply', text)) {
      toast('Send bridge missing \u2014 restart the webui to enable it', true);
      return false;
    }
    clickGradioBtn(target === 'img2img' ? 'gv2_apply_img2img_btn' : 'gv2_apply_txt2img_btn');
    return true;
  }

  // ---------------------------------------------------------------- prompt variant
  //
  // Every item stores the source prompt (as typed, comments and @PICK groups intact)
  // and, for images generated after the feature landed, the compiled prompt that was
  // actually conditioned on. The detail panel toggles between them; the choice is
  // remembered and the send actions use it too.

  function hasCompiledPrompt(item) {
    return !!(item && item.compiled_prompt);
  }

  function activePrompt(item) {
    if (state.promptVariant === 'compiled' && hasCompiledPrompt(item)) return item.compiled_prompt;
    return (item && item.prompt) || '';
  }

  function activeNegativePrompt(item) {
    if (state.promptVariant === 'compiled' && hasCompiledPrompt(item)) {
      return item.compiled_negative_prompt || '';
    }
    return (item && item.negative_prompt) || '';
  }

  /** Split an A1111 infotext into prompt block, negative prompt and the parameter lines. */
  function splitInfotext(text) {
    var body = String(text || '');
    var stepsAt = body.lastIndexOf('\nSteps: ');
    var head = stepsAt >= 0 ? body.slice(0, stepsAt) : body;
    var params = stepsAt >= 0 ? body.slice(stepsAt + 1) : '';
    var negAt = head.lastIndexOf('\nNegative prompt: ');
    var prompt = negAt >= 0 ? head.slice(0, negAt) : head;
    var negative = negAt >= 0 ? head.slice(negAt + '\nNegative prompt: '.length) : null;
    return { prompt: prompt, negative: negative, params: params };
  }

  /** The item's infotext with its prompt/negative replaced by the remembered variant. */
  function variantInfotext(item) {
    var infotext = item.infotext || '';
    if (state.promptVariant !== 'compiled' || !hasCompiledPrompt(item)) return infotext;
    var parts = splitInfotext(infotext);
    if (!parts.params) return activePrompt(item);
    var negative = activeNegativePrompt(item);
    return activePrompt(item)
      + (negative ? '\nNegative prompt: ' + negative : '')
      + '\n' + parts.params;
  }

  // "Send prompt + negative only": write JUST the item's prompt / negative
  // prompt into the img2img prompt boxes (the inpaint sub-tab shares them).
  // Deliberately NOT via the paste bridge: parse_generation_parameters always
  // fills in defaults (Clip skip=1, Hires resize/prompt/sampler/checkpoint,
  // ...) and paste_func applies every present key, so the bridge cannot
  // express "prompt + negative only". Fields the item lacks stay untouched.
  function applyPromptOnly(item) {
    var prompt = activePrompt(item);
    var negative = activeNegativePrompt(item);
    if (!prompt && !negative) { toast('No prompt / negative prompt to send', true); return false; }
    if (prompt) setGradioTextbox('img2img_prompt', prompt);
    if (negative) setGradioTextbox('img2img_neg_prompt', negative);
    return true;
  }

  function fetchItemImageBlob(item) {
    // Prefer the original file on disk, fall back to the stored preview blob.
    var path = item.path || item.alias_path || '';
    var urls = [];
    if (path) urls.push(fileServeUrl(path));
    if (item.state !== 'trashed') urls.push(blobUrl(item, 'preview'));
    var attempt = function (idx) {
      if (idx >= urls.length) return Promise.reject(new Error('no media'));
      return fetch(urls[idx]).then(function (res) {
        if (!res.ok) throw new Error('fetch ' + res.status);
        return res.blob();
      }).catch(function () { return attempt(idx + 1); });
    };
    return attempt(0);
  }

  function injectImageInto(item, hostId) {
    return fetchItemImageBlob(item).then(function (blob) {
      var fileInput = gradioApp().querySelector('#' + hostId + ' input[type="file"]');
      if (!fileInput) { toast(hostId + ' image input not found', true); return; }
      var name = ((item.path || '').split(/[\\/]/).pop()) || 'gallery-image.png';
      var file = new File([blob], name, { type: blob.type || 'image/png' });
      var data = new DataTransfer();
      data.items.add(file);
      fileInput.files = data.files;
      fileInput.dispatchEvent(new Event('change', { bubbles: true }));
    }).catch(function () { toast('No image media available for this item', true); });
  }

  // Land on the img2img top tab + the requested sub-tab and, when an item is given,
  // drop the image into that sub-tab's OWN component.  The img2img and Inpaint
  // sub-tabs have SEPARATE gradio components (#img2img_image vs #img2maskimg), so
  // injecting into the wrong one "loses" the image in the hidden sub-tab.
  function goToImg2ImgSub(sub, item) {
    setTimeout(function () { switchToTabByName('img2img'); }, 200);
    setTimeout(function () {
      if (sub === 'inpaint') {
        if (typeof window.switch_to_inpaint === 'function') window.switch_to_inpaint();
      } else if (typeof window.switch_to_img2img === 'function') {
        window.switch_to_img2img();
      }
      if (item) injectImageInto(item, sub === 'inpaint' ? 'img2maskimg' : 'img2img_image');
    }, 360);
  }

  function sendableText(item) {
    // A1111-style infotext (prompt + Steps: parameters) is the ideal payload;
    // for other sources (comic manifests, caption txt, ...) prefer the prompt.
    // The prompt part follows the source / compiled toggle.
    var infotext = item.infotext || '';
    var prompt = activePrompt(item);
    if (infotext && /(^|\n)Steps:\s*\d+/.test(infotext)) return variantInfotext(item);
    if (prompt) return prompt;
    return infotext;
  }

  function sendItemTo(item, action, opts) {
    var only = (opts && opts.only) || '';
    var path = item.path || item.alias_path || '';
    var text = sendableText(item);
    if (action === 'txt2img') {
      if (!text) { toast('No prompt / parameters to send', true); return; }
      if (!applyInfotext(text, 'txt2img')) return;
      setTimeout(function () { switchToTabByName('txt2img'); }, 200);
      toast('To txt2img');
    } else if (action === 'img2img') {
      if (only === 'prompt') {
        if (!applyPromptOnly(item)) return;
        goToImg2ImgSub('img2img');
        toast('To img2img \u2014 prompt + negative only');
      } else if (only === 'image_prompt') {
        if (!applyPromptOnly(item)) return;
        goToImg2ImgSub('img2img', item);
        toast('To img2img \u2014 image + prompt');
      } else if (only === 'all') {
        if (text && !applyInfotext(text, 'img2img')) return;
        goToImg2ImgSub('img2img', item);
        toast('To img2img \u2014 image + prompt + settings');
      } else {
        goToImg2ImgSub('img2img', item);
        toast('To img2img \u2014 image only');
      }
    } else if (action === 'inpaint') {
      if (only === 'prompt') {
        if (!applyPromptOnly(item)) return;
        goToImg2ImgSub('inpaint');
        toast('To inpaint \u2014 prompt + negative only');
      } else if (only === 'image_prompt') {
        if (!applyPromptOnly(item)) return;
        goToImg2ImgSub('inpaint', item);
        toast('To inpaint \u2014 image + prompt');
      } else if (only === 'all') {
        if (text && !applyInfotext(text, 'img2img')) return;
        goToImg2ImgSub('inpaint', item);
        toast('To inpaint \u2014 image + prompt + settings');
      } else {
        goToImg2ImgSub('inpaint', item);
        toast('To inpaint \u2014 image only');
      }
    } else if (action === 'composer') {
      if (!path) { toast('No file path on this item', true); return; }
      switchToTabByName('composer');
      setTimeout(function () {
        if (typeof window.composer_load_from_gallery !== 'function') {
          toast('Composer not available', true);
          return;
        }
        window.composer_load_from_gallery(path, '')
          .then(function () { toast('To Composer'); })
          .catch(function (err) { toast('Composer load failed: ' + ((err && err.message) || err), true); });
      }, 450);
    } else if (action === 'censor') {
      var url = path ? fileServeUrl(path) : (item.state !== 'trashed' ? blobUrl(item, 'preview') : '');
      if (!url) { toast('No media for this item', true); return; }
      switchToTabByName('censor');
      setTimeout(function () {
        if (window.censorPanel && window.censorPanel.openUrl) window.censorPanel.openUrl(url);
      }, 150);
      toast('To Censor');
    }
  }

  function sendItemByKey(key, action, opts) {
    api('/gallery/api/item?id=' + encodeURIComponent(key)).then(function (item) {
      sendItemTo(item, action, opts);
    }).catch(function (err) { toast('Item lookup failed: ' + err.message, true); });
  }

  var _ctxMenuEl = null;
  var _ctxSubEl = null;

  function ctxMenuOutside(ev) {
    var inSub = _ctxSubEl && _ctxSubEl.contains(ev.target);
    if (_ctxSubEl && !inSub) closeCtxSub();
    if (_ctxMenuEl && !inSub && !_ctxMenuEl.contains(ev.target)) closeCtxMenu();
  }

  function ctxMenuKey(ev) {
    if (ev.key !== 'Escape') return;
    if (_ctxSubEl) { closeCtxSub(); return; }
    closeCtxMenu();
  }

  function closeCtxSub() {
    if (!_ctxSubEl) return;
    _ctxSubEl.remove();
    _ctxSubEl = null;
    if (!_ctxMenuEl) {
      document.removeEventListener('mousedown', ctxMenuOutside, true);
      document.removeEventListener('keydown', ctxMenuKey, true);
    }
  }

  function closeCtxMenu() {
    closeCtxSub();
    if (!_ctxMenuEl) return;
    _ctxMenuEl.remove();
    _ctxMenuEl = null;
    document.removeEventListener('mousedown', ctxMenuOutside, true);
    document.removeEventListener('keydown', ctxMenuKey, true);
  }

  function bareSendAction(action) {
    return action === 'img2img' || action === 'inpaint';
  }

  // Right-click options for a send-to-img2img / send-to-inpaint entry: either
  // inject ONLY the image (keep prompt + parameters), send the image with the
  // item's prompt + negative prompt (no other settings), or apply ONLY the
  // item's prompt + negative prompt (no image, no other settings).
  function makeSendOptions(makeRun) {
    return [
      {
        id: 'prompt',
        label: '\u270E  Send prompt + negative only',
        title: 'Apply only the prompt and negative prompt \u2014 no image, no other settings',
        run: makeRun('prompt'),
      },
      {
        id: 'image_prompt',
        label: '\u{1F5BC}  Send image + prompt (no settings)',
        title: 'Send the image AND apply the prompt + negative prompt \u2014 no other settings',
        run: makeRun('image_prompt'),
      },
      {
        id: 'all',
        label: '\u{1F4E6}  Send all (image + prompt + settings)',
        title: 'Send the image AND apply the prompt + parameters (the old full send)',
        run: makeRun('all'),
      },
    ];
  }

  function openSendOptionsMenu(ev, options) {
    closeCtxSub();
    var sub = document.createElement('div');
    sub.className = 'gv2-ctx gv2-ctx-sub';
    options.forEach(function (opt) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.setAttribute('data-bare-send', opt.id);
      btn.textContent = opt.label;
      btn.title = opt.title;
      sub.appendChild(btn);
    });
    document.body.appendChild(sub);
    var w = sub.offsetWidth;
    var h = sub.offsetHeight;
    sub.style.left = Math.max(4, Math.min(ev.clientX, window.innerWidth - w - 6)) + 'px';
    sub.style.top = Math.max(4, Math.min(ev.clientY, window.innerHeight - h - 6)) + 'px';
    sub.addEventListener('click', function (e) {
      var pick = e.target.closest ? e.target.closest('[data-bare-send]') : null;
      if (!pick) return;
      closeCtxSub();
      var id = pick.getAttribute('data-bare-send');
      for (var i = 0; i < options.length; i++) {
        if (options[i].id === id) { options[i].run(); return; }
      }
    });
    _ctxSubEl = sub;
    document.addEventListener('mousedown', ctxMenuOutside, true);
    document.addEventListener('keydown', ctxMenuKey, true);
  }

  function openCtxMenu(ev, key) {
    closeCtxMenu();
    var menu = document.createElement('div');
    menu.className = 'gv2-ctx';
    SEND_ACTIONS.forEach(function (def) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.setAttribute('data-send', def[0]);
      btn.textContent = def[1];
      btn.title = def[2];
      menu.appendChild(btn);
    });
    document.body.appendChild(menu);
    var w = menu.offsetWidth;
    var h = menu.offsetHeight;
    menu.style.left = Math.max(4, Math.min(ev.clientX, window.innerWidth - w - 6)) + 'px';
    menu.style.top = Math.max(4, Math.min(ev.clientY, window.innerHeight - h - 6)) + 'px';
    menu.addEventListener('click', function (e) {
      var btn = e.target.closest ? e.target.closest('[data-send]') : null;
      if (!btn) return;
      closeCtxMenu();
      sendItemByKey(key, btn.getAttribute('data-send'));
    });
    menu.addEventListener('contextmenu', function (e) {
      var btn = e.target.closest ? e.target.closest('[data-send]') : null;
      if (!btn) return;
      var action = btn.getAttribute('data-send');
      if (!bareSendAction(action)) return;
      e.preventDefault();
      e.stopPropagation();
      openSendOptionsMenu(e, makeSendOptions(function (only) {
        return function () {
          closeCtxMenu();
          sendItemByKey(key, action, { only: only });
        };
      }));
    });
    _ctxMenuEl = menu;
    document.addEventListener('mousedown', ctxMenuOutside, true);
    document.addEventListener('keydown', ctxMenuKey, true);
  }

  function wireCtxMenu() {
    var grid = el('gv2-grid');
    if (!grid || grid.dataset.gv2Ctx === '1') return;
    grid.dataset.gv2Ctx = '1';
    grid.addEventListener('contextmenu', function (ev) {
      var card = ev.target.closest ? ev.target.closest('.gv2-card') : null;
      if (!card) return;
      var key = card.getAttribute('data-key');
      if (!key) return;
      ev.preventDefault();
      openCtxMenu(ev, key);
    });
    window.addEventListener('scroll', closeCtxMenu, { passive: true, capture: true });
    window.addEventListener('resize', closeCtxMenu);
  }

  function fmtSize(bytes) {
    if (!bytes) return '';
    if (bytes >= 1048576) return (bytes / 1048576).toFixed(1) + ' MB';
    if (bytes >= 1024) return (bytes / 1024).toFixed(0) + ' KB';
    return bytes + ' B';
  }

  function ratingOf(row) {
    var tags = row.tags || [];
    for (var i = 0; i < tags.length; i++) {
      if (tags[i].category === 'rating') return tags[i].name;
    }
    return '';
  }

  function workflowTagsOf(row) {
    var out = [];
    var tags = row.tags || [];
    for (var i = 0; i < tags.length; i++) {
      if (tags[i].category === 'workflow') out.push(tags[i].name);
    }
    return out;
  }

  function expiryText(row) {
    if (row.state !== 'archived' || !row.archive_expires_at) return '';
    var left = row.archive_expires_at - Date.now() / 1000;
    if (left <= 0) return 'expiring';
    var hours = Math.floor(left / 3600);
    var mins = Math.floor((left % 3600) / 60);
    return hours > 0 ? hours + 'h ' + mins + 'm left' : mins + 'm left';
  }

  function activeFilterCount() {
    var f = state.filters;
    var n = 0;
    if (f.q) n++;
    if (f.preset && f.preset !== 'all') n++;
    n += (f.states || []).length;
    n += (f.sources || []).length;
    if (f.rating) n++;
    n += (f.albums || []).length;
    if (f.show_albumed) n++;
    var tags = f.tags || {};
    Object.keys(tags).forEach(function (k) { n += (tags[k] || []).length; });
    if (f.min_width) n++;
    if (f.aspect) n++;
    if (f.since) n++;
    if (f.until) n++;
    return n;
  }

  // ---------------------------------------------------------------- chrome

  function chip(label, active, attrs) {
    return '<button class="gv2-chip' + (active ? ' gv2-chip-on' : '') + '" ' + (attrs || '') + '>' +
      esc(label) + '</button>';
  }

  function buildChrome(root) {
    root.innerHTML =
      '<div class="gv2-toolbar">' +
        '<div class="gv2-row gv2-keys" id="gv2-keys">' +
          '<span class="gv2-row-hint gv2-key-hint"><kbd>R</kbd> sync \u00B7 refresh \u00B7 clear filters</span>' +
          '<span class="gv2-row-hint gv2-key-hint"><kbd>S</kbd> toggle select mode</span>' +
        '</div>' +
        '<div class="gv2-row gv2-row-main">' +
          '<input id="gv2-q" class="gv2-search" type="search" spellcheck="false" ' +
            'placeholder="search: word, -exclude, &quot;phrase&quot;, tag:x, rating:endorsed, source:qwen, prompt:..., negative:...">' +
          '<select id="gv2-sort" class="gv2-select" title="Sort">' +
            SORTS.map(function (s) { return '<option value="' + s[0] + '">' + s[1] + '</option>'; }).join('') +
          '</select>' +
          '<select id="gv2-time" class="gv2-select" title="Time range">' +
            TIMES.map(function (t) { return '<option value="' + t[0] + '">' + t[1] + '</option>'; }).join('') +
          '</select>' +
          '<select id="gv2-rating" class="gv2-select" title="Rating">' +
            RATINGS.map(function (t) { return '<option value="' + t[0] + '">' + t[1] + '</option>'; }).join('') +
          '</select>' +
          '<select id="gv2-res" class="gv2-select" title="Resolution">' +
            RESOLUTIONS.map(function (t) { return '<option value="' + t[0] + '">' + t[1] + '</option>'; }).join('') +
          '</select>' +
          '<button id="gv2-sync" class="gv2-btn" title="Re-index output folders into the gallery store">Sync</button>' +
          '<button id="gv2-empty-trash" class="gv2-btn gv2-btn-danger" title="Permanently delete all trashed metadata rows">Empty Trash</button>' +
          '<button id="gv2-trash-disliked" class="gv2-btn gv2-btn-danger" title="Move every disliked item to trash (original files and media are deleted; metadata kept)">\u{1F5D1} Trash Disliked</button>' +
          '<button id="gv2-trash-archived" class="gv2-btn gv2-btn-danger" title="Move every archived item to trash (original files and media are deleted; metadata kept)">\u{1F5D1} Trash Archived</button>' +
          '<button id="gv2-archive-unrated" class="gv2-btn gv2-btn-danger" title="Archive every unrated active item, including albumed ones (staged items are kept; leaves the active view; auto-trashed after 24 h unless endorsed)">\u{1F4E6} Archive Unrated</button>' +
          '<button id="gv2-archive-current" class="gv2-btn gv2-btn-danger" title="Archive all items matching the current filter (leaves the active view; auto-trashed after 24 h unless endorsed)">\u{1F4E6} Archive Current</button>' +
        '</div>' +
        '<div class="gv2-row gv2-row-adv">' +
          '<span class="gv2-row-label">Options</span>' +
          '<select id="gv2-page-mode" class="gv2-select" title="How results load">' +
            '<option value="scroll">\u221E Infinite scroll</option>' +
            '<option value="pages">\u{1F4C4} Paged</option>' +
          '</select>' +
          '<select id="gv2-page-size" class="gv2-select" title="Items per page / per scroll batch">' +
            [24, 48, 60, 96, 120].map(function (v) { return '<option value="' + v + '">' + v + ' / page</option>'; }).join('') +
          '</select>' +
          '<select id="gv2-thumb-size" class="gv2-select" title="Thumbnail size">' +
            '<option value="xs">Thumb: Mini</option>' +
            '<option value="s">Thumb: Small</option>' +
            '<option value="m">Thumb: Medium</option>' +
            '<option value="l">Thumb: Large</option>' +
          '</select>' +
          '<span class="gv2-adv-sep"></span>' +
          '<span class="gv2-row-label">Date</span>' +
          '<input type="date" id="gv2-date-from" class="gv2-date" title="From date (inclusive)">' +
          '<span class="gv2-adv-dash">\u2013</span>' +
          '<input type="date" id="gv2-date-to" class="gv2-date" title="To date (inclusive)">' +
          '<button id="gv2-date-clear" class="gv2-btn gv2-btn-quiet" title="Clear the custom date range">\u2715 Clear dates</button>' +
        '</div>' +
        '<div class="gv2-row" id="gv2-states"></div>' +
        '<div class="gv2-row" id="gv2-groups"></div>' +
        '<div class="gv2-row gv2-albums" id="gv2-albums"></div>' +
        '<div class="gv2-row" id="gv2-sources"></div>' +
        '<div class="gv2-row" id="gv2-tags"></div>' +
        '<div class="gv2-row" id="gv2-views"></div>' +
        '<div class="gv2-row gv2-row-status">' +
          '<span id="gv2-count" class="gv2-count"></span>' +
          '<button id="gv2-select" class="gv2-btn gv2-btn-quiet" ' +
            'title="Select multiple items for batch operations (click cards or drag a selection box; shift-drag deselects, shift-click range)">Select</button>' +
          '<button id="gv2-clear" class="gv2-btn gv2-btn-quiet">Clear filters</button>' +
          '<button id="gv2-refresh" class="gv2-btn gv2-btn-quiet">Refresh</button>' +
        '</div>' +
      '</div>' +
      '<div class="gv2-row gv2-row-pager gv2-pager-hidden" id="gv2-pager">' +
        '<button id="gv2-prev" class="gv2-btn">\u2190 Prev</button>' +
        '<span id="gv2-page-info" class="gv2-page-info"></span>' +
        '<button id="gv2-next" class="gv2-btn">Next \u2192</button>' +
      '</div>' +
      '<div id="gv2-grid" class="gv2-grid"></div>' +
      '<div id="gv2-more-wrap" class="gv2-more-wrap"><button id="gv2-more" class="gv2-btn gv2-more">Load more</button></div>' +
      '<div id="gv2-batch" class="gv2-batch gv2-batch-hidden">' +
        '<span id="gv2-batch-count"></span>' +
        '<button class="gv2-btn gv2-btn-quiet" data-batch="selectpage" title="Select all items currently loaded in the grid">Select shown</button>' +
        '<button class="gv2-btn" data-batch="endorse">Endorse</button>' +
        '<button class="gv2-btn" data-batch="dislike">Dislike</button>' +
        '<button class="gv2-btn" data-batch="archive">Archive</button>' +
        '<button class="gv2-btn" data-batch="unarchive">Unarchive</button>' +
        '<button class="gv2-btn" data-batch="stage">Stage</button>' +
        '<button class="gv2-btn" data-batch="unstage">Unstage</button>' +
        '<button class="gv2-btn" data-batch="album">Album\u2026</button>' +
        '<button class="gv2-btn" data-batch="copy-censored" title="Copy the selected original images to outputs/censored for publishing">\u{1F4E4} Copy to Censored</button>' +
        '<button class="gv2-btn gv2-btn-danger" data-batch="trash">Trash</button>' +
        '<button class="gv2-btn gv2-btn-quiet" data-batch="clear">Clear</button>' +
      '</div>' +
      '<div id="gv2-detail" class="gv2-detail gv2-detail-hidden"></div>' +
      '<div id="gv2-toast" class="gv2-toast gv2-toast-hidden"></div>' +
      '<button id="gv2-top" class="gv2-top gv2-top-hidden" title="Back to top">\u2191</button>';

    el('gv2-q').addEventListener('input', debounce(function () {
      state.filters.q = el('gv2-q').value.trim();
      resetAndRefresh();
    }, 350));
    el('gv2-sort').addEventListener('change', function () {
      state.sort = el('gv2-sort').value; resetAndRefresh();
    });
    el('gv2-time').addEventListener('change', function () {
      state.filters.preset = el('gv2-time').value; resetAndRefresh();
    });
    el('gv2-rating').addEventListener('change', function () {
      state.filters.rating = el('gv2-rating').value; resetAndRefresh();
    });
    el('gv2-res').addEventListener('change', function () {
      applyResolution(el('gv2-res').value); resetAndRefresh();
    });
    el('gv2-clear').addEventListener('click', clearFilters);
    el('gv2-refresh').addEventListener('click', function () { refreshFacets(); resetAndRefresh(); });
    el('gv2-select').addEventListener('click', function () { setSelectMode(!state.selectMode); });
    el('gv2-top').addEventListener('click', function () {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
    el('gv2-more').addEventListener('click', function () { loadPage(true); });
    el('gv2-sync').addEventListener('click', function () { runMaintenance('reindex', 'Sync'); });
    el('gv2-empty-trash').addEventListener('click', function () {
      confirmMaintenance('empty_trash', 'Empty trash', function (n) {
        return 'Permanently delete ' + n + ' trashed item(s)?\n\n' +
          'Their metadata rows are removed for good \u2014 this cannot be undone.';
      });
    });
    el('gv2-trash-disliked').addEventListener('click', function () {
      confirmMaintenance('trash_disliked', 'Trash disliked', function (n) {
        return 'Move ' + n + ' disliked item(s) to trash?\n\n' +
          'Original files and cached media will be DELETED (metadata kept).';
      });
    });
    el('gv2-trash-archived').addEventListener('click', function () {
      confirmMaintenance('trash_archived', 'Trash archived', function (n) {
        return 'Move ' + n + ' archived item(s) to trash?\n\n' +
          'Original files and cached media will be DELETED (metadata kept).';
      });
    });
    el('gv2-archive-unrated').addEventListener('click', function () {
      confirmMaintenance('archive_unrated', 'Archive unrated', function (n) {
        return 'Archive ' + n + ' unrated active item(s) (all sources, albumed included; staged kept)?\n\n' +
          'Archived items leave the active view; the sweeper auto-trashes them after 24 h unless endorsed.';
      });
    });
    el('gv2-archive-current').addEventListener('click', function () {
      confirmMaintenance('archive_filtered', 'Archive current', function (n) {
        return 'Archive ALL ' + n + ' item(s) matching the current filter?\n\n' +
          'Archived items leave the active view; the sweeper auto-trashes them after 24 h unless endorsed.';
      }, function () { return { filters: state.filters }; });
    });
    el('gv2-page-mode').value = state.pageMode;
    el('gv2-page-size').value = String(state.pageSize);
    el('gv2-thumb-size').value = state.thumbSize;
    el('gv2-page-mode').addEventListener('change', function () {
      state.pageMode = el('gv2-page-mode').value === 'pages' ? 'pages' : 'scroll';
      savePrefs();
      resetAndRefresh();
    });
    el('gv2-page-size').addEventListener('change', function () {
      var size = parseInt(el('gv2-page-size').value, 10);
      state.pageSize = size >= 12 ? size : PAGE;
      savePrefs();
      resetAndRefresh();
    });
    el('gv2-thumb-size').addEventListener('change', function () {
      state.thumbSize = el('gv2-thumb-size').value || 'm';
      savePrefs();
      applyThumbSize();
    });
    el('gv2-date-from').addEventListener('change', applyDateRange);
    el('gv2-date-to').addEventListener('change', applyDateRange);
    el('gv2-date-clear').addEventListener('click', function () {
      el('gv2-date-from').value = '';
      el('gv2-date-to').value = '';
      delete state.filters.since;
      delete state.filters.until;
      resetAndRefresh();
    });
    el('gv2-prev').addEventListener('click', function () { goPage(-1); });
    el('gv2-next').addEventListener('click', function () { goPage(1); });
    el('gv2-batch').addEventListener('click', function (ev) {
      var action = ev.target && ev.target.getAttribute ? ev.target.getAttribute('data-batch') : null;
      if (!action) return;
      if (action === 'clear') { setSelection([]); return; }
      if (action === 'selectpage') { selectPage(); return; }
      if (action === 'copy-censored') { copySelectedToCensored(); return; }
      if (action === 'album') {
        if (!state.selected.size) { toast('Select items first', true); return; }
        openAlbumForm();
        return;
      }
      var keys = Array.from(state.selected);
      if (action === 'trash' && !window.confirm('Trash ' + keys.length + ' item(s)? The original files and media will be deleted (metadata kept).')) return;
      runAction(action, keys).then(function (data) {
        if (data && (data.changed || []).length) setSelection([]);
      });
    });
  }

  function applyResolution(value) {
    delete state.filters.min_width;
    delete state.filters.aspect;
    if (value === 'min1024') state.filters.min_width = 1024;
    else if (value === 'min2048') state.filters.min_width = 2048;
    else if (value) state.filters.aspect = value;
  }

  function debounce(fn, ms) {
    var t = null;
    return function () { clearTimeout(t); t = setTimeout(fn, ms); };
  }

  // ---------------------------------------------------------------- facets

  function refreshFacets() {
    refreshAlbums();
    return api('/gallery/api/facets').then(function (facets) {
      state.facets = facets;
      renderFacetChips();
      renderGroupChips();
      renderStateChips();
    });
  }

  function refreshViews() {
    return api('/gallery/api/views').then(function (data) {
      state.views = (data && data.views) || [];
      renderViews();
    }).catch(function () { renderViews(); });
  }

  function refreshAlbums() {
    return api('/gallery/api/albums').then(function (data) {
      state.albums = (data && data.albums) || [];
      renderAlbums();
    }).catch(function () { renderAlbums(); });
  }

  function albumById(id) {
    var list = state.albums || [];
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === id) return list[i];
    }
    return null;
  }

  function renderAlbums() {
    var box = el('gv2-albums');
    if (!box) return;
    var list = state.albums || [];
    var activeIds = (state.filters.albums || []).filter(function (v) { return typeof v === 'number'; });
    var html = '<div class="gv2-albums-head"><span class="gv2-row-label">Albums</span>';
    var noneActive = (state.filters.albums || []).indexOf('none') >= 0;
    html += countChip('No album', null, noneActive, 'data-album="none" title="items not in any album"');
    html += countChip('Show albumed', null, !!state.filters.show_albumed,
      'data-album-toggle="1" title="Include items that belong to an album (hidden by default; album views show them anyway)"');
    html += '<button class="gv2-btn gv2-btn-quiet" id="gv2-new-album" title="Create an album">+ New album</button>';
    if (activeIds.length === 1) {
      var album = albumById(activeIds[0]);
      if (album) {
        if (album.bundled) {
          html += '<button class="gv2-btn" data-album-act="unbundle" title="Restore originals from the archive">Unbundle</button>';
        } else {
          html += '<button class="gv2-btn" data-album-act="bundle" title="Compress originals into one archive (previews stay viewable)">Bundle</button>';
        }
        html += '<button class="gv2-btn gv2-btn-quiet" data-album-act="rename" title="Rename album">Rename</button>';
        html += '<button class="gv2-btn gv2-btn-danger" data-album-act="delete" title="Delete album (items stay in the gallery)">Delete</button>';
      }
    }
    html += '<span id="gv2-album-create" class="gv2-save-form gv2-save-hidden">' +
      '<input id="gv2-album-create-name" class="gv2-view-name" placeholder="album name\u2026" maxlength="80" spellcheck="false">' +
      '<button class="gv2-btn" id="gv2-album-create-ok">Create</button>' +
      '<button class="gv2-btn gv2-btn-quiet" id="gv2-album-create-cancel">Cancel</button></span>';
    html += '<span id="gv2-album-form" class="gv2-save-form gv2-save-hidden">' +
      '<select id="gv2-album-pick" class="gv2-select" title="Target album"><option value="">new album\u2026</option></select>' +
      '<input id="gv2-album-new" class="gv2-view-name" placeholder="new album name\u2026" maxlength="80" spellcheck="false">' +
      '<button class="gv2-btn" id="gv2-album-apply">Add selected</button>' +
      '<button class="gv2-btn gv2-btn-quiet" id="gv2-album-remove" title="Remove selected items from the picked album">Remove selected</button>' +
      '<button class="gv2-btn gv2-btn-quiet" id="gv2-album-cancel">Cancel</button></span>';
    html += '</div>';
    var cards = '';
    list.forEach(function (album) {
      var active = activeIds.indexOf(album.id) >= 0;
      var title = album.bundled
        ? 'bundled album \u00b7 originals in archive \u00b7 ' + fmtSize(album.bundle_size)
        : 'album \u00b7 click to filter';
      var media = album.cover
        ? '<img class="gv2-album-cover" loading="lazy" src="' + blobUrl({ uid: album.cover }, 'thumb') + '" alt="">'
        : '<span class="gv2-album-card-empty">\u{1F4C1}</span>';
      cards += '<button class="gv2-album-card' + (active ? ' gv2-album-card-on' : '') + '" data-album="' + album.id + '" title="' + esc(title) + '">' +
        '<span class="gv2-album-card-media">' + media + '</span>' +
        '<span class="gv2-album-card-info">' +
          '<span class="gv2-album-card-name">' + esc(album.name) + (album.bundled ? ' \u{1F4E6}' : '') + '</span>' +
          '<span class="gv2-album-card-n">' + (album.count || 0) + '</span>' +
        '</span></button>';
    });
    html += '<div class="gv2-album-grid">' + cards + '</div>';
    box.innerHTML = html;

    var pick = el('gv2-album-pick');
    if (pick) {
      list.forEach(function (album) {
        var opt = document.createElement('option');
        opt.value = String(album.id);
        opt.textContent = album.name;
        pick.appendChild(opt);
      });
      if (activeIds.length === 1) pick.value = String(activeIds[0]);
    }
    var newBtn = el('gv2-new-album');
    if (newBtn) {
      newBtn.addEventListener('click', function () {
        var form = el('gv2-album-create');
        if (!form) return;
        form.classList.remove('gv2-save-hidden');
        var input = el('gv2-album-create-name');
        if (input) input.focus();
      });
    }
    var createOk = el('gv2-album-create-ok');
    if (createOk) createOk.addEventListener('click', createAlbumFlow);
    var createCancel = el('gv2-album-create-cancel');
    if (createCancel) {
      createCancel.addEventListener('click', function () {
        var form = el('gv2-album-create');
        if (form) form.classList.add('gv2-save-hidden');
      });
    }
    var createInput = el('gv2-album-create-name');
    if (createInput) {
      createInput.addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter') createAlbumFlow();
      });
    }
    var applyBtn = el('gv2-album-apply');
    if (applyBtn) applyBtn.addEventListener('click', applyAlbumForm);
    var removeBtn = el('gv2-album-remove');
    if (removeBtn) removeBtn.addEventListener('click', removeAlbumForm);
    var cancelBtn = el('gv2-album-cancel');
    if (cancelBtn) cancelBtn.addEventListener('click', hideAlbumForm);
  }

  function openAlbumForm() {
    renderAlbums();
    var form = el('gv2-album-form');
    if (!form) return;
    form.classList.remove('gv2-save-hidden');
    var input = el('gv2-album-new');
    if (input) input.focus();
  }

  function hideAlbumForm() {
    var form = el('gv2-album-form');
    if (form) form.classList.add('gv2-save-hidden');
  }

  function createAlbumFlow() {
    var input = el('gv2-album-create-name');
    var name = input ? input.value.trim() : '';
    if (!name) { toast('Album name required', true); return; }
    api('/gallery/api/albums', { name: name }).then(function (data) {
      state.albums = (data && data.albums) || [];
      renderAlbums();
      toast('album created: ' + name);
    }).catch(function (err) { toast('Create failed: ' + err.message, true); });
  }

  function applyAlbumForm() {
    if (!state.selected.size) { toast('Select items first', true); return; }
    var keys = Array.from(state.selected);
    var pick = el('gv2-album-pick');
    var newName = el('gv2-album-new').value.trim();
    var body = { add: keys, remove: [] };
    if (newName) body.new_name = newName;
    else if (pick && pick.value) body.album = parseInt(pick.value, 10);
    if (!body.new_name && !body.album) { toast('Pick an album or name a new one', true); return; }
    api('/gallery/api/albums/items', body).then(function (data) {
      state.albums = (data && data.albums) || [];
      renderAlbums();
      var msg = 'added ' + (data.added || 0);
      if (data.moved && data.moved.length) msg += ' (moved from ' + data.moved[0].from + ')'; 
      if (data.errors && data.errors.length) msg += ' \u00b7 ' + data.errors.length + ' failed';
      toast(msg);
      hideAlbumForm();
      if (!(data.errors && data.errors.length)) setSelection([]);
      resetAndRefresh();
    }).catch(function (err) { toast('Album add failed: ' + err.message, true); });
  }

  function removeAlbumForm() {
    if (!state.selected.size) { toast('Select items first', true); return; }
    var pick = el('gv2-album-pick');
    if (!pick || !pick.value) { toast('Pick an album to remove from', true); return; }
    var keys = Array.from(state.selected);
    api('/gallery/api/albums/items', { album: parseInt(pick.value, 10), add: [], remove: keys })
      .then(function (data) {
        state.albums = (data && data.albums) || [];
        renderAlbums();
        toast('removed ' + (data.removed || 0) + ' from album');
        hideAlbumForm();
        setSelection([]);
        resetAndRefresh();
      })
      .catch(function (err) { toast('Remove failed: ' + err.message, true); });
  }

  function albumAction(act) {
    var activeIds = (state.filters.albums || []).filter(function (v) { return typeof v === 'number'; });
    if (activeIds.length !== 1) return;
    var album = albumById(activeIds[0]);
    if (!album) return;
    if (act === 'bundle') {
      if (!window.confirm('Bundle album "' + album.name + '"? Originals move into one compressed archive; ' +
        'thumbnails and previews stay viewable, but original files need an unbundle first.')) return;
      toast('bundling ' + album.name + '\u2026');
      api('/gallery/api/albums/bundle', { album: album.id }).then(function (data) {
        state.albums = (data && data.albums) || [];
        renderAlbums();
        var msg = 'bundled ' + (data.bundled || 0) + ' item(s) \u00b7 ' + fmtSize(data.bytes || 0);
        if (data.skipped && data.skipped.length) msg += ' \u00b7 skipped ' + data.skipped.length;
        toast(msg);
        resetAndRefresh();
      }).catch(function (err) { toast('Bundle failed: ' + err.message, true); });
      return;
    }
    if (act === 'unbundle') {
      if (!window.confirm('Unbundle "' + album.name + '"? All originals are restored from the archive.')) return;
      toast('unbundling ' + album.name + '\u2026');
      api('/gallery/api/albums/unbundle', { album: album.id }).then(function (data) {
        state.albums = (data && data.albums) || [];
        renderAlbums();
        var msg = 'unbundled \u00b7 restored ' + (data.restored || 0) + ' file(s)';
        if (data.skipped && data.skipped.length) msg += ' \u00b7 skipped ' + data.skipped.length;
        toast(msg);
        resetAndRefresh();
      }).catch(function (err) { toast('Unbundle failed: ' + err.message, true); });
      return;
    }
    if (act === 'delete') {
      if (!window.confirm('Delete album "' + album.name + '"? Items stay in the gallery.')) return;
      api('/gallery/api/albums/delete', { album: album.id }).then(function (data) {
        state.albums = (data && data.albums) || [];
        state.filters.albums = (state.filters.albums || []).filter(function (v) { return v !== album.id; });
        syncControlsFromFilters();
        resetAndRefresh();
        toast('album deleted: ' + album.name);
      }).catch(function (err) { toast('Delete failed: ' + err.message, true); });
      return;
    }
    if (act === 'rename') {
      var name = window.prompt('Rename album "' + album.name + '" to:', album.name);
      if (!name || !name.trim()) return;
      api('/gallery/api/albums/rename', { album: album.id, new_name: name.trim() }).then(function (data) {
        state.albums = (data && data.albums) || [];
        renderAlbums();
        toast('album renamed');
      }).catch(function (err) { toast('Rename failed: ' + err.message, true); });
    }
  }

  function toggleAlbumFilter(value) {
    if (!state.filters.albums) state.filters.albums = [];
    var entry = value === 'none' ? 'none' : parseInt(value, 10);
    var idx = state.filters.albums.indexOf(entry);
    if (idx >= 0) state.filters.albums.splice(idx, 1);
    else state.filters.albums.push(entry);
    syncControlsFromFilters();
    resetAndRefresh();
  }

  function countChip(label, count, active, attr) {
    var badge = (count === null || count === undefined) ? '' : ' <span class="gv2-chip-n">' + count + '</span>';
    return '<button class="gv2-chip' + (active ? ' gv2-chip-on' : '') + '" ' + attr + '>' + esc(label) + badge + '</button>';
  }

  function renderStateChips() {
    var box = el('gv2-states');
    if (!box || !state.facets) return;
    var totals = (state.facets.states) || {};
    var total = 0;
    Object.keys(totals).forEach(function (k) { total += totals[k]; });
    var html = '';
    STATES.forEach(function (entry) {
      var active;
      if (entry[0] === '') active = (state.filters.states || []).length === 0;
      else active = (state.filters.states || []).indexOf(entry[0]) >= 0;
      var count = entry[0] === '' ? total : (totals[entry[0]] || 0);
      html += countChip(entry[1], count, active, 'data-state="' + entry[0] + '"');
    });
    box.innerHTML = html;
  }

  function renderFacetChips() {
    var srcBox = el('gv2-sources');
    if (!srcBox || !state.facets) return;
    var html = '<span class="gv2-row-label">Sources</span>';
    (state.facets.sources || []).forEach(function (src) {
      var active = (state.filters.sources || []).indexOf(src.id) >= 0;
      html += countChip(src.label, src.count, active, 'data-source="' + esc(src.id) + '"');
    });
    srcBox.innerHTML = html;

    var tagBox = el('gv2-tags');
    if (tagBox) {
      var tags = (state.facets.workflow_tags || []).slice(0, 24);
      var html2 = '<span class="gv2-row-label">Tags</span>';
      tags.forEach(function (tag) {
        var active = ((state.filters.tags || {}).workflow || []).indexOf(tag.name) >= 0;
        html2 += countChip(tag.name, tag.count, active, 'data-tag="' + esc(tag.name) + '"');
      });
      html2 += '<span class="gv2-row-hint">' + (state.facets.caption_tags || 0) + ' caption tags indexed (search with tag:name)</span>';
      tagBox.innerHTML = html2;
    }
  }

  function renderGroupChips() {
    var box = el('gv2-groups');
    if (!box || !state.facets) return;
    var html = '<span class="gv2-row-label">Quick filters</span>';
    (state.facets.groups || []).forEach(function (group) {
      var emoji = GROUP_EMOJI[group.id];
      html += countChip((emoji ? emoji + ' ' : '') + group.label, group.count, groupActive(group),
        'data-group="' + esc(group.id) + '" title="' + esc(groupFilterText(group)) + '"');
    });
    box.innerHTML = html;
  }

  function groupFilterText(group) {
    var f = group.filter || {};
    var parts = [];
    Object.keys(f).forEach(function (k) {
      var v = f[k];
      parts.push(k + '=' + (Array.isArray(v) ? v.join('+') : v));
    });
    return parts.join(' & ');
  }

  function groupActive(group) {
    var f = group.filter || {};
    var keys = Object.keys(f);
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      var want = f[k];
      var cur = state.filters[k];
      if (Array.isArray(want)) {
        if (!Array.isArray(cur) || cur.length !== want.length) return false;
        for (var j = 0; j < want.length; j++) {
          if (cur.indexOf(want[j]) < 0) return false;
        }
      } else if ((k === 'preset' ? (cur || 'all') : cur) !== want) {
        return false;
      }
    }
    return true;
  }

  function toggleGroup(group) {
    var keys = Object.keys(group.filter || {});
    if (groupActive(group)) {
      keys.forEach(function (k) { delete state.filters[k]; });
    } else {
      keys.forEach(function (k) {
        var v = group.filter[k];
        state.filters[k] = Array.isArray(v) ? v.slice() : v;
      });
    }
    syncControlsFromFilters();
    resetAndRefresh();
  }

  function syncControlsFromFilters() {
    var f = state.filters || {};
    var q = el('gv2-q');
    if (q) q.value = f.q || '';
    var time = el('gv2-time');
    if (time) time.value = f.preset || 'all';
    var rating = el('gv2-rating');
    if (rating) rating.value = f.rating || '';
    var res = el('gv2-res');
    if (res) {
      var value = '';
      if (f.aspect) value = f.aspect;
      else if (f.min_width === 1024) value = 'min1024';
      else if (f.min_width === 2048) value = 'min2048';
      res.value = value;
    }
    var from = el('gv2-date-from');
    if (from) from.value = dateInputValue(f.since);
    var to = el('gv2-date-to');
    if (to) to.value = dateInputValue(f.until);
    renderStateChips();
    renderGroupChips();
    renderAlbums();
    renderFacetChips();
  }

  function canonFilters(f) {
    f = f || {};
    var tags = {};
    Object.keys(f.tags || {}).sort().forEach(function (k) {
      var v = f.tags[k];
      tags[k] = Array.isArray(v) ? v.slice().sort() : v;
    });
    return JSON.stringify({
      q: f.q || '',
      preset: f.preset || 'all',
      states: (f.states || []).slice().sort(),
      sources: (f.sources || []).slice().sort(),
      albums: (f.albums || []).map(String).sort(),
      show_albumed: f.show_albumed ? 1 : 0,
      rating: f.rating || '',
      tags: tags,
      min_width: f.min_width || 0,
      aspect: f.aspect || '',
      since: f.since || null,
      until: f.until || null
    });
  }

  function viewIsActive(view) {
    if (!view || !view.filters) return false;
    if ((view.sort || 'time_desc') !== (state.sort || 'time_desc')) return false;
    return canonFilters(view.filters) === canonFilters(state.filters);
  }

  function renderViews() {
    var box = el('gv2-views');
    if (!box) return;
    var html = '<span class="gv2-row-label">Saved filters</span>';
    html += '<button class="gv2-btn gv2-btn-quiet" id="gv2-save-view" ' +
      'title="Save the current filter combination for one-click reuse">Save current</button>';
    (state.views || []).forEach(function (view) {
      html += '<span class="gv2-view-chip">' +
        '<button class="gv2-chip' + (viewIsActive(view) ? ' gv2-chip-on' : '') + '" data-view="' + esc(view.name) + '" title="Apply saved filter">' + esc(view.name) + '</button>' +
        '<button class="gv2-view-x" data-view-del="' + esc(view.name) + '" title="Delete saved filter">\u00d7</button>' +
        '</span>';
    });
    if (!(state.views || []).length) {
      html += '<span class="gv2-row-hint">combine any filters above, then save them here</span>';
    }
    html += '<span id="gv2-save-form" class="gv2-save-form gv2-save-hidden">' +
      '<input id="gv2-view-name" class="gv2-view-name" placeholder="filter name\u2026" maxlength="60" spellcheck="false">' +
      '<button class="gv2-btn" id="gv2-view-ok">Save</button>' +
      '<button class="gv2-btn gv2-btn-quiet" id="gv2-view-cancel">Cancel</button></span>';
    box.innerHTML = html;

    var saveBtn = el('gv2-save-view');
    if (saveBtn) {
      saveBtn.addEventListener('click', function () {
        var form = el('gv2-save-form');
        if (!form) return;
        form.classList.remove('gv2-save-hidden');
        var input = el('gv2-view-name');
        if (input) input.focus();
      });
    }
    var okBtn = el('gv2-view-ok');
    if (okBtn) okBtn.addEventListener('click', saveCurrentView);
    var cancelBtn = el('gv2-view-cancel');
    if (cancelBtn) {
      cancelBtn.addEventListener('click', function () {
        var form = el('gv2-save-form');
        if (form) form.classList.add('gv2-save-hidden');
      });
    }
    var nameInput = el('gv2-view-name');
    if (nameInput) {
      nameInput.addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter') saveCurrentView();
      });
    }
  }

  function saveCurrentView() {
    var input = el('gv2-view-name');
    var name = input ? input.value.trim() : '';
    if (!name) { toast('Filter name required', true); return; }
    api('/gallery/api/views', { name: name, filters: state.filters, sort: state.sort })
      .then(function (data) {
        state.views = (data && data.views) || [];
        renderViews();
        toast('Filter saved: ' + name);
      })
      .catch(function (err) { toast('Save failed: ' + err.message, true); });
  }

  function applyView(name) {
    var view = (state.views || []).filter(function (v) { return v.name === name; })[0];
    if (!view) return;
    var filters = view.filters || {};
    state.filters = {
      q: filters.q || '',
      preset: filters.preset || 'all',
      states: Array.isArray(filters.states) ? filters.states.slice() : [],
      sources: Array.isArray(filters.sources) ? filters.sources.slice() : [],
      albums: Array.isArray(filters.albums) ? filters.albums.slice() : [],
      show_albumed: !!filters.show_albumed,
      rating: filters.rating || '',
      tags: filters.tags && typeof filters.tags === 'object' ? filters.tags : {}
    };
    if (filters.min_width !== undefined) state.filters.min_width = filters.min_width;
    if (filters.aspect !== undefined) state.filters.aspect = filters.aspect;
    if (filters.since) state.filters.since = filters.since;
    if (filters.until) state.filters.until = filters.until;
    state.sort = view.sort || 'time_desc';
    var sortSelect = el('gv2-sort');
    if (sortSelect) sortSelect.value = state.sort;
    syncControlsFromFilters();
    resetAndRefresh();
    toast('Filter applied: ' + name);
  }

  function deleteView(name) {
    if (!window.confirm('Delete saved filter "' + name + '"?')) return;
    api('/gallery/api/views/delete', { name: name })
      .then(function (data) {
        state.views = (data && data.views) || [];
        renderViews();
        toast('Filter deleted: ' + name);
      })
      .catch(function (err) { toast('Delete failed: ' + err.message, true); });
  }

  function wireChips(root) {
    root.addEventListener('click', function (ev) {
      var albumAct = ev.target.closest ? ev.target.closest('[data-album-act]') : null;
      if (albumAct) { albumAction(albumAct.getAttribute('data-album-act')); return; }
      var delBtn = ev.target.closest ? ev.target.closest('[data-view-del]') : null;
      if (delBtn) { deleteView(delBtn.getAttribute('data-view-del')); return; }
      var target = ev.target.closest ? ev.target.closest('.gv2-chip, .gv2-album-card') : null;
      if (!target) return;
      var view = target.getAttribute('data-view');
      if (view !== null) { applyView(view); return; }
      var albumToggle = target.getAttribute('data-album-toggle');
      if (albumToggle !== null) {
        state.filters.show_albumed = !state.filters.show_albumed;
        syncControlsFromFilters();
        resetAndRefresh();
        return;
      }
      var albumRef = target.getAttribute('data-album');
      if (albumRef !== null) { toggleAlbumFilter(albumRef); return; }
      var groupId = target.getAttribute('data-group');
      if (groupId !== null) {
        var group = ((state.facets || {}).groups || []).filter(function (g) { return g.id === groupId; })[0];
        if (group) toggleGroup(group);
        return;
      }
      var st = target.getAttribute('data-state');
      var src = target.getAttribute('data-source');
      var tag = target.getAttribute('data-tag');
      if (st !== null) {
        state.filters.states = st ? [st] : [];
        resetAndRefresh();
      } else if (src !== null) {
        toggleIn(state.filters, 'sources', src);
        resetAndRefresh();
      } else if (tag !== null) {
        if (!state.filters.tags) state.filters.tags = {};
        if (!state.filters.tags.workflow) state.filters.tags.workflow = [];
        toggleIn(state.filters.tags, 'workflow', tag);
        resetAndRefresh();
      }
    });
  }

  function toggleIn(obj, key, value) {
    if (!obj[key]) obj[key] = [];
    var idx = obj[key].indexOf(value);
    if (idx >= 0) obj[key].splice(idx, 1); else obj[key].push(value);
  }

  // ---------------------------------------------------------------- prefs

  var PREFS_KEY = 'gv2.prefs.v1';

  function loadPrefs() {
    try {
      var raw = window.localStorage && window.localStorage.getItem(PREFS_KEY);
      if (!raw) return;
      var prefs = JSON.parse(raw) || {};
      if (prefs.pageMode === 'pages' || prefs.pageMode === 'scroll') state.pageMode = prefs.pageMode;
      var size = parseInt(prefs.pageSize, 10);
      if (size >= 12 && size <= 500) state.pageSize = size;
      if (prefs.thumbSize === 'xs' || prefs.thumbSize === 's' || prefs.thumbSize === 'm' || prefs.thumbSize === 'l') state.thumbSize = prefs.thumbSize;
      if (prefs.detailMediaLeft === true) state.detailMediaLeft = true;
      if (prefs.promptVariant === 'compiled') state.promptVariant = 'compiled';
    } catch (err) { /* ignore bad prefs */ }
  }

  function savePrefs() {
    try {
      window.localStorage.setItem(PREFS_KEY, JSON.stringify({
        pageMode: state.pageMode,
        pageSize: state.pageSize,
        thumbSize: state.thumbSize,
        detailMediaLeft: !!state.detailMediaLeft,
        promptVariant: state.promptVariant === 'compiled' ? 'compiled' : 'source'
      }));
    } catch (err) { /* ignore */ }
  }

  function applyThumbSize() {
    var root = el(ROOT_ID);
    if (!root) return;
    ['xs', 's', 'm', 'l'].forEach(function (k) { root.classList.remove('gv2-thumb-' + k); });
    root.classList.add('gv2-thumb-' + (state.thumbSize || 'm'));
  }

  function dateInputValue(ts) {
    if (!ts) return '';
    var d = new Date(ts * 1000);
    var m = ('0' + (d.getMonth() + 1)).slice(-2);
    var day = ('0' + d.getDate()).slice(-2);
    return d.getFullYear() + '-' + m + '-' + day;
  }

  function parseDateInput(value, endOfDay) {
    if (!value) return null;
    var ts = Date.parse(value + (endOfDay ? 'T23:59:59' : 'T00:00:00'));
    return isNaN(ts) ? null : Math.floor(ts / 1000);
  }

  function applyDateRange() {
    var from = parseDateInput(el('gv2-date-from').value, false);
    var to = parseDateInput(el('gv2-date-to').value, true);
    if (from) state.filters.since = from; else delete state.filters.since;
    if (to) state.filters.until = to; else delete state.filters.until;
    resetAndRefresh();
  }

  function updatePager() {
    var row = el('gv2-pager');
    if (!row) return;
    var paged = state.pageMode === 'pages';
    row.classList.toggle('gv2-pager-hidden', !paged);
    if (!paged) return;
    var pages = Math.max(1, Math.ceil(state.total / (state.pageSize || PAGE)));
    var info = el('gv2-page-info');
    if (info) info.textContent = state.total + ' item(s) \u00b7 page ' + state.page + ' / ' + pages;
    var prev = el('gv2-prev');
    var next = el('gv2-next');
    if (prev) prev.disabled = state.page <= 1;
    if (next) next.disabled = state.page >= pages;
  }

  function goPage(delta) {
    var pages = Math.max(1, Math.ceil(state.total / (state.pageSize || PAGE)));
    var target = Math.min(Math.max(1, state.page + delta), pages);
    if (target === state.page) return;
    state.page = target;
    loadPage(false).then(function () {
      var grid = el('gv2-grid');
      if (grid && grid.scrollIntoView) grid.scrollIntoView({ block: 'start' });
    });
  }

  // ---------------------------------------------------------------- query

  /** Reset every filter control to its neutral value (no grid reload). */
  function resetFiltersState() {
    state.filters = { q: '', preset: 'all', states: [], sources: [], albums: [], show_albumed: false, rating: '', tags: {} };
    var q = el('gv2-q');
    if (q) q.value = '';
    var time = el('gv2-time');
    if (time) time.value = 'all';
    var rating = el('gv2-rating');
    if (rating) rating.value = '';
    var res = el('gv2-res');
    if (res) res.value = '';
    syncControlsFromFilters();
  }

  function clearFilters() {
    resetFiltersState();
    resetAndRefresh();
  }

  function resetAndRefresh() {
    state.page = 1;
    state.offset = 0;
    state.rows = [];
    renderViews();
    loadPage(false);
  }

  function loadPage(append) {
    if (state.busy) return Promise.resolve();
    state.busy = true;
    var limit = state.pageSize || PAGE;
    var offset;
    if (append) offset = state.rows.length;
    else if (state.pageMode === 'pages') offset = Math.max(0, (state.page - 1) * limit);
    else offset = 0;
    var payload = state.filters;
    payload.limit = limit;
    payload.offset = offset;
    return api('/gallery/api/query', { filters: payload, sort: state.sort, limit: limit, offset: offset })
      .then(function (data) {
        state.total = data.total;
        state.stateTotals = data.state_totals || {};
        if (append) {
          state.rows = state.rows.concat(data.rows);
        } else {
          state.rows = data.rows;
          var grid = el('gv2-grid');
          if (grid) grid.innerHTML = '';
        }
        state.offset = state.rows.length;
        renderRows(data.rows, append);
        updateCountLine();
        renderStateChips();
        updatePager();
        var more = el('gv2-more-wrap');
        if (more) {
          var done = state.rows.length >= state.total || state.pageMode !== 'scroll';
          if (done) more.classList.add('gv2-more-hidden');
          else more.classList.remove('gv2-more-hidden');
        }
        state.loadedOnce = true;
      })
      .catch(function (err) { toast('Query failed: ' + err.message, true); })
      .finally(function () {
        state.busy = false;
        setTimeout(autoLoadCheck, 60);
      });
  }

  function updateCountLine() {
    var line = el('gv2-count');
    if (!line) return;
    var parts = [state.total + ' item(s)'];
    if (activeFilterCount() > 0) parts.push(activeFilterCount() + ' filter(s)');
    if (state.rows.length < state.total) parts.push('showing ' + state.rows.length);
    line.textContent = parts.join(' \u00b7 ');
  }

  // ---------------------------------------------------------------- cards

  function badge(text, cls) {
    return '<span class="gv2-badge ' + (cls || '') + '">' + esc(text) + '</span>';
  }

  function cardHtml(row) {
    var rating = ratingOf(row);
    var expired = expiryText(row);
    var badges = '';
    if (rating === 'endorsed') badges += badge('\u2605 endorsed', 'gv2-badge-endorsed');
    else if (rating === 'disliked') badges += badge('\u{1F44E} disliked', 'gv2-badge-disliked');
    if (row.state === 'archived') badges += badge('archived' + (expired ? ' \u00b7 ' + expired : ''), 'gv2-badge-archived');
    if (row.state === 'staged') badges += badge('staged', 'gv2-badge-staged');
    if (row.state === 'trashed') badges += badge('trashed', 'gv2-badge-trashed');
    if (row.variant) badges += badge(row.variant, 'gv2-badge-variant');
    if (row.album_id) {
      var album = albumById(row.album_id);
      if (album) badges += badge((album.bundled ? '\u{1F4E6} ' : '') + album.name, 'gv2-badge-album');
    }

    var thumb = row.state === 'trashed'
      ? '<div class="gv2-thumb gv2-thumb-empty">no media</div>'
      : '<img class="gv2-thumb" loading="lazy" src="' + blobUrl(row, 'thumb') + '" alt="">';

    var tags = workflowTagsOf(row).slice(0, 4).map(function (t) {
      return '<span class="gv2-tag">' + esc(t) + '</span>';
    }).join('');

    var caps = [];
    if (row.width && row.height) caps.push('<span class="gv2-capsule">' + row.width + '\u00d7' + row.height + '</span>');
    if (row.file_size) caps.push('<span class="gv2-capsule">' + fmtSize(row.file_size) + '</span>');
    if (row.source) caps.push('<span class="gv2-capsule">' + esc(row.source) + '</span>');
    var stamp = fmtCardTime(row.mtime);
    if (stamp) caps.push('<span class="gv2-capsule">' + stamp + '</span>');

    var selected = state.selected.has(row.uid) ? ' gv2-card-selected' : '';
    return '<div class="gv2-card' + selected + '" data-key="' + esc(row.uid) + '">' +
      thumb +
      '<div class="gv2-veil"></div>' +
      '<div class="gv2-card-badges">' + badges + '</div>' +
      '<input type="checkbox" class="gv2-check"' + (selected ? ' checked' : '') + ' title="Select">' +
      '<div class="gv2-card-actions">' + actionButtons(row) + '</div>' +
      '<div class="gv2-card-caps">' + caps.join('') + tags + '</div>' +
    '</div>';
  }

  function actionButtons(row) {
    if (row.state === 'trashed') {
      return '<button data-act="restore" title="Restore metadata (needs live media)">\u21a9</button>' +
        '<button data-act="purge" title="Purge permanently (metadata too)">\u2716</button>';
    }
    var rating = ratingOf(row);
    var html = '';
    html += '<button data-act="endorse" title="Endorse">' + (rating === 'endorsed' ? '\u2605' : '\u2606') + '</button>';
    html += '<button data-act="dislike" title="Dislike">\u{1F44E}</button>';
    html += '<button data-act="archive" title="' + (row.state === 'archived' ? 'Unarchive' : 'Archive (auto-trash in 24h)') + '">\u{1F4E6}</button>';
    if (row.state !== 'archived') {
      html += '<button data-act="stage" title="' + (row.state === 'staged' ? 'Unstage' : 'Stage for review') + '">\u{1F4CC}</button>';
    }
    html += '<button data-act="trash" title="Trash now">\u{1F5D1}</button>';
    return html;
  }

  function renderRows(rows, append) {
    var grid = el('gv2-grid');
    if (!grid) return;
    var html = rows.map(cardHtml).join('');
    if (append) grid.insertAdjacentHTML('beforeend', html);
    else grid.innerHTML = html;
  }

  function updateCard(row) {
    var card = document.querySelector('.gv2-card[data-key="' + cssEscape(row.uid || row.key) + '"]');
    if (!card) return;
    var fresh = state.rows.filter(function (r) { return r.uid === (row.uid || row.key); })[0];
    if (!fresh) return;
    fresh.state = row.state;
    fresh.rating = row.rating;
    fresh.archive_expires_at = row.archive_expires_at;
    var tags = fresh.tags || [];
    tags = tags.filter(function (t) { return t.category !== 'rating'; });
    if (row.rating) tags.push({ category: 'rating', name: row.rating, source: 'user' });
    fresh.tags = tags;
    card.outerHTML = cardHtml(fresh);
  }

  function cssEscape(value) {
    if (window.CSS && CSS.escape) return CSS.escape(value);
    return String(value).replace(/[^a-zA-Z0-9_-]/g, '\\$&');
  }

  function setSelection(keys) {
    state.selected = new Set(keys);
    updateBatchBar();
    document.querySelectorAll('.gv2-card').forEach(function (card) {
      var key = card.getAttribute('data-key');
      var on = state.selected.has(key);
      card.classList.toggle('gv2-card-selected', on);
      var check = card.querySelector('.gv2-check');
      if (check) check.checked = on;
    });
  }

  function updateBatchBar() {
    var bar = el('gv2-batch');
    if (!bar) return;
    var count = el('gv2-batch-count');
    if (count) count.textContent = state.selected.size + ' selected';
    bar.classList.toggle('gv2-batch-hidden', !(state.selectMode || state.selected.size > 0));
    bar.classList.toggle('gv2-batch-off', state.selected.size === 0);
  }

  function setSelectMode(on) {
    state.selectMode = !!on;
    var btn = el('gv2-select');
    if (btn) {
      btn.textContent = state.selectMode ? 'Exit select' : 'Select';
      btn.classList.toggle('gv2-btn-active', state.selectMode);
    }
    var root = el(ROOT_ID);
    if (root) root.classList.toggle('gv2-selecting', state.selectMode);
    if (state.selectMode) {
      updateBatchBar();
      toast('Select mode: click cards or drag a box to select \u00b7 shift-drag deselects \u00b7 shift-click selects a range');
    } else {
      setSelection([]);
    }
  }

  // The shortcuts are advertised in the toolbar's top row (#gv2-keys):
  //   R = clear filters + refresh + Sync        S = toggle select mode
  // Inert while typing, while a viewer owns the keyboard, or when the gallery
  // page is not the visible tab.
  function gv2Hotkeys(ev) {
    if (ev.defaultPrevented || ev.repeat) return;
    if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
    if (window.gv2LightboxNav || ev._lightboxHandled) return;
    if (isTypingTarget(ev.target)) return;
    var root = el(ROOT_ID);
    if (!root || !root.getClientRects().length) return;
    var key = (ev.key || '').toLowerCase();
    if (key === 'r') {
      ev.preventDefault();
      resetFiltersState();
      refreshFacets();
      resetAndRefresh();
      runMaintenance('reindex', 'Sync');
    } else if (key === 's') {
      ev.preventDefault();
      setSelectMode(!state.selectMode);
    }
  }

  function selectPage() {
    state.rows.forEach(function (row) { state.selected.add(row.uid); });
    state.lastIndex = state.rows.length - 1;
    setSelection(Array.from(state.selected));
  }

  function cardSelectClick(key, ev) {
    var idx = -1;
    for (var i = 0; i < state.rows.length; i++) {
      if (state.rows[i].uid === key) { idx = i; break; }
    }
    if (ev.shiftKey && state.lastIndex >= 0 && idx >= 0) {
      var lo = Math.min(state.lastIndex, idx);
      var hi = Math.max(state.lastIndex, idx);
      for (var j = lo; j <= hi; j++) state.selected.add(state.rows[j].uid);
    } else if (state.selected.has(key)) {
      state.selected.delete(key);
    } else {
      state.selected.add(key);
    }
    state.lastIndex = idx;
    setSelection(Array.from(state.selected));
  }

  // ---------------------------------------------------------------- actions

  function actionFor(row, act) {
    var rating = ratingOf(row);
    if (act === 'endorse') return rating === 'endorsed' ? 'unendorse' : 'endorse';
    if (act === 'dislike') return rating === 'disliked' ? 'undislike' : 'dislike';
    if (act === 'archive') return row.state === 'archived' ? 'unarchive' : 'archive';
    if (act === 'stage') return row.state === 'staged' ? 'unstage' : 'stage';
    if (act === 'restore' || act === 'purge') return act;
    if (act === 'trash') return 'trash';
    return act;
  }

  function copySelectedToCensored() {
    var keys = Array.from(state.selected);
    if (!keys.length) { toast('Select items first', true); return; }
    api('/gallery/api/copy-censored', { keys: keys })
      .then(function (data) {
        var copied = (data && data.copied) || 0;
        var skipped = (data && data.skipped) || 0;
        var errors = (data && data.errors) || [];
        if (errors.length) {
          toast('Copied ' + copied + ', failed ' + errors.length + ': ' + errors[0].error, true);
          return;
        }
        var message = 'Copied ' + copied + ' image(s) to ' + ((data && data.target) || 'outputs/censored');
        if (skipped) message += ' \u00b7 ' + skipped + ' already there';
        toast(message);
      })
      .catch(function (err) {
        var reason = (err && err.message) || 'unknown error';
        if (reason === 'Not Found') reason = 'copy endpoint missing \u2014 restart webui';
        toast('Copy failed: ' + reason, true);
      });
  }

  function runAction(action, keys, params) {
    if (!keys.length) return Promise.resolve();
    return api('/gallery/api/action', { action: action, keys: keys, params: params || {} })
      .then(function (data) {
        (data.changed || []).forEach(function (changed) {
          var row = state.rows.filter(function (r) { return r.uid === changed.key; })[0];
          if (row) {
            changed.uid = row.uid;
            updateCard(changed);
          }
        });
        if (data.errors && data.errors.length) {
          toast('Action "' + action + '" failed for ' + data.errors.length + ' item(s): ' + data.errors[0].error, true);
        } else if (action === 'purge') {
          toast('purged \u00b7 ' + (data.changed || []).length + ' item(s)');
        } else {
          toast(action + ' \u00b7 ' + (data.changed || []).length + ' item(s)');
        }
        if (action === 'trash' || action === 'purge') {
          state.rows = state.rows.filter(function (r) { return keys.indexOf(r.uid) < 0; });
          keys.forEach(function (key) {
            state.selected.delete(key);
            var node = document.querySelector('.gv2-card[data-key="' + cssEscape(key) + '"]');
            if (node) node.parentNode.removeChild(node);
          });
          updateBatchBar();
          updateCountLine();
        }
        return data;
      })
      .catch(function (err) { toast('Action failed: ' + err.message, true); });
  }

  function runMaintenance(op, label, extra) {
    var payload = { op: op };
    if (extra) Object.keys(extra).forEach(function (k) { payload[k] = extra[k]; });
    toast(label + ' running\u2026');
    return api('/gallery/api/maintenance', payload)
      .then(function (data) {
        if (op === 'reindex') {
          var stats = (data && data.stats) || {};
          toast(label + ': scanned ' + (stats.scanned || 0) + ', added ' + (stats.added || 0) + ', updated ' + (stats.updated || 0));
        } else {
          var n = data && (data.removed !== undefined ? data.removed : data.archived);
          toast(label + ' done' + (n !== undefined && n !== null ? ' \u2014 ' + n + ' item(s)' : ''));
        }
        refreshFacets(); resetAndRefresh();
      })
      .catch(function (err) { toast(label + ' failed: ' + err.message, true); });
  }

  // Destructive maintenance: ask the server how many items are involved first,
  // show that count in the warning, then run the op on confirmation.
  function confirmMaintenance(op, label, buildMessage, extraBuilder) {
    var extra = extraBuilder ? extraBuilder() : null;
    var payload = { op: op, dry_run: true };
    if (extra) Object.keys(extra).forEach(function (k) { payload[k] = extra[k]; });
    toast(label + ': counting\u2026');
    api('/gallery/api/maintenance', payload)
      .then(function (data) {
        var count = (data && data.count) || 0;
        if (!count) { toast(label + ': nothing to do (0 items)'); return; }
        if (!window.confirm(buildMessage(count))) return;
        runMaintenance(op, label, extra);
      })
      .catch(function (err) { toast(label + ' count failed: ' + err.message, true); });
  }

  // ---------------------------------------------------------------- detail

  function openDetail(uid, opts) {
    var row = state.rows.filter(function (r) { return r.uid === uid; })[0];
    if (!row) return;
    state.detailKey = uid;
    markDetailCard(opts && opts.scroll);
    api('/gallery/api/item?id=' + encodeURIComponent(uid)).then(function (item) {
      if (state.detailKey === uid) renderDetail(item);
    }).catch(function (err) { toast('Detail failed: ' + err.message, true); });
  }

  function detailRow() {
    return state.rows.filter(function (r) { return r.uid === state.detailKey; })[0] || null;
  }

  function refreshDetail() {
    var uid = state.detailKey;
    if (!uid) return Promise.resolve();
    return api('/gallery/api/item?id=' + encodeURIComponent(uid)).then(function (item) {
      if (state.detailKey === uid) renderDetail(item);
    }).catch(function () {});
  }

  // Fullscreen viewer: reuse the app-wide lightbox (#lightboxModal) that already
  // provides wheel zoom + drag panning. Prefer the original file on disk; fall
  // back to the stored preview blob when the original is gone (bundled/trashed).
  function itemFileUrl(item) {
    var p = (item && (item.path || item.alias_path)) || '';
    if (!p) return '';
    return '/file=' + encodeURIComponent(String(p).replace(/\\/g, '/'));
  }

  function itemFileName(item) {
    var p = (item && (item.path || item.alias_path)) || '';
    if (!p) return '';
    return String(p).split(/[\\/]/).pop() || '';
  }

  function downloadItem(item) {
    var name = itemFileName(item);
    var original = item.state === 'trashed' ? '' : itemFileUrl(item);
    var preview = blobUrl(item, 'preview');
    var previewName = (name ? name.replace(/\.[^.]+$/, '') : (item.uid || 'image')) + ' (preview).webp';
    // Fetch -> blob -> object URL keeps the exact filename in the save dialog and
    // works regardless of the server's content-disposition header.
    var attempt = function (src, fname, onFail) {
      fetch(src).then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.blob();
      }).then(function (blob) {
        if (!blob.size) throw new Error('empty file');
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = fname;
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
      }).catch(function (err) { onFail(err); });
    };
    if (!original) {
      toast('original file is gone \u2014 downloading the stored preview instead');
      attempt(preview, previewName, function (err) { toast('Download failed: ' + err.message, true); });
      return;
    }
    attempt(original, name || 'image.png', function () {
      toast('original file not readable \u2014 downloading the stored preview instead');
      attempt(preview, previewName, function (err) { toast('Download failed: ' + err.message, true); });
    });
  }

  function revealItem(item) {
    api('/gallery/api/reveal', { id: item.uid }).catch(function (err) {
      toast('Reveal failed: ' + err.message, true);
    });
  }

  function detailViewerSrc(item, previewSrc, cb) {
    var url = item.state === 'trashed' ? '' : itemFileUrl(item);
    if (!url) { cb(previewSrc); return; }
    var probe = new Image();
    probe.onload = function () { cb(url); };
    probe.onerror = function () { cb(previewSrc); };
    probe.src = url;
  }

  // Keep the fullscreen viewer on the left of the detail panel while the
  // drawer is open, so its metadata/actions stay reachable. Narrow viewports
  // fall back to the classic full-screen lightbox.
  var DETAIL_SPLIT_MIN_STAGE = 520;

  function detailPanelWidth() {
    var box = el('gv2-detail');
    var panel = box ? box.querySelector('.gv2-detail-panel') : null;
    return panel ? panel.getBoundingClientRect().width : Math.min(680, window.innerWidth * 0.92);
  }

  function detailSplitEnabled() {
    var viewport = document.documentElement.clientWidth || window.innerWidth;
    return viewport - detailPanelWidth() >= DETAIL_SPLIT_MIN_STAGE;
  }

  function applyDetailSplit(split) {
    var box = el('gv2-detail');
    if (!box) return;
    box.classList.toggle('gv2-detail-split', !!split);
    document.documentElement.style.setProperty(
      '--gv2-detail-offset', (split ? detailPanelWidth() : 0) + 'px'
    );
  }

  function openDetailViewer(item) {
    if (typeof window.openLightbox !== 'function') { toast('Image viewer unavailable', true); return; }
    var box = el('gv2-detail');
    var detailImg = box ? box.querySelector('.gv2-detail-img') : null;
    if (!detailImg) return;
    var previewSrc = detailImg.src;
    var split = detailSplitEnabled();
    applyDetailSplit(split);
    window.gv2LightboxNav = {
      nav: function (offset) { navDetailViewer(offset); },
      split: split,
      closeDetail: closeDetail,
      cleanup: function () { applyDetailSplit(false); }
    };
    detailViewerSrc(item, previewSrc, function (src) {
      if (window.gv2LightboxNav) window.openLightbox(src, { split: window.gv2LightboxNav.split });
    });
  }

  function navDetailViewer(offset) {
    var uid = state.detailKey;
    if (!uid) return;
    var idx = -1;
    for (var i = 0; i < state.rows.length; i++) {
      if (state.rows[i].uid === uid) { idx = i; break; }
    }
    var next = idx + offset;
    if (idx < 0 || next < 0 || next >= state.rows.length) return;
    var row = state.rows[next];
    state.detailKey = row.uid;
    markDetailCard(false);
    api('/gallery/api/item?id=' + encodeURIComponent(row.uid)).then(function (item) {
      if (!window.gv2LightboxNav) return; // viewer was closed while loading
      renderDetail(item);
      detailViewerSrc(item, blobUrl(row, 'preview'), function (src) {
        if (window.gv2LightboxNav) {
          window.openLightbox(src, { split: window.gv2LightboxNav.split });
        }
      });
    }).catch(function () {});
  }

  function detailNavigate(dir) {
    if (!state.rows.length) return;
    var idx = -1;
    for (var i = 0; i < state.rows.length; i++) {
      if (state.rows[i].uid === state.detailKey) { idx = i; break; }
    }
    var next = idx < 0 ? (dir > 0 ? 0 : state.rows.length - 1) : idx + dir;
    if (next < 0) { toast('start of list'); return; }
    if (next >= state.rows.length) { toast('end of list'); return; }
    openDetail(state.rows[next].uid, { scroll: true });
  }

  function detailApply(act) {
    var row = detailRow();
    if (!row) return Promise.resolve();
    if (row.state === 'trashed') { toast('use restore / purge for trashed items', true); return Promise.resolve(); }
    return runAction(actionFor(row, act), [row.uid], {}).then(function () {
      markDetailCard(false);
      return refreshDetail();
    });
  }

  function detailTrash() {
    var row = detailRow();
    if (!row || row.state === 'trashed') return;
    if (!window.confirm('Trash now? The original file and media will be deleted (metadata kept).')) return;
    var idx = state.rows.indexOf(row);
    runAction('trash', [row.uid], {}).then(function () {
      if (!state.rows.length) { closeDetail(); return; }
      openDetail(state.rows[Math.min(Math.max(idx, 0), state.rows.length - 1)].uid, { scroll: true });
    });
  }

  function markDetailCard(scroll) {
    document.querySelectorAll('.gv2-card.gv2-card-current').forEach(function (card) {
      card.classList.remove('gv2-card-current');
    });
    if (!state.detailKey) return;
    var card = document.querySelector('.gv2-card[data-key="' + cssEscape(state.detailKey) + '"]');
    if (!card) return;
    card.classList.add('gv2-card-current');
    if (scroll && card.scrollIntoView) card.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  function detailActionButtons(item) {
    if (item.state === 'trashed') {
      return '<button class="gv2-btn" data-detail-act="restore">Restore metadata</button>' +
        '<button class="gv2-btn gv2-btn-danger" data-detail-act="purge">Purge</button>';
    }
    var rating = ratingOf(item);
    var html = '';
    html += '<button class="gv2-btn" data-detail-act="endorse">' + (rating === 'endorsed' ? 'Un-endorse' : 'Endorse') + '</button>';
    html += '<button class="gv2-btn" data-detail-act="dislike">' + (rating === 'disliked' ? 'Undislike' : 'Dislike') + '</button>';
    html += '<button class="gv2-btn" data-detail-act="archive">' + (item.state === 'archived' ? 'Unarchive' : 'Archive') + '</button>';
    if (item.state !== 'archived') {
      html += '<button class="gv2-btn" data-detail-act="stage">' + (item.state === 'staged' ? 'Unstage' : 'Stage') + '</button>';
    }
    html += '<button class="gv2-btn gv2-btn-danger" data-detail-act="trash">Trash</button>';
    return html;
  }

  function albumSectionHtml(item) {
    var list = state.albums || [];
    if (!list.length) {
      return '<div class="gv2-row-hint">no albums yet \u2014 create one in the Albums row above</div>';
    }
    var options = '<option value="">\u2014 pick an album \u2014</option>';
    list.forEach(function (album) {
      options += '<option value="' + album.id + '"' + (item.album_id === album.id ? ' selected' : '') + '>' + esc(album.name) + '</option>';
    });
    var current = '<div class="gv2-row-hint">not in an album</div>';
    if (item.album_id) {
      var album = albumById(item.album_id);
      if (album) current = '<div class="gv2-row-hint">currently in <b>' + esc(album.name) + '</b></div>';
    }
    var coverLine = '';
    if (item.album_id) {
      var coverAlbum = albumById(item.album_id);
      var isCover = coverAlbum && coverAlbum.cover === item.uid;
      coverLine = '<div class="gv2-detail-album-cover">' +
        '<button class="gv2-btn gv2-btn-quiet" id="gv2-detail-album-cover"' + (isCover ? ' disabled' : '') +
        ' title="Use this image as the cover of its album">Set as cover</button>' +
        (isCover ? '<span class="gv2-row-hint">this is the current cover</span>' : '') +
        '</div>';
    }
    return '<div class="gv2-detail-album">' +
      '<select id="gv2-detail-album-pick" class="gv2-select">' + options + '</select>' +
      '<button class="gv2-btn" id="gv2-detail-album-set">Set</button>' +
      '<button class="gv2-btn gv2-btn-quiet" id="gv2-detail-album-remove">Remove</button>' +
      '</div>' + current + coverLine;
  }

  // Two detail-drawer layouts, remembered in the UI prefs:
  //   false -> the preview sits at the top of the right drawer (classic)
  //   true  -> the preview fills the stage on the left, the drawer keeps the metadata
  function detailMediaLeftActive() {
    // on narrow windows the drawer takes almost the whole width, so keep the classic layout
    return !!state.detailMediaLeft && window.innerWidth > 820;
  }

  function applyDetailMediaMode() {
    var box = el('gv2-detail');
    if (!box) return;

    var left = detailMediaLeftActive();
    var stage = box.querySelector('.gv2-detail-stage');
    var wrap = box.querySelector('.gv2-detail-img-wrap');
    var panel = box.querySelector('.gv2-detail-panel');
    var body = box.querySelector('.gv2-detail-body');

    if (wrap && stage && panel) {
      var host = left ? stage : panel;
      if (wrap.parentElement !== host) {
        if (left) host.appendChild(wrap);
        else panel.insertBefore(wrap, body || null);
      }
    }

    box.classList.toggle('gv2-detail-media-left', left);
    var toggle = el('gv2-detail-media-toggle');
    if (toggle) {
      toggle.classList.toggle('gv2-detail-media-toggle-on', left);
      toggle.setAttribute('aria-pressed', left ? 'true' : 'false');
      toggle.title = left
        ? 'Preview on the left (click to show it in this panel)'
        : 'Preview in this panel (click to show it on the left)';
      if (state.detailMediaLeft && !left) toggle.title += ' - needs a wider window';
      toggle.setAttribute('aria-label', toggle.title);
    }
  }

  function promptToggleHtml(item) {
    var compiled = hasCompiledPrompt(item);
    var tab = function (value, label, title) {
      var on = state.promptVariant === value ? ' is-on' : '';
      return '<button class="gv2-prompt-tab' + on + '" data-prompt-variant="' + value + '" ' +
        'title="' + esc(title) + '" aria-pressed="' + (on ? 'true' : 'false') + '">' + label + '</button>';
    };
    return '<span class="gv2-prompt-toggle" role="group" aria-label="Prompt variant">' +
      tab('source', 'Source', 'The prompt as typed, with comments and @PICK groups intact') +
      tab('compiled', 'Compiled',
        compiled
          ? 'The prompt that was actually sent to the model (comments stripped, @PICK groups drawn)'
          : 'No compiled prompt recorded for this image - it was generated before this was stored') +
      '</span>';
  }

  function promptVariantHint(item) {
    if (state.promptVariant !== 'compiled') return '';
    if (!hasCompiledPrompt(item)) {
      return '<div class="gv2-row-hint">No compiled prompt recorded for this image - showing the source prompt.</div>';
    }
    return '<div class="gv2-row-hint">Compiled prompt: comments stripped, @PICK groups resolved.</div>';
  }

  function renderDetail(item) {
    var box = el('gv2-detail');
    if (!box) return;
    var meta = item.meta || {};
    var rows = [
      ['Source', item.source + (item.variant ? ' / ' + item.variant : '')],
      ['Path', item.rel_path || item.path || ''],
      ['Time', fmtTime(item.mtime)],
      ['Size', (item.width || 0) + '\u00d7' + (item.height || 0) + ' \u00b7 ' + fmtSize(item.file_size)],
      ['Seed', meta.seed || ''],
      ['Steps', meta.steps || ''],
      ['Sampler', meta.sampler || ''],
      ['CFG', meta.cfg || ''],
      ['Model', meta.model || '']
    ];
    if (item.album_id) {
      var album = albumById(item.album_id);
      if (album) rows.push(['Album', album.name + (album.bundled ? ' (bundled)' : '')]);
    }
    var img = item.state === 'trashed'
      ? '<div class="gv2-thumb gv2-thumb-empty">no media (trash)</div>'
      : '<img class="gv2-detail-img" src="' + blobUrl(item, 'preview') + '" alt="" ' +
        'title="Click to open the fullscreen viewer (wheel = zoom, drag = pan)">';
    var tagPills = (item.tags || []).filter(function (t) { return t.category === 'workflow'; })
      .map(function (t) {
        return '<span class="gv2-tag">' + esc(t.name) +
          ' <button class="gv2-tag-x" data-remove-tag="' + esc(t.name) + '">\u00d7</button></span>';
      }).join('');
    var events = (item.events || []).slice(0, 6).map(function (e) {
      return esc(e.event) + ' \u00b7 ' + esc(e.at);
    }).join('<br>');
    var expiry = expiryText(item);
    box.innerHTML =
      '<div class="gv2-detail-stage"></div>' +
      '<div class="gv2-detail-panel">' +
        '<div class="gv2-detail-head">' +
          '<button id="gv2-detail-media-toggle" class="gv2-detail-media-toggle" ' +
            'title="Show the preview on the left">\u25a5</button>' +
          '<button id="gv2-detail-close" class="gv2-detail-close">\u00d7</button>' +
        '</div>' +
        '<div class="gv2-detail-img-wrap">' + img + '</div>' +
        '<div class="gv2-detail-body">' +
          (item.state !== 'trashed'
            ? '<div class="gv2-detail-fileops">' +
                '<button class="gv2-btn gv2-btn-quiet" data-detail-op="download" ' +
                  'title="Download the original file (falls back to the stored preview if it is gone)">\u2B07 Download</button>' +
                '<button class="gv2-btn gv2-btn-quiet" data-detail-op="explorer" ' +
                  'title="Reveal the file in the system file manager">\u{1F4C2} Find in Explorer</button>' +
              '</div>'
            : '') +
          '<div class="gv2-detail-badges">' +
            (item.state && item.state !== 'active' ? badge(item.state, 'gv2-badge-' + item.state) : '') +
            (expiry ? badge(expiry, 'gv2-badge-archived') : '') +
            (item.has_composer ? badge('composer state', 'gv2-badge-variant') : '') +
          '</div>' +
          '<div class="gv2-detail-actions">' + detailActionButtons(item) + '</div>' +
          '<div class="gv2-detail-keys">' +
            '<span><kbd>\u2190</kbd><kbd>\u2192</kbd> prev / next</span>' +
            '<span><kbd>\u2191</kbd> endorse</span>' +
            '<span><kbd>\u2193</kbd> dislike</span>' +
            '<span><kbd>Del</kbd> trash</span>' +
            '<span><kbd>A</kbd> archive</span>' +
            '<span><kbd>Esc</kbd> close</span>' +
          '</div>' +
          '<div class="gv2-detail-section"><div class="gv2-detail-label"><span>Send to</span>' +
            '<span class="gv2-row-hint">prompt: ' + (state.promptVariant === 'compiled' && hasCompiledPrompt(item) ? 'compiled' : 'source') + '</span></div>' +
            '<div class="gv2-detail-send">' +
              SEND_ACTIONS.map(function (def) {
                return '<button class="gv2-btn gv2-btn-quiet" data-send-act="' + def[0] + '" title="' + esc(def[2]) + '">' + def[1] + '</button>';
              }).join('') +
            '</div>' +
          '</div>' +
          '<div class="gv2-detail-section"><div class="gv2-detail-label">Album</div>' +
            albumSectionHtml(item) +
          '</div>' +
          '<div class="gv2-detail-section"><div class="gv2-detail-label">Workflow tags</div>' +
            '<div class="gv2-detail-tags">' + (tagPills || '<span class="gv2-row-hint">none</span>') + '</div>' +
            '<div class="gv2-detail-tagadd"><input id="gv2-detail-taginput" placeholder="add tag\u2026">' +
            '<button class="gv2-btn" id="gv2-detail-tagadd">+</button></div>' +
          '</div>' +
          '<div class="gv2-detail-section"><div class="gv2-detail-label"><span>Prompt</span>' +
            promptToggleHtml(item) + '</div>' +
            '<div class="gv2-detail-prompt">' + esc(activePrompt(item)) + '</div>' +
            promptVariantHint(item) +
            '<button class="gv2-btn gv2-btn-quiet" id="gv2-copy-prompt">Copy prompt</button></div>' +
          '<div class="gv2-detail-section"><div class="gv2-detail-label">Negative</div>' +
            '<div class="gv2-detail-prompt">' + esc(activeNegativePrompt(item)) + '</div></div>' +
          '<div class="gv2-detail-section"><div class="gv2-detail-label">Parameters</div>' +
            rows.filter(function (r) { return r[1] !== '' && r[1] !== null && r[1] !== undefined; })
              .map(function (r) { return '<div class="gv2-detail-row"><span>' + esc(r[0]) + '</span><b>' + esc(r[1]) + '</b></div>'; }).join('') +
          '</div>' +
          '<div class="gv2-detail-section"><div class="gv2-detail-label">History</div>' +
            '<div class="gv2-detail-history">' + (events || 'none') + '</div></div>' +
        '</div>' +
      '</div>';
    box.classList.remove('gv2-detail-hidden');
    applyDetailMediaMode();

    el('gv2-detail-close').addEventListener('click', closeDetail);
    var mediaToggle = el('gv2-detail-media-toggle');
    if (mediaToggle) {
      mediaToggle.addEventListener('click', function (ev) {
        ev.stopPropagation();
        state.detailMediaLeft = !state.detailMediaLeft;
        savePrefs();
        applyDetailMediaMode();
      });
    }
    var detailStage = box.querySelector('.gv2-detail-stage');
    if (detailStage) {
      detailStage.addEventListener('click', function (ev) {
        // clicking the empty space around the preview leaves the drawer
        if (ev.target && ev.target.closest && ev.target.closest('.gv2-detail-img')) return;
        closeDetail();
      });
    }
    var detailImg = box.querySelector('.gv2-detail-img');
    if (detailImg) {
      detailImg.addEventListener('click', function () { openDetailViewer(item); });
    }
    box.querySelectorAll('[data-detail-op]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var op = btn.getAttribute('data-detail-op');
        if (op === 'download') downloadItem(item);
        else if (op === 'explorer') revealItem(item);
      });
    });
    box.querySelectorAll('[data-send-act]').forEach(function (btn) {
      var act = btn.getAttribute('data-send-act');
      btn.addEventListener('click', function () {
        sendItemTo(item, act);
      });
      if (bareSendAction(act)) {
        btn.addEventListener('contextmenu', function (e) {
          e.preventDefault();
          e.stopPropagation();
          openSendOptionsMenu(e, makeSendOptions(function (only) {
            return function () { sendItemTo(item, act, { only: only }); };
          }));
        });
      }
    });
    box.querySelectorAll('[data-detail-act]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var current = detailRow();
        var act = current ? actionFor(current, btn.getAttribute('data-detail-act')) : btn.getAttribute('data-detail-act');
        runAction(act, [item.uid], {}).then(function () {
          markDetailCard(false);
          return api('/gallery/api/item?id=' + encodeURIComponent(item.uid)).then(renderDetail).catch(function () {});
        });
      });
    });
    var addBtn = el('gv2-detail-tagadd');
    if (addBtn) {
      addBtn.addEventListener('click', function () {
        var value = el('gv2-detail-taginput').value.trim();
        if (!value) return;
        runAction('add_tag', [item.uid], { tag: value, category: 'workflow' }).then(function () {
          api('/gallery/api/item?id=' + encodeURIComponent(item.uid)).then(renderDetail).catch(function () {});
          refreshFacets();
        });
      });
    }
    box.querySelectorAll('[data-remove-tag]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        runAction('remove_tag', [item.uid], { tag: btn.getAttribute('data-remove-tag'), category: 'workflow' })
          .then(function () {
            api('/gallery/api/item?id=' + encodeURIComponent(item.uid)).then(renderDetail).catch(function () {});
            refreshFacets();
          });
      });
    });
    var copyBtn = el('gv2-copy-prompt');
    if (copyBtn) {
      copyBtn.addEventListener('click', function () {
        if (navigator.clipboard) navigator.clipboard.writeText(activePrompt(item));
        toast(state.promptVariant === 'compiled' && hasCompiledPrompt(item) ? 'Compiled prompt copied' : 'Prompt copied');
      });
    }
    box.querySelectorAll('[data-prompt-variant]').forEach(function (btn) {
      btn.addEventListener('click', function (ev) {
        ev.stopPropagation();
        var next = btn.getAttribute('data-prompt-variant');
        if (next !== 'source' && next !== 'compiled') return;
        if (state.promptVariant === next) return;
        state.promptVariant = next;
        savePrefs();
        // re-render in place, keeping the drawer where the user was reading
        var panel = box.querySelector('.gv2-detail-panel');
        var scroll = panel ? panel.scrollTop : 0;
        renderDetail(item);
        var nextPanel = box.querySelector('.gv2-detail-panel');
        if (nextPanel) nextPanel.scrollTop = scroll;
      });
    });
    var albumSetBtn = el('gv2-detail-album-set');
    if (albumSetBtn) {
      albumSetBtn.addEventListener('click', function () {
        var pick = el('gv2-detail-album-pick');
        if (!pick || !pick.value) { toast('Pick an album first', true); return; }
        api('/gallery/api/albums/items', { album: parseInt(pick.value, 10), add: [item.uid], remove: [] })
          .then(function (data) {
            state.albums = (data && data.albums) || [];
            renderAlbums();
            toast('added to album');
            return refreshDetail();
          })
          .then(function () { resetAndRefresh(); })
          .catch(function (err) { toast('Album add failed: ' + err.message, true); });
      });
    }
    var albumRemoveBtn = el('gv2-detail-album-remove');
    if (albumRemoveBtn) {
      albumRemoveBtn.addEventListener('click', function () {
        if (!item.album_id) { toast('not in an album', true); return; }
        api('/gallery/api/albums/items', { album: item.album_id, add: [], remove: [item.uid] })
          .then(function (data) {
            state.albums = (data && data.albums) || [];
            renderAlbums();
            toast('removed from album');
            return refreshDetail();
          })
          .then(function () { resetAndRefresh(); })
          .catch(function (err) { toast('Album remove failed: ' + err.message, true); });
      });
    }
    var albumCoverBtn = el('gv2-detail-album-cover');
    if (albumCoverBtn) {
      albumCoverBtn.addEventListener('click', function () {
        if (!item.album_id) { toast('add it to an album first', true); return; }
        api('/gallery/api/albums/cover', { album: item.album_id, key: item.uid })
          .then(function (data) {
            state.albums = (data && data.albums) || [];
            renderAlbums();
            toast('album cover updated');
            return refreshDetail();
          })
          .catch(function (err) { toast('Cover update failed: ' + err.message, true); });
      });
    }
  }

  function closeDetail() {
    if (window.gv2LightboxNav) {
      if (typeof window.closeModal === 'function') {
        window.closeModal();
      } else {
        window.gv2LightboxNav = null;
        applyDetailSplit(false);
      }
    }
    var box = el('gv2-detail');
    if (box) {
      box.classList.add('gv2-detail-hidden');
      box.classList.remove('gv2-detail-split');
    }
    state.detailKey = null;
    markDetailCard(false);
  }

  // ---------------------------------------------------------------- misc

  var toastTimer = null;
  function toast(message, isError) {
    var box = el('gv2-toast');
    if (!box) return;
    box.textContent = message;
    box.classList.toggle('gv2-toast-error', !!isError);
    box.classList.remove('gv2-toast-hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { box.classList.add('gv2-toast-hidden'); }, 3200);
  }

  function wireGrid(root) {
    var dragState = null;
    var suppressClickOnce = false;
    var marqueeEl = null;

    function getMarquee() {
      if (!marqueeEl) {
        marqueeEl = document.createElement('div');
        marqueeEl.id = 'gv2-marquee';
        marqueeEl.className = 'gv2-marquee gv2-marquee-hidden';
        document.body.appendChild(marqueeEl);
      }
      return marqueeEl;
    }

    function endDrag() {
      if (!dragState) return;
      if (dragState.active) {
        suppressClickOnce = true;
        root.classList.remove('gv2-dragging');
        if (marqueeEl) marqueeEl.classList.add('gv2-marquee-hidden');
      }
      dragState = null;
    }

    function applyMarquee(x0, y0, x1, y1) {
      var left = Math.min(x0, x1);
      var right = Math.max(x0, x1);
      var top = Math.min(y0, y1);
      var bottom = Math.max(y0, y1);
      var next = new Set(dragState.base);
      document.querySelectorAll('.gv2-card').forEach(function (card) {
        var r = card.getBoundingClientRect();
        if (r.right < left || r.left > right || r.bottom < top || r.top > bottom) return;
        var key = card.getAttribute('data-key');
        if (dragState.deselect) next.delete(key);
        else next.add(key);
      });
      setSelection(Array.from(next));
    }

    root.addEventListener('change', function (ev) {
      var check = ev.target;
      if (!check.classList || !check.classList.contains('gv2-check')) return;
      var card = check.closest('.gv2-card');
      if (!card) return;
      var key = card.getAttribute('data-key');
      if (check.checked) state.selected.add(key); else state.selected.delete(key);
      setSelection(Array.from(state.selected));
    });
    root.addEventListener('pointerdown', function (ev) {
      suppressClickOnce = false;
      if (!state.selectMode || ev.button !== 0) return;
      if (!ev.target.closest) return;
      if (ev.target.closest('.gv2-card-actions') || ev.target.closest('.gv2-check')) return;
      var grid = el('gv2-grid');
      if (!grid || !grid.contains(ev.target)) return;
      dragState = {
        startX: ev.clientX,
        startY: ev.clientY,
        deselect: !!ev.shiftKey,
        active: false,
        base: null
      };
    });
    document.addEventListener('pointermove', function (ev) {
      if (!dragState) return;
      if (ev.buttons === 0) { endDrag(); return; }
      if (!dragState.active) {
        if (Math.abs(ev.clientX - dragState.startX) < 6 && Math.abs(ev.clientY - dragState.startY) < 6) return;
        dragState.active = true;
        dragState.base = new Set(state.selected);
        root.classList.add('gv2-dragging');
      }
      var m = getMarquee();
      m.classList.remove('gv2-marquee-hidden');
      m.style.left = Math.min(dragState.startX, ev.clientX) + 'px';
      m.style.top = Math.min(dragState.startY, ev.clientY) + 'px';
      m.style.width = Math.abs(ev.clientX - dragState.startX) + 'px';
      m.style.height = Math.abs(ev.clientY - dragState.startY) + 'px';
      applyMarquee(dragState.startX, dragState.startY, ev.clientX, ev.clientY);
    });
    document.addEventListener('pointerup', endDrag);
    document.addEventListener('pointercancel', endDrag);
    root.addEventListener('dragstart', function (ev) {
      if (state.selectMode && ev.target && ev.target.tagName === 'IMG') ev.preventDefault();
    });
    root.addEventListener('click', function (ev) {
      if (suppressClickOnce) { suppressClickOnce = false; return; }
      if (ev.target.closest && ev.target.closest('.gv2-check')) return;
      var btn = ev.target.closest ? ev.target.closest('.gv2-card-actions button') : null;
      if (btn) {
        ev.stopPropagation();
        var card = btn.closest('.gv2-card');
        var key = card.getAttribute('data-key');
        var row = state.rows.filter(function (r) { return r.uid === key; })[0];
        if (!row) return;
        var act = actionFor(row, btn.getAttribute('data-act'));
        if (act === 'trash' && !window.confirm('Trash now? The original file and media will be deleted (metadata kept).')) return;
        if (act === 'purge' && !window.confirm('Purge permanently? The trash metadata row will be removed for good.')) return;
        runAction(act, [key], {});
        return;
      }
      var cardClick = ev.target.closest ? ev.target.closest('.gv2-card') : null;
      if (cardClick) {
        if (state.selectMode) cardSelectClick(cardClick.getAttribute('data-key'), ev);
        else openDetail(cardClick.getAttribute('data-key'));
      }
    });
    document.addEventListener('keydown', function (ev) {
      var box = el('gv2-detail');
      var drawerOpen = box && !box.classList.contains('gv2-detail-hidden');

      // The fullscreen viewer owns the keyboard while a Gallery v2 image is
      // open, but the drawer's up/down rating shortcuts stay available so the
      // browser does not scroll the page instead.
      if (window.gv2LightboxNav) {
        if (isTypingTarget(ev.target)) return;
        if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
        if (ev.key === 'ArrowUp') {
          ev.preventDefault();
          if (!ev.repeat) detailApply('endorse');
        } else if (ev.key === 'ArrowDown') {
          ev.preventDefault();
          if (!ev.repeat) detailApply('dislike');
        }
        return;
      }

      // `_lightboxHandled` covers the same-tick race: the viewer's own Escape
      // handler clears gv2LightboxNav before this listener runs.
      if (ev._lightboxHandled) return;
      if (ev.key === 'Escape') {
        if (drawerOpen) { closeDetail(); return; }
        if (state.selectMode) setSelectMode(false);
        return;
      }
      if (!drawerOpen || isTypingTarget(ev.target)) return;
      if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
      if (ev.key === 'ArrowLeft') { ev.preventDefault(); detailNavigate(-1); }
      else if (ev.key === 'ArrowRight') { ev.preventDefault(); detailNavigate(1); }
      else if (ev.key === 'ArrowUp') { ev.preventDefault(); detailApply('endorse'); }
      else if (ev.key === 'ArrowDown') { ev.preventDefault(); detailApply('dislike'); }
      else if (ev.key === 'Delete') { ev.preventDefault(); detailTrash(); }
      else if (ev.key === 'a' || ev.key === 'A') { ev.preventDefault(); detailApply('archive'); }
    });
    var detailBox = el('gv2-detail');
    if (detailBox) {
      detailBox.addEventListener('click', function (ev) {
        if (ev.target === detailBox) closeDetail();
      });
    }
    // The split viewer is width-dependent: switching between the split stage
    // and the classic fullscreen lightbox must also work after a resize.
    window.addEventListener('resize', function () {
      var detailBox = el('gv2-detail');
      if (detailBox && !detailBox.classList.contains('gv2-detail-hidden')) applyDetailMediaMode();
      var nav = window.gv2LightboxNav;
      if (!nav) return;
      var split = detailSplitEnabled();
      if (split === nav.split) return;
      nav.split = split;
      applyDetailSplit(split);
      var lb = el('lightboxModal');
      if (lb) lb.classList.toggle('gv2-lightbox-split', split);
    });
  }

  function isTypingTarget(node) {
    if (!node || !node.tagName) return false;
    var tag = node.tagName.toLowerCase();
    return tag === 'input' || tag === 'textarea' || tag === 'select' || node.isContentEditable === true;
  }

  // ---------------------------------------------------------------- init

  var scheduled = false;
  function scheduleInit() {
    if (scheduled) return;
    scheduled = true;
    setTimeout(function () {
      scheduled = false;
      init();
    }, 250);
  }

  // Infinite scroll: the IntersectionObserver only fires on intersection
  // *changes*, so a batch that stays inside the margin never re-triggers
  // (visible in Mini thumb mode, where each batch is short). Re-check on
  // scroll and after every load instead.
  var _autoScrollHooked = false;
  var _autoScrollScheduled = false;

  function autoLoadCheck() {
    if (state.pageMode !== 'scroll' || !state.loadedOnce || state.busy) return;
    if (state.rows.length >= state.total) return;
    var wrap = el('gv2-more-wrap');
    if (!wrap || wrap.classList.contains('gv2-more-hidden')) return;
    var rect = wrap.getBoundingClientRect();
    if (!rect.width && !rect.height) return;
    var vh = window.innerHeight || document.documentElement.clientHeight || 0;
    if (rect.top <= vh + 600) loadPage(true);
  }

  function updateTopButton() {
    var btn = el('gv2-top');
    if (!btn) return;
    var y = window.scrollY || document.documentElement.scrollTop || 0;
    btn.classList.toggle('gv2-top-hidden', y <= 600);
  }

  function hookAutoScroll() {
    if (_autoScrollHooked) return;
    _autoScrollHooked = true;
    window.addEventListener('scroll', function () {
      if (_autoScrollScheduled) return;
      _autoScrollScheduled = true;
      requestAnimationFrame(function () {
        _autoScrollScheduled = false;
        updateTopButton();
        autoLoadCheck();
      });
    }, { passive: true });
    window.addEventListener('resize', function () { updateTopButton(); autoLoadCheck(); });
    updateTopButton();
  }

  function init() {
    var root = el(ROOT_ID);
    if (!root || root.dataset.gv2Init === '1') return;
    root.dataset.gv2Init = '1';
    loadPrefs();
    buildChrome(root);
    applyThumbSize();
    wireChips(root);
    wireGrid(root);
    wireCtxMenu();
    document.addEventListener('keydown', gv2Hotkeys);
    refreshViews();
    refreshFacets().then(function () { loadPage(false); });
    // infinite scroll
    if (window.IntersectionObserver) {
      var observer = new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting && state.loadedOnce && state.rows.length < state.total && !state.busy &&
              state.pageMode === 'scroll') {
            loadPage(true);
          }
        });
      }, { rootMargin: '600px' });
      observer.observe(el('gv2-more-wrap'));
    }
    hookAutoScroll();
  }

  document.addEventListener('DOMContentLoaded', function () {
    startObserver();
    scheduleInit();
  });
  startObserver();
  scheduleInit();

  // gradio renders the tab lazily - watch DOM mutations to mount when it appears
  var _observerStarted = false;
  function startObserver() {
    if (_observerStarted) return;
    var target = document.documentElement;
    if (!target) return;
    _observerStarted = true;
    new MutationObserver(scheduleInit).observe(target, { childList: true, subtree: true });
  }
})();
