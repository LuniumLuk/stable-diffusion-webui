/* Gallery v2 front-end: /gallery/api driven cards, filters, batch actions.
   Mounts into #gallery-v2-root (scripts/gallery_v2_tab.py). ASCII source. */
(function () {
  'use strict';

  var ROOT_ID = 'gallery-v2-root';
  var PAGE = 60;
  var FOLD_KEYS = ['options', 'groups', 'albums', 'sources', 'tags', 'views'];
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
  var THUMB_RATIOS = [
    ['1:1', '1:1'],
    ['2:3', '2:3'],
    ['3:2', '3:2']
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
    thumbRatio: '1:1', // card aspect: '1:1', '2:3' or '3:2'
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
    detailTrail: [], // uids visited by the "jump to parent" button, innermost last
    detailDetached: false, // detail shows an item outside the current page
    detailMediaLeft: false, // detail drawer: preview on the left stage instead of in the panel
    promptVariant: 'source', // 'source' or 'compiled' - which prompt the info panel shows / sends
    sendDefaults: {}, // bare send action -> variation id used by a plain click
    busy: false,
    loadedOnce: false,
    folds: { options: false, groups: false, albums: false, sources: false, tags: false, views: false }
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
    // mtime is part of the URL so a rewritten file (Composer "Override Origin")
    // bypasses the cached blob instead of showing the old picture
    var version = row && row.mtime ? '&v=' + encodeURIComponent(String(row.mtime)) : '';
    return '/gallery/api/blob?id=' + encodeURIComponent(row.uid) + '&kind=' + kind + version;
  }

  /** Archived items keep only a thumb blob (media policy), so that is the best
   *  in-app preview available for them. */
  function detailPreviewUrl(row) {
    return blobUrl(row, row && row.state === 'archived' ? 'thumb' : 'preview');
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
    ['img2img', '\u{1F5BC}\uFE0F  Image', 'Send the image to img2img (right-click for send variations)'],
    ['inpaint', '\u{1F3A8}  Inpaint', 'Send the image to inpaint (right-click for send variations)'],
    ['composer', '\u{1F9E9}  Composer', 'Open the image in the Composer tab'],
    ['censor', '\u{1F58A}\uFE0F  Censor', 'Open the image in the Censor panel']
  ];

  // Variations of the bare send actions (img2img / inpaint). '' is "image only",
  // which is also the built-in default for a plain click.
  var SEND_ONLY_VALUES = ['', 'prompt', 'image_prompt', 'all'];
  var SEND_ONLY_DEFS = [
    ['', '\u{1F5BC}\uFE0F  Send image only', 'Image only',
      'Send only the image \u2014 keep the current prompt and parameters'],
    ['prompt', '\u270E  Send prompt + negative only', 'Prompt + negative only',
      'Apply only the prompt and negative prompt \u2014 no image, no other settings'],
    ['image_prompt', '\u{1F5BC}\uFE0F  Send image + prompt (no settings)', 'Image + prompt',
      'Send the image AND apply the prompt + negative prompt \u2014 no other settings'],
    ['all', '\u{1F4E6}  Send all (image + prompt + settings)', 'Image + prompt + settings',
      'Send the image AND apply the prompt + parameters (the old full send)']
  ];

  function sendActionLabel(action) {
    for (var i = 0; i < SEND_ACTIONS.length; i++) {
      if (SEND_ACTIONS[i][0] === action) return SEND_ACTIONS[i][1].replace(/^\S+\s+/, '');
    }
    return action;
  }

  function sendOptionName(only) {
    for (var i = 0; i < SEND_ONLY_DEFS.length; i++) {
      if (SEND_ONLY_DEFS[i][0] === only) return SEND_ONLY_DEFS[i][2];
    }
    return '';
  }

  function sendActionTitle(action) {
    var tip = action;
    for (var i = 0; i < SEND_ACTIONS.length; i++) {
      if (SEND_ACTIONS[i][0] === action) tip = SEND_ACTIONS[i][2];
    }
    if (bareSendAction(action)) tip += ' \u2014 plain click: ' + sendOptionName(sendDefaultOnly(action));
    return tip;
  }

  function sendDefaultOnly(action) {
    var only = state.sendDefaults[action];
    if (only === undefined) {
      // prefs load asynchronously with the gallery tab; until that ran, trust the
      // stored value so the first click after a page load already honours it
      var stored = storedSendDefaults();
      if (stored) only = stored[action];
    }
    return SEND_ONLY_VALUES.indexOf(only) > -1 ? only : '';
  }

  function storedSendDefaults() {
    try {
      var prefs = JSON.parse(window.localStorage && window.localStorage.getItem(PREFS_KEY) || '{}') || {};
      return prefs.sendDefaults && typeof prefs.sendDefaults === 'object' ? prefs.sendDefaults : null;
    } catch (err) {
      return null;
    }
  }

  function setSendDefault(action, only) {
    if (SEND_ONLY_VALUES.indexOf(only) < 0) return;
    state.sendDefaults[action] = only;
    savePrefs();
  }

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

  /**
   * Cache a reference of the asset that is being sent to a transform. The
   * backend matches it by pixel signature when the generation is saved, and
   * records the parent on the new gallery item.
   */
  function pinLineage(uid, path) {
    if (!uid && !path) return;
    fetch('/gallery/api/lineage/pin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uid: uid || '', path: path || '', origin: 'desktop' })
    }).catch(function () { /* lineage is best-effort */ });
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
    // Cache the upstream reference: the next img2img/inpaint save is bound to it
    pinLineage(item.uid);
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
  // `after` runs once the switch (and its per-mode prompt restore) has landed:
  // writing the prompt before the switch would be overwritten by that restore.
  function goToImg2ImgSub(sub, item, after) {
    setTimeout(function () { switchToTabByName('img2img'); }, 200);
    setTimeout(function () {
      if (sub === 'inpaint') {
        if (typeof window.switch_to_inpaint === 'function') window.switch_to_inpaint();
      } else if (typeof window.switch_to_img2img === 'function') {
        window.switch_to_img2img();
      }
      if (item) injectImageInto(item, sub === 'inpaint' ? 'img2maskimg' : 'img2img_image');
      if (typeof after === 'function') setTimeout(after, 160);
    }, 360);
  }

  /** Write the prompt into the now-active mode; Gradio can re-apply the restored
   *  value a frame later, so the write is repeated once after it settles. */
  function applyPromptAfterSwitch(item) {
    if (!applyPromptOnly(item)) return false;
    setTimeout(function () { applyPromptOnly(item); }, 300);
    return true;
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
    // the per-mode parameter store diffs a full infotext paste against this
    // snapshot; without it, the mode switch's restore could undo the paste
    if (typeof window.img2imgModeParamsBeginPaste === 'function') window.img2imgModeParamsBeginPaste();
    var path = item.path || item.alias_path || '';
    var text = sendableText(item);
    if (action === 'txt2img') {
      if (!text) { toast('No prompt / parameters to send', true); return; }
      if (!applyInfotext(text, 'txt2img')) return;
      setTimeout(function () { switchToTabByName('txt2img'); }, 200);
      toast('To txt2img');
    } else if (action === 'img2img') {
      if (only === 'prompt') {
        goToImg2ImgSub('img2img', null, function () {
          if (applyPromptAfterSwitch(item)) toast('To img2img \u2014 prompt + negative only');
        });
      } else if (only === 'image_prompt') {
        goToImg2ImgSub('img2img', item, function () {
          if (applyPromptAfterSwitch(item)) toast('To img2img \u2014 image + prompt');
        });
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
        goToImg2ImgSub('inpaint', null, function () {
          if (applyPromptAfterSwitch(item)) toast('To inpaint \u2014 prompt + negative only');
        });
      } else if (only === 'image_prompt') {
        goToImg2ImgSub('inpaint', item, function () {
          if (applyPromptAfterSwitch(item)) toast('To inpaint \u2014 image + prompt');
        });
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

  // The txt2img/img2img result panel (javascript/outputPanelActions.js) reuses
  // this menu and the same remembered default, so both entry points send the
  // identical payloads.
  window.gallerySendMenu = {
    actionLabel: sendActionLabel,
    optionName: sendOptionName,
    defaultOnly: sendDefaultOnly,
    openOptions: function (ev, action, onPick) {
      openSendOptionsMenu(ev, makeSendOptions(action, function (only) {
        return function () { onPick(only); };
      }));
    },
  };

  // Re-query + repaint the grid (used after a file was rewritten in place,
  // e.g. the Composer's "Override Origin").
  window.galleryV2Refresh = function () {
    if (!el(ROOT_ID)) return;
    refreshFacets();
    resetAndRefresh();
  };

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
  // item's prompt + negative prompt (no image, no other settings). Every row
  // carries a star that makes that variation the default for a plain click.
  function makeSendOptions(action, makeRun) {
    return {
      action: action,
      options: SEND_ONLY_DEFS.map(function (def) {
        return {
          id: def[0],
          label: def[1],
          title: def[3],
          run: makeRun(def[0]),
        };
      }),
    };
  }

  function renderSendOptions(sub, spec) {
    var current = sendDefaultOnly(spec.action);
    sub.textContent = '';
    spec.options.forEach(function (opt) {
      var isDefault = opt.id === current;
      var row = document.createElement('div');
      row.className = 'gv2-ctx-row' + (isDefault ? ' gv2-ctx-row-default' : '');

      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'gv2-ctx-opt';
      btn.setAttribute('data-bare-send', opt.id);
      btn.textContent = opt.label;
      btn.title = opt.title;

      var star = document.createElement('button');
      star.type = 'button';
      star.className = 'gv2-ctx-star';
      star.setAttribute('data-send-default', opt.id);
      star.textContent = isDefault ? '\u2605' : '\u2606';
      star.title = isDefault
        ? 'Default variation for a plain click on ' + sendActionLabel(spec.action)
        : 'Set as the default for a plain click on ' + sendActionLabel(spec.action);

      row.append(btn, star);
      sub.appendChild(row);
    });

    var hint = document.createElement('div');
    hint.className = 'gv2-ctx-hint';
    hint.textContent = '\u2606 sets the default for a plain click';
    sub.appendChild(hint);
  }

  function openSendOptionsMenu(ev, spec) {
    closeCtxSub();
    var sub = document.createElement('div');
    sub.className = 'gv2-ctx gv2-ctx-sub';
    renderSendOptions(sub, spec);
    document.body.appendChild(sub);
    var w = sub.offsetWidth;
    var h = sub.offsetHeight;
    sub.style.left = Math.max(4, Math.min(ev.clientX, window.innerWidth - w - 6)) + 'px';
    sub.style.top = Math.max(4, Math.min(ev.clientY, window.innerHeight - h - 6)) + 'px';
    sub.addEventListener('click', function (e) {
      var star = e.target.closest ? e.target.closest('[data-send-default]') : null;
      if (star) {
        e.preventDefault();
        e.stopPropagation();
        var only = star.getAttribute('data-send-default');
        setSendDefault(spec.action, only);
        renderSendOptions(sub, spec);
        toast('Default for ' + sendActionLabel(spec.action) + ': ' + sendOptionName(only));
        return;
      }
      var pick = e.target.closest ? e.target.closest('[data-bare-send]') : null;
      if (!pick) return;
      closeCtxSub();
      var id = pick.getAttribute('data-bare-send');
      for (var i = 0; i < spec.options.length; i++) {
        if (spec.options[i].id === id) { spec.options[i].run(); return; }
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
      btn.title = sendActionTitle(def[0]);
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
      var action = btn.getAttribute('data-send');
      sendItemByKey(key, action, bareSendAction(action) ? { only: sendDefaultOnly(action) } : undefined);
    });
    menu.addEventListener('contextmenu', function (e) {
      var btn = e.target.closest ? e.target.closest('[data-send]') : null;
      if (!btn) return;
      var action = btn.getAttribute('data-send');
      if (!bareSendAction(action)) return;
      e.preventDefault();
      e.stopPropagation();
      openSendOptionsMenu(e, makeSendOptions(action, function (only) {
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

  // Foldable toolbar section: the header stays visible (and shrinks to a pill
  // when folded) while the body is hidden, so the frequently used rows above
  // keep their space.
  function foldSection(key, label, bodyHtml) {
    return '<section class="gv2-fold" data-fold="' + key + '">' +
      '<button type="button" class="gv2-fold-head" data-fold-toggle="' + key + '" aria-expanded="true" ' +
        'title="Fold or unfold ' + esc(label) + '">' +
        '<span class="gv2-fold-caret" aria-hidden="true">\u25BE</span>' +
        '<span class="gv2-row-label">' + esc(label) + '</span>' +
        '<span class="gv2-fold-n" id="gv2-fold-n-' + key + '"></span>' +
      '</button>' +
      bodyHtml +
    '</section>';
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
        '</div>' +
        '<div class="gv2-row gv2-row-states">' +
          '<div class="gv2-states-inline" id="gv2-states"></div>' +
          '<span class="gv2-adv-sep"></span>' +
          '<button id="gv2-sync" class="gv2-btn" title="Re-index output folders into the gallery store">Sync</button>' +
          '<button id="gv2-empty-trash" class="gv2-btn gv2-btn-danger" title="Permanently delete all trashed metadata rows">Empty Trash</button>' +
          '<button id="gv2-trash-disliked" class="gv2-btn gv2-btn-danger" title="Move every disliked item to trash (original files and media are deleted; metadata kept)">\u{1F5D1} Trash Disliked</button>' +
          '<button id="gv2-trash-archived" class="gv2-btn gv2-btn-danger" title="Move every archived item to trash (original files and media are deleted; metadata kept)">\u{1F5D1} Trash Archived</button>' +
          '<button id="gv2-archive-unrated" class="gv2-btn gv2-btn-danger" title="Archive every unrated active item, including albumed ones (staged items are kept; leaves the active view; auto-trashed after 24 h unless endorsed)">\u{1F4E6} Archive Unrated</button>' +
          '<button id="gv2-archive-current" class="gv2-btn gv2-btn-danger" title="Archive all items matching the current filter (leaves the active view; auto-trashed after 24 h unless endorsed)">\u{1F4E6} Archive Current</button>' +
        '</div>' +
        '<div class="gv2-folds">' +
          foldSection('options', 'Options',
            '<div class="gv2-row gv2-row-adv gv2-fold-body" id="gv2-options">' +
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
              '<select id="gv2-thumb-ratio" class="gv2-select" title="Thumbnail aspect ratio">' +
                THUMB_RATIOS.map(function (r) { return '<option value="' + r[0] + '">Thumb: ' + r[1] + '</option>'; }).join('') +
              '</select>' +
              '<span class="gv2-adv-sep"></span>' +
              '<span class="gv2-row-label">Date</span>' +
              '<input type="date" id="gv2-date-from" class="gv2-date" title="From date (inclusive)">' +
              '<span class="gv2-adv-dash">\u2013</span>' +
              '<input type="date" id="gv2-date-to" class="gv2-date" title="To date (inclusive)">' +
              '<button id="gv2-date-clear" class="gv2-btn gv2-btn-quiet" title="Clear the custom date range">\u2715 Clear dates</button>' +
            '</div>') +
          foldSection('groups', 'Quick filters', '<div class="gv2-row gv2-fold-body" id="gv2-groups"></div>') +
          foldSection('albums', 'Albums', '<div class="gv2-row gv2-albums gv2-fold-body" id="gv2-albums"></div>') +
          foldSection('sources', 'Sources', '<div class="gv2-row gv2-fold-body" id="gv2-sources"></div>') +
          foldSection('tags', 'Tags', '<div class="gv2-row gv2-fold-body" id="gv2-tags"></div>') +
          foldSection('views', 'Saved filters', '<div class="gv2-row gv2-fold-body" id="gv2-views"></div>') +
        '</div>' +
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
        '<button class="gv2-btn gv2-btn-quiet gv2-batch-exit" data-batch="exitselect" title="Leave select mode (Esc)">\u2715 Exit select</button>' +
        '<span class="gv2-adv-sep gv2-batch-sep"></span>' +
        '<button class="gv2-btn gv2-btn-quiet" data-batch="selectpage" title="Select all items currently loaded in the grid">Select shown</button>' +
        '<button class="gv2-btn" data-batch="compare" disabled ' +
          'title="Open the compare window for the selected images (drag the list to reorder)">\u2194 Compare window</button>' +
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
      scrollPaneToTop();
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
    el('gv2-thumb-ratio').value = state.thumbRatio;
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
    el('gv2-thumb-ratio').addEventListener('change', function () {
      state.thumbRatio = thumbRatioValue(el('gv2-thumb-ratio').value);
      savePrefs();
      applyThumbRatio();
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
      if (action === 'exitselect') { setSelectMode(false); return; }
      if (action === 'selectpage') { selectPage(); return; }
      if (action === 'compare') { openCompareWindow(); return; }
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
      applyFolds();
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
    var html = '<div class="gv2-albums-head">';
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
    applyFolds();
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
    var html = '';
    (state.facets.sources || []).forEach(function (src) {
      var active = (state.filters.sources || []).indexOf(src.id) >= 0;
      html += countChip(src.label, src.count, active, 'data-source="' + esc(src.id) + '"');
    });
    srcBox.innerHTML = html;

    var tagBox = el('gv2-tags');
    if (tagBox) {
      var tags = (state.facets.workflow_tags || []).slice(0, 24);
      var html2 = '';
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
    var html = '';
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
    applyFolds();
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
    var html = '';
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
    applyFolds();
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
      state.thumbRatio = thumbRatioValue(prefs.thumbRatio);
      if (prefs.detailMediaLeft === true) state.detailMediaLeft = true;
      if (prefs.promptVariant === 'compiled') state.promptVariant = 'compiled';
      if (prefs.folds && typeof prefs.folds === 'object') {
        FOLD_KEYS.forEach(function (key) {
          if (prefs.folds[key] === true) state.folds[key] = true;
        });
      }
      if (prefs.sendDefaults && typeof prefs.sendDefaults === 'object') {
        ['img2img', 'inpaint'].forEach(function (action) {
          var only = prefs.sendDefaults[action];
          if (SEND_ONLY_VALUES.indexOf(only) > -1) state.sendDefaults[action] = only;
        });
      }
    } catch (err) { /* ignore bad prefs */ }
  }

  function savePrefs() {
    try {
      window.localStorage.setItem(PREFS_KEY, JSON.stringify({
        pageMode: state.pageMode,
        pageSize: state.pageSize,
        thumbSize: state.thumbSize,
        thumbRatio: state.thumbRatio,
        detailMediaLeft: !!state.detailMediaLeft,
        promptVariant: state.promptVariant === 'compiled' ? 'compiled' : 'source',
        sendDefaults: state.sendDefaults,
        folds: state.folds
      }));
    } catch (err) { /* ignore */ }
  }

  function applyThumbSize() {
    var root = el(ROOT_ID);
    if (!root) return;
    ['xs', 's', 'm', 'l'].forEach(function (k) { root.classList.remove('gv2-thumb-' + k); });
    root.classList.add('gv2-thumb-' + (state.thumbSize || 'm'));
  }

  // Only the accepted ratios reach the DOM class, so a hand-edited pref can never
  // inject an arbitrary class name.
  function thumbRatioValue(value) {
    for (var i = 0; i < THUMB_RATIOS.length; i++) {
      if (THUMB_RATIOS[i][0] === value) return value;
    }
    return '1:1';
  }

  function applyThumbRatio() {
    var root = el(ROOT_ID);
    if (!root) return;
    THUMB_RATIOS.forEach(function (r) { root.classList.remove('gv2-ratio-' + r[0].replace(':', 'x')); });
    root.classList.add('gv2-ratio-' + thumbRatioValue(state.thumbRatio).replace(':', 'x'));
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
        fitPane();
        setTimeout(autoLoadCheck, 60);
      });
  }

  function updateCountLine() {
    var line = el('gv2-count');
    if (!line) return;
    var filters = activeFilterCount();
    var html = '<span class="gv2-count-total">' + state.total + ' item(s)</span>';
    if (filters > 0) {
      html += '<span class="gv2-count-dot">\u00B7</span>' +
        '<span class="gv2-count-filters">' + filters + ' filter(s)</span>';
    }
    if (state.rows.length < state.total) {
      html += '<span class="gv2-count-dot">\u00B7</span>' +
        '<span class="gv2-count-shown">showing ' + state.rows.length + '</span>';
    }
    line.innerHTML = html;
  }

  // ---------------------------------------------------------------- cards

  function badge(text, cls) {
    return '<span class="gv2-badge ' + (cls || '') + '">' + esc(text) + '</span>';
  }

  function lineageCapsules(row) {
    // lineage_op is display-ready and empty for rows with no generation step
    // (e.g. an endorsed copy), so the capsule never repeats a rating badge
    var op = row.lineage_op || row.op_label || '';
    if (!op) return '';
    var parent = row.parent_lineage_op || row.parent_op_label || '';
    return '<div class="gv2-card-lineage">' +
      '<span class="gv2-capsule gv2-op" title="generated by: ' + esc(op) + '">' + esc(op) + '</span>' +
      (parent
        ? '<span class="gv2-capsule gv2-op-parent" title="parent generated by: ' + esc(parent) + '">' + esc(parent) + '</span>'
        : '') +
      '</div>';
  }

  function cardHtml(row) {
    var rating = ratingOf(row);
    var expired = expiryText(row);
    var muted = row.state === 'archived' || rating === 'disliked';
    var flags = '';
    if (rating === 'endorsed') flags += ' gv2-card-endorsed';
    else if (rating === 'disliked') flags += ' gv2-card-disliked';
    if (row.state === 'archived') flags += ' gv2-card-archived';
    if (row.state === 'staged') flags += ' gv2-card-staged';
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
    var stamp = fmtCardTime(row.mtime);
    if (stamp) caps.push('<span class="gv2-capsule">' + stamp + '</span>');

    var selected = state.selected.has(row.uid) ? ' gv2-card-selected' : '';
    return '<div class="gv2-card' + selected + flags + '" data-key="' + esc(row.uid) + '">' +
      thumb +
      (muted ? '<div class="gv2-strike"></div>' : '') +
      '<div class="gv2-veil"></div>' +
      '<div class="gv2-card-topleft">' + lineageCapsules(row) +
        '<div class="gv2-card-badges">' + badges + '</div>' +
      '</div>' +
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
    bar.classList.toggle('gv2-batch-selecting', state.selectMode);
    var compareBtn = bar.querySelector('[data-batch="compare"]');
    if (compareBtn) {
      var enough = state.selected.size >= 2;
      compareBtn.disabled = !enough;
      compareBtn.title = enough
        ? 'Open the compare window for the ' + state.selected.size + ' selected image(s) (drag the list to reorder)'
        : 'Select at least two images to open the compare window';
    }
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

  // ---------------------------------------------------------------- folds

  function foldActiveCount(key) {
    var f = state.filters || {};
    if (key === 'options') return (f.since ? 1 : 0) + (f.until ? 1 : 0);
    if (key === 'groups') {
      var active = 0;
      ((state.facets || {}).groups || []).forEach(function (group) {
        if (groupActive(group)) active++;
      });
      return active;
    }
    if (key === 'albums') return (f.albums || []).length + (f.show_albumed ? 1 : 0);
    if (key === 'sources') return (f.sources || []).length;
    if (key === 'tags') {
      var tags = f.tags || {};
      return Object.keys(tags).reduce(function (n, k) { return n + (tags[k] || []).length; }, 0);
    }
    if (key === 'views') return (state.views || []).some(viewIsActive) ? 1 : 0;
    return 0;
  }

  function applyFolds() {
    var root = el(ROOT_ID);
    if (!root) return;
    FOLD_KEYS.forEach(function (key) {
      var section = root.querySelector('.gv2-fold[data-fold="' + key + '"]');
      if (!section) return;
      var folded = !!state.folds[key];
      section.classList.toggle('gv2-fold-collapsed', folded);
      var head = section.querySelector('.gv2-fold-head');
      if (head) head.setAttribute('aria-expanded', folded ? 'false' : 'true');
      var badge = el('gv2-fold-n-' + key);
      if (badge) {
        var n = foldActiveCount(key);
        badge.textContent = n > 0 ? n + ' active' : '';
      }
    });
  }

  function toggleFold(key) {
    if (FOLD_KEYS.indexOf(key) < 0) return;
    state.folds[key] = !state.folds[key];
    savePrefs();
    applyFolds();
  }

  function wireFolds(root) {
    root.addEventListener('click', function (ev) {
      var head = ev.target.closest ? ev.target.closest('[data-fold-toggle]') : null;
      if (!head) return;
      toggleFold(head.getAttribute('data-fold-toggle'));
    });
  }

  // The shortcuts are advertised in the toolbar's top row (#gv2-keys):
  //   R = clear filters + refresh + Sync        S = toggle select mode
  // Inert while typing, while a viewer owns the keyboard, or when the gallery
  // page is not the visible tab.
  function gv2Hotkeys(ev) {
    if (ev.defaultPrevented || ev.repeat) return;
    if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
    if (window.gv2LightboxNav || ev._lightboxHandled) return;
    if (el('gv2-compare')) return;
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
    if (state.detailKey !== uid) state.detailTrail = [];
    openDetailUid(uid, opts);
  }

  /**
   * A parent target is usually outside the current page/filter, so the jump
   * renders an item that is not in state.rows. The trail keeps a way back.
   */
  function openDetailUid(uid, opts) {
    if (!uid) return;
    var row = state.rows.filter(function (r) { return r.uid === uid; })[0];
    if (opts && opts.pushTrail && state.detailKey && state.detailKey !== uid) {
      state.detailTrail.push(state.detailKey);
    }
    state.detailKey = uid;
    state.detailDetached = !row;
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
      detailViewerSrc(item, detailPreviewUrl(row), function (src) {
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

  function detailToggleStage() {
    var row = detailRow();
    if (!row || row.state === 'trashed') return;
    if (row.state === 'archived') {
      toast('unarchive it first to stage', true);
      return;
    }
    if (row.state !== 'staged' && ratingOf(row)) {
      toast('rated items (endorse/dislike) cannot be staged', true);
      return;
    }
    detailApply('stage');
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
          ? 'The prompt as written with the @PICK groups drawn (comments and every @IF branch kept)'
          : 'No compiled prompt recorded for this image - it was generated before this was stored') +
      '</span>';
  }

  function promptVariantHint(item) {
    if (state.promptVariant !== 'compiled') return '';
    if (!hasCompiledPrompt(item)) {
      return '<div class="gv2-row-hint">No compiled prompt recorded for this image - showing the source prompt.</div>';
    }
    return '<div class="gv2-row-hint">Compiled prompt: as written with the @PICK groups drawn — comments, disabled groups and every @IF branch kept.</div>';
  }

  /**
   * Lineage block: how this file was made, how its parent was made, and the
   * jump button. The button stays visible but disabled when the parent record
   * is gone, so the chain never silently looks like a root.
   */
  function lineageSectionHtml(item) {
    var op = item.op_label || '';
    var parent = item.parent || null;
    var origin = (item.origin && item.origin.op_label) || '';
    var rows = [];
    var buttons = '';

    if (!op && !parent && !state.detailTrail.length) return '';

    if (parent) {
      var parentLabel = '\u2191 Parent' + (parent.op_label || parent.op ? ' \u00b7 ' + esc(parent.op_label || parent.op) : '');
      if (parent.exists) {
        buttons += '<button class="gv2-btn gv2-btn-quiet" id="gv2-detail-parent" ' +
          'title="Open the image this one was derived from">' + parentLabel + '</button>';
      } else {
        var why = parent.reason === 'trashed' ? 'the parent is in the trash'
          : (parent.reason === 'missing' ? 'the parent file is gone' : 'the parent record no longer exists');
        buttons += '<button class="gv2-btn gv2-btn-quiet" id="gv2-detail-parent" disabled ' +
          'title="Cannot jump: ' + esc(why) + '">' + parentLabel + '</button>';
      }
    }
    if (state.detailTrail.length) {
      buttons += '<button class="gv2-btn gv2-btn-quiet" id="gv2-detail-back" ' +
        'title="Back to the image you came from">\u2190 Back</button>';
    }

    rows.push('<div class="gv2-detail-row"><span>Generated by</span><b>' + esc(op || 'not recorded') + '</b></div>');
    if (parent) {
      rows.push('<div class="gv2-detail-row"><span>From parent</span><b>' +
        esc(parent.op_label || parent.op || 'parent') + '</b></div>');
    }
    if (origin && origin !== op) {
      rows.push('<div class="gv2-detail-row"><span>Origin</span><b>' + esc(origin) + '</b></div>');
    }

    return '<div class="gv2-detail-section gv2-detail-lineage">' +
      '<div class="gv2-detail-label">Lineage</div>' +
      (state.detailDetached ? '<div class="gv2-row-hint">this item is outside the current filters</div>' : '') +
      rows.join('') +
      (buttons ? '<div class="gv2-detail-lineage-actions">' + buttons + '</div>' : '') +
      '</div>';
  }

  function reloadDetail(item) {
    return api('/gallery/api/item?id=' + encodeURIComponent(item.uid))
      .then(function (fresh) { renderDetail(fresh); })
      .catch(function () {});
  }

  function renderDetail(item) {
    var box = el('gv2-detail');
    if (!box) return;
    box.innerHTML = '<div class="gv2-detail-stage"></div>' +
      '<div class="gv2-detail-panel">' + detailPanelHtml(item, true) + '</div>';
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
      // item dimensions can be missing on old rows - the loaded picture knows better
      var mediaBox = box.querySelector('.gv2-detail-media');
      var syncMediaRatio = function () {
        if (!mediaBox || !detailImg.naturalWidth || !detailImg.naturalHeight) return;
        mediaBox.style.setProperty('--gv2-media-ar',
          (detailImg.naturalWidth / detailImg.naturalHeight).toFixed(4));
      };
      syncMediaRatio();
      detailImg.addEventListener('load', syncMediaRatio);
      // a dropped/missing preview blob still leaves the thumb on screen
      detailImg.addEventListener('error', function () {
        if (detailImg.dataset.fallback === 'thumb') return;
        detailImg.dataset.fallback = 'thumb';
        detailImg.src = blobUrl(item, 'thumb');
      });
      detailImg.addEventListener('click', function () { openDetailViewer(item); });
    }
    wireDetailPanel(box, item, { markCard: true });
  }

  /**
   * Markup of the detail panel. `withMedia` keeps the preview and the toggle
   * that moves it to the stage; the compare window shows the picture in its own
   * stage and asks for the metadata-only panel.
   */
  function detailPanelHtml(item, withMedia) {
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
    // The preview carries the same marks as the grid cards: a coloured ring for
    // a rating or a stage, grey slashes + a dimmed picture for an archived item.
    var rating = ratingOf(item);
    var mediaFlags = '';
    if (rating === 'endorsed') mediaFlags += ' gv2-detail-media-endorsed';
    else if (rating === 'disliked') mediaFlags += ' gv2-detail-media-disliked';
    if (item.state === 'staged') mediaFlags += ' gv2-detail-media-staged';
    if (item.state === 'archived') mediaFlags += ' gv2-detail-media-archived';
    // the box hugging the picture is sized from its aspect ratio, so the ring and
    // the slashes land on the image instead of the empty stage around it
    var mediaStyle = (item.width && item.height)
      ? ' style="--gv2-media-ar:' + (item.width / item.height).toFixed(4) + '"'
      : '';
    var img = item.state === 'trashed'
      ? '<div class="gv2-thumb gv2-thumb-empty">no media (trash)</div>'
      : '<div class="gv2-detail-media' + mediaFlags + '"' + mediaStyle + '>' +
          '<img class="gv2-detail-img" src="' + detailPreviewUrl(item) + '" alt="" ' +
            'title="Click to open the fullscreen viewer (wheel = zoom, drag = pan)">' +
          (item.state === 'archived' ? '<div class="gv2-strike"></div>' : '') +
        '</div>';
    var tagPills = (item.tags || []).filter(function (t) { return t.category === 'workflow'; })
      .map(function (t) {
        return '<span class="gv2-tag">' + esc(t.name) +
          ' <button class="gv2-tag-x" data-remove-tag="' + esc(t.name) + '">\u00d7</button></span>';
      }).join('');
    var events = (item.events || []).slice(0, 6).map(function (e) {
      return esc(e.event) + ' \u00b7 ' + esc(e.at);
    }).join('<br>');
    var expiry = expiryText(item);
    var head = withMedia === false ? '' :
      '<div class="gv2-detail-head">' +
        '<button id="gv2-detail-media-toggle" class="gv2-detail-media-toggle" ' +
          'title="Show the preview on the left">\u25a5</button>' +
        '<button id="gv2-detail-close" class="gv2-detail-close">\u00d7</button>' +
      '</div>';
    var media = withMedia === false ? '' : '<div class="gv2-detail-img-wrap">' + img + '</div>';
    return head + media +
      '<div class="gv2-detail-body">' +
          (item.state !== 'trashed'
            ? '<div class="gv2-detail-fileops">' +
                '<button class="gv2-btn gv2-btn-quiet" data-detail-op="download" ' +
                  'title="Download the original file (falls back to the stored preview if it is gone)">\u2B07 Download</button>' +
                '<button class="gv2-btn gv2-btn-quiet" data-detail-op="explorer" ' +
                  'title="Reveal the file in the system file manager">\u{1F4C2} Find in Explorer</button>' +
              '</div>'
            : '') +
          lineageSectionHtml(item) +
          '<div class="gv2-detail-badges">' +
            (item.state && item.state !== 'active' ? badge(item.state, 'gv2-badge-' + item.state) : '') +
            (expiry ? badge(expiry, 'gv2-badge-archived') : '') +
            (item.has_composer ? badge('composer state', 'gv2-badge-variant') : '') +
          '</div>' +
          '<div class="gv2-detail-actions">' + detailActionButtons(item) + '</div>' +
          '<div class="gv2-detail-keys">' +
            '<span><kbd>\u2190</kbd><kbd>\u2192</kbd> or <kbd>A</kbd><kbd>D</kbd> prev / next</span>' +
            '<span><kbd>\u2191</kbd> endorse</span>' +
            '<span><kbd>\u2193</kbd> dislike</span>' +
            '<span><kbd>Del</kbd> trash</span>' +
            '<span><kbd>X</kbd> archive</span>' +
            '<span><kbd>S</kbd> stage</span>' +
            '<span><kbd>Esc</kbd> close</span>' +
          '</div>' +
          '<div class="gv2-detail-section"><div class="gv2-detail-label"><span>Send to</span>' +
            '<span class="gv2-row-hint">prompt: ' + (state.promptVariant === 'compiled' && hasCompiledPrompt(item) ? 'compiled' : 'source') + '</span></div>' +
            '<div class="gv2-detail-send">' +
              SEND_ACTIONS.map(function (def) {
                return '<button class="gv2-btn gv2-btn-quiet" data-send-act="' + def[0] + '" title="' + esc(sendActionTitle(def[0])) + '">' + def[1] + '</button>';
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
        '</div>';
  }

  /**
   * Wires every control of a rendered detail panel. `scope` holds the markup -
   * the detail drawer or the compare window column.
   */
  function wireDetailPanel(scope, item, opts) {
    opts = opts || {};
    var rerender = opts.rerender || function () { return reloadDetail(item); };
    var panelEl = scope.classList && scope.classList.contains('gv2-detail-panel')
      ? scope
      : scope.querySelector('.gv2-detail-panel');
    scope.querySelectorAll('[data-detail-op]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var op = btn.getAttribute('data-detail-op');
        if (op === 'download') downloadItem(item);
        else if (op === 'explorer') revealItem(item);
      });
    });
    var parentBtn = scope.querySelector('#gv2-detail-parent');
    if (parentBtn && item.parent && item.parent.exists) {
      parentBtn.addEventListener('click', function () {
        if (opts.openParent) { opts.openParent(item.parent.uid); return; }
        openDetailUid(item.parent.uid, { pushTrail: true });
      });
    }
    var backBtn = scope.querySelector('#gv2-detail-back');
    if (backBtn) {
      backBtn.addEventListener('click', function () {
        var previous = state.detailTrail.pop();
        if (previous) openDetailUid(previous);
      });
    }
    scope.querySelectorAll('[data-send-act]').forEach(function (btn) {
      var act = btn.getAttribute('data-send-act');
      btn.addEventListener('click', function () {
        if (opts.beforeSend) opts.beforeSend();
        sendItemTo(item, act, bareSendAction(act) ? { only: sendDefaultOnly(act) } : undefined);
      });
      if (bareSendAction(act)) {
        btn.addEventListener('contextmenu', function (e) {
          e.preventDefault();
          e.stopPropagation();
          openSendOptionsMenu(e, makeSendOptions(act, function (only) {
            return function () { sendItemTo(item, act, { only: only }); };
          }));
        });
      }
    });
    scope.querySelectorAll('[data-detail-act]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var act = actionFor(item, btn.getAttribute('data-detail-act'));
        runAction(act, [item.uid], {}).then(function () {
          if (opts.markCard) markDetailCard(false);
          return rerender();
        });
      });
    });
    var addBtn = scope.querySelector('#gv2-detail-tagadd');
    if (addBtn) {
      addBtn.addEventListener('click', function () {
        var value = scope.querySelector('#gv2-detail-taginput').value.trim();
        if (!value) return;
        runAction('add_tag', [item.uid], { tag: value, category: 'workflow' }).then(function () {
          api('/gallery/api/item?id=' + encodeURIComponent(item.uid)).then(rerender).catch(function () {});
          refreshFacets();
        });
      });
    }
    scope.querySelectorAll('[data-remove-tag]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        runAction('remove_tag', [item.uid], { tag: btn.getAttribute('data-remove-tag'), category: 'workflow' })
          .then(function () {
            api('/gallery/api/item?id=' + encodeURIComponent(item.uid)).then(rerender).catch(function () {});
            refreshFacets();
          });
      });
    });
    var copyBtn = scope.querySelector('#gv2-copy-prompt');
    if (copyBtn) {
      copyBtn.addEventListener('click', function () {
        if (navigator.clipboard) navigator.clipboard.writeText(activePrompt(item));
        toast(state.promptVariant === 'compiled' && hasCompiledPrompt(item) ? 'Compiled prompt copied' : 'Prompt copied');
      });
    }
    scope.querySelectorAll('[data-prompt-variant]').forEach(function (btn) {
      btn.addEventListener('click', function (ev) {
        ev.stopPropagation();
        var next = btn.getAttribute('data-prompt-variant');
        if (next !== 'source' && next !== 'compiled') return;
        if (state.promptVariant === next) return;
        state.promptVariant = next;
        savePrefs();
        // re-render in place, keeping the panel where the user was reading
        var panel = panelEl;
        var scroll = panel ? panel.scrollTop : 0;
        var done = rerender();
        var restore = function () { if (panelEl) panelEl.scrollTop = scroll; };
        if (done && typeof done.then === 'function') done.then(restore, restore);
        else restore();
      });
    });
    var albumSetBtn = scope.querySelector('#gv2-detail-album-set');
    if (albumSetBtn) {
      albumSetBtn.addEventListener('click', function () {
        var pick = scope.querySelector('#gv2-detail-album-pick');
        if (!pick || !pick.value) { toast('Pick an album first', true); return; }
        api('/gallery/api/albums/items', { album: parseInt(pick.value, 10), add: [item.uid], remove: [] })
          .then(function (data) {
            state.albums = (data && data.albums) || [];
            renderAlbums();
            toast('added to album');
            return rerender();
          })
          .then(function () { resetAndRefresh(); })
          .catch(function (err) { toast('Album add failed: ' + err.message, true); });
      });
    }
    var albumRemoveBtn = scope.querySelector('#gv2-detail-album-remove');
    if (albumRemoveBtn) {
      albumRemoveBtn.addEventListener('click', function () {
        if (!item.album_id) { toast('not in an album', true); return; }
        api('/gallery/api/albums/items', { album: item.album_id, add: [], remove: [item.uid] })
          .then(function (data) {
            state.albums = (data && data.albums) || [];
            renderAlbums();
            toast('removed from album');
            return rerender();
          })
          .then(function () { resetAndRefresh(); })
          .catch(function (err) { toast('Album remove failed: ' + err.message, true); });
      });
    }
    var albumCoverBtn = scope.querySelector('#gv2-detail-album-cover');
    if (albumCoverBtn) {
      albumCoverBtn.addEventListener('click', function () {
        if (!item.album_id) { toast('add it to an album first', true); return; }
        api('/gallery/api/albums/cover', { album: item.album_id, key: item.uid })
          .then(function (data) {
            state.albums = (data && data.albums) || [];
            renderAlbums();
            toast('album cover updated');
            return rerender();
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
    state.detailTrail = [];
    state.detailDetached = false;
    markDetailCard(false);
  }

  // ------------------------------------------------------------- compare

  // Overlay launched from select mode: the selected images in their own order
  // (drag the list to reorder - the grid keeps its order), one large preview of
  // the active image, and the regular detail panel beside it.
  var cmp = { keys: [], active: null, items: {}, dragging: null };

  function compareOpen() { return !!el('gv2-compare'); }

  function compareRow(uid) {
    for (var i = 0; i < state.rows.length; i++) {
      if (state.rows[i].uid === uid) return state.rows[i];
    }
    return null;
  }

  function compareItem(uid) {
    return cmp.items[uid] || compareRow(uid) || null;
  }

  function compareFileName(row) {
    var name = row.rel_path || row.path || row.uid || '';
    return String(name).split(/[\\/]/).pop();
  }

  function compareMarks(row) {
    var rating = ratingOf(row);
    var marks = '';
    if (rating === 'endorsed') marks += ' is-endorsed';
    else if (rating === 'disliked') marks += ' is-disliked';
    if (row.state === 'staged') marks += ' is-staged';
    if (row.state === 'archived') marks += ' is-archived';
    return marks;
  }

  function loadCompareItem(uid, force) {
    if (!uid) return Promise.reject(new Error('no item'));
    if (!force && cmp.items[uid]) return Promise.resolve(cmp.items[uid]);
    return api('/gallery/api/item?id=' + encodeURIComponent(uid)).then(function (item) {
      cmp.items[uid] = item;
      return item;
    });
  }

  function openCompareWindow() {
    var keys = [];
    state.rows.forEach(function (row) {
      if (state.selected.has(row.uid)) keys.push(row.uid);
    });
    if (keys.length < 2) { toast('Select at least two images to compare', true); return; }
    closeCompareWindow();
    closeDetail();
    cmp.keys = keys;
    cmp.active = keys[0];
    cmp.items = {};
    cmp.dragging = null;
    var root = el(ROOT_ID);
    if (!root) return;
    var host = document.createElement('div');
    host.id = 'gv2-compare';
    host.className = 'gv2-compare';
    host.innerHTML =
      '<div class="gv2-compare-shell" role="dialog" aria-label="Compare window">' +
        '<div class="gv2-compare-head">' +
          '<span class="gv2-compare-title">Compare <span class="gv2-compare-total">' + keys.length + '</span></span>' +
          '<span class="gv2-compare-hint">drag the strip to reorder \u00b7 click to preview \u00b7 \u2190 \u2192 / A D step \u00b7 X archive \u00b7 S stage \u00b7 Esc close</span>' +
          '<button class="gv2-compare-close" title="Close the compare window (Esc)">\u00d7</button>' +
        '</div>' +
        '<div id="gv2-compare-list" class="gv2-compare-list"></div>' +
        '<div class="gv2-compare-body">' +
          '<div id="gv2-compare-stage" class="gv2-compare-stage"></div>' +
          '<div id="gv2-compare-detail" class="gv2-detail-panel gv2-compare-detail"></div>' +
        '</div>' +
      '</div>';
    root.appendChild(host);
    document.documentElement.classList.add('gv2-compare-open');
    host.querySelector('.gv2-compare-close').addEventListener('click', closeCompareWindow);
    host.addEventListener('click', function (ev) {
      if (ev.target === host) closeCompareWindow();
    });
    wireCompareList();
    renderCompareList();
    loadCompareItem(cmp.active).then(function (item) {
      renderCompareStage(item);
      renderCompareDetail(item);
    }).catch(function (err) { toast('Compare failed: ' + err.message, true); });
  }

  function closeCompareWindow() {
    var host = el('gv2-compare');
    if (host && host.parentNode) host.parentNode.removeChild(host);
    document.documentElement.classList.remove('gv2-compare-open');
    cmp.keys = [];
    cmp.active = null;
    cmp.items = {};
    cmp.dragging = null;
  }

  function renderCompareList() {
    var list = el('gv2-compare-list');
    if (!list) return;
    var scrollLeft = list.scrollLeft;
    var html = '';
    cmp.keys.forEach(function (uid, index) {
      var row = compareItem(uid);
      if (!row) return;
      var active = uid === cmp.active;
      var rating = ratingOf(row);
      var sub = [];
      if (row.width && row.height) sub.push(row.width + '\u00d7' + row.height);
      if (rating === 'endorsed') sub.push('\u2b50 endorsed');
      else if (rating === 'disliked') sub.push('\u{1F44E} disliked');
      if (row.state && row.state !== 'active') sub.push(row.state);
      var name = compareFileName(row);
      html += '<div class="gv2-compare-item' + (active ? ' is-active' : '') + compareMarks(row) + '"' +
        ' draggable="true" data-key="' + esc(uid) + '" title="' + esc(name) + '">' +
        '<span class="gv2-compare-num">' + (index + 1) + '</span>' +
        (row.state === 'trashed'
          ? '<span class="gv2-compare-thumb gv2-thumb-empty">no media</span>'
          : '<img class="gv2-compare-thumb" src="' + blobUrl(row, 'thumb') + '" alt="" draggable="false">') +
        '<span class="gv2-compare-name">' + esc(name) + '</span>' +
        '<span class="gv2-compare-sub">' + esc(sub.join(' \u00b7 ')) + '</span>' +
      '</div>';
    });
    list.innerHTML = html || '<div class="gv2-compare-empty">nothing selected</div>';
    list.scrollLeft = scrollLeft;
    var activeNode = list.querySelector('.gv2-compare-item.is-active');
    if (activeNode && activeNode.scrollIntoView) {
      activeNode.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
  }

  function clearCompareDropMarks() {
    var list = el('gv2-compare-list');
    if (!list) return;
    list.querySelectorAll('.is-drag-over-before, .is-drag-over-after, .is-dragging').forEach(function (node) {
      node.classList.remove('is-drag-over-before', 'is-drag-over-after', 'is-dragging');
    });
  }

  function moveCompareKey(from, to, after) {
    if (!from || !to || from === to) return;
    var keys = cmp.keys.filter(function (key) { return key !== from; });
    var idx = keys.indexOf(to);
    if (idx < 0) return;
    keys.splice(after ? idx + 1 : idx, 0, from);
    cmp.keys = keys;
    renderCompareList();
    var active = compareItem(cmp.active);
    if (active) renderCompareStage(active);
  }

  function wireCompareList() {
    var list = el('gv2-compare-list');
    if (!list) return;
    list.addEventListener('click', function (ev) {
      var item = ev.target.closest ? ev.target.closest('.gv2-compare-item') : null;
      if (item) selectCompareKey(item.getAttribute('data-key'));
    });
    list.addEventListener('dragstart', function (ev) {
      var item = ev.target.closest ? ev.target.closest('.gv2-compare-item') : null;
      if (!item) return;
      cmp.dragging = item.getAttribute('data-key');
      item.classList.add('is-dragging');
      if (ev.dataTransfer) {
        ev.dataTransfer.effectAllowed = 'move';
        try { ev.dataTransfer.setData('text/plain', cmp.dragging); } catch (error) { /* ignore */ }
      }
    });
    list.addEventListener('dragover', function (ev) {
      if (!cmp.dragging) return;
      ev.preventDefault();
      if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'move';
      var over = ev.target.closest ? ev.target.closest('.gv2-compare-item') : null;
      list.querySelectorAll('.is-drag-over-before, .is-drag-over-after').forEach(function (node) {
        node.classList.remove('is-drag-over-before', 'is-drag-over-after');
      });
      if (!over || over.getAttribute('data-key') === cmp.dragging) return;
      var rect = over.getBoundingClientRect();
      over.classList.add(ev.clientX > rect.left + rect.width / 2 ? 'is-drag-over-after' : 'is-drag-over-before');
    });
    list.addEventListener('drop', function (ev) {
      if (!cmp.dragging) return;
      ev.preventDefault();
      var over = ev.target.closest ? ev.target.closest('.gv2-compare-item') : null;
      var from = cmp.dragging;
      cmp.dragging = null;
      if (over) {
        var rect = over.getBoundingClientRect();
        moveCompareKey(from, over.getAttribute('data-key'), ev.clientX > rect.left + rect.width / 2);
      }
      clearCompareDropMarks();
    });
    list.addEventListener('dragend', function () {
      cmp.dragging = null;
      clearCompareDropMarks();
    });
  }

  function selectCompareKey(uid) {
    if (!uid) return;
    cmp.active = uid;
    renderCompareList();
    var cached = cmp.items[uid];
    if (cached) {
      renderCompareStage(cached);
      renderCompareDetail(cached);
    }
    loadCompareItem(uid).then(function (item) {
      if (cmp.active !== uid) return;
      renderCompareStage(item);
      renderCompareDetail(item);
    }).catch(function (err) { toast('Compare failed: ' + err.message, true); });
  }

  function compareNavigate(dir) {
    if (!cmp.keys.length) return;
    var idx = cmp.keys.indexOf(cmp.active);
    var next = idx < 0 ? 0 : idx + dir;
    if (next < 0) { toast('start of the list'); return; }
    if (next >= cmp.keys.length) { toast('end of the list'); return; }
    selectCompareKey(cmp.keys[next]);
  }

  function renderCompareStage(item) {
    var stage = el('gv2-compare-stage');
    if (!stage) return;
    var index = cmp.keys.indexOf(item.uid);
    var rating = ratingOf(item);
    var flags = '';
    if (rating === 'endorsed') flags += ' gv2-detail-media-endorsed';
    else if (rating === 'disliked') flags += ' gv2-detail-media-disliked';
    if (item.state === 'staged') flags += ' gv2-detail-media-staged';
    if (item.state === 'archived') flags += ' gv2-detail-media-archived';
    var style = (item.width && item.height)
      ? ' style="--gv2-media-ar:' + (item.width / item.height).toFixed(4) + '"'
      : '';
    var media = item.state === 'trashed'
      ? '<div class="gv2-thumb gv2-thumb-empty">no media (trash)</div>'
      : '<div class="gv2-detail-media' + flags + '"' + style + '>' +
          '<img class="gv2-compare-img" src="' + detailPreviewUrl(item) + '" alt="" ' +
            'title="Click to open the fullscreen viewer (wheel = zoom, drag = pan)">' +
          (item.state === 'archived' ? '<div class="gv2-strike"></div>' : '') +
        '</div>';
    stage.innerHTML = media +
      '<div class="gv2-compare-nav">' +
        '<button class="gv2-btn" data-compare-nav="-1"' + (index <= 0 ? ' disabled' : '') + '>\u2190 Prev</button>' +
        '<span class="gv2-compare-pos">' + (index + 1) + ' / ' + cmp.keys.length + ' \u00b7 ' +
          esc(compareFileName(item)) + '</span>' +
        '<button class="gv2-btn" data-compare-nav="1"' +
          (index >= cmp.keys.length - 1 ? ' disabled' : '') + '>Next \u2192</button>' +
      '</div>';
    var img = stage.querySelector('.gv2-compare-img');
    if (img) {
      var mediaBox = stage.querySelector('.gv2-detail-media');
      var syncRatio = function () {
        if (!mediaBox || !img.naturalWidth || !img.naturalHeight) return;
        mediaBox.style.setProperty('--gv2-media-ar', (img.naturalWidth / img.naturalHeight).toFixed(4));
      };
      syncRatio();
      img.addEventListener('load', syncRatio);
      img.addEventListener('error', function () {
        if (img.dataset.fallback === 'thumb') return;
        img.dataset.fallback = 'thumb';
        img.src = blobUrl(item, 'thumb');
      });
      if (item.state !== 'trashed') {
        img.addEventListener('click', function () { openCompareViewer(item); });
      }
    }
    stage.querySelectorAll('[data-compare-nav]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        compareNavigate(parseInt(btn.getAttribute('data-compare-nav'), 10));
      });
    });
  }

  function renderCompareDetail(item) {
    var host = el('gv2-compare-detail');
    if (!host) return;
    host.innerHTML = detailPanelHtml(item, false);
    wireDetailPanel(host, item, {
      rerender: function () { return refreshCompareItem(item.uid); },
      beforeSend: closeCompareWindow,
      openParent: function (uid) { closeCompareWindow(); openDetail(uid); }
    });
  }

  function refreshCompareItem(uid) {
    return loadCompareItem(uid, true).then(function (item) {
      if (!compareOpen() || cmp.active !== uid) return item;
      renderCompareStage(item);
      renderCompareDetail(item);
      renderCompareList();
      return item;
    }).catch(function (err) {
      dropCompareKey(uid);
      toast('Compare item is gone: ' + ((err && err.message) || 'unknown'), true);
      return null;
    });
  }

  function dropCompareKey(uid) {
    var idx = cmp.keys.indexOf(uid);
    if (idx < 0) return;
    cmp.keys.splice(idx, 1);
    delete cmp.items[uid];
    if (!cmp.keys.length) { closeCompareWindow(); return; }
    if (cmp.active === uid) cmp.active = cmp.keys[Math.min(idx, cmp.keys.length - 1)];
    renderCompareList();
    var item = compareItem(cmp.active);
    if (item) {
      renderCompareStage(item);
      renderCompareDetail(item);
    } else {
      selectCompareKey(cmp.active);
    }
  }

  function compareApply(act) {
    var item = compareItem(cmp.active);
    if (!item) return Promise.resolve();
    if (item.state === 'trashed') { toast('use restore / purge for trashed items', true); return Promise.resolve(); }
    return runAction(actionFor(item, act), [item.uid], {}).then(function () { return refreshCompareItem(item.uid); });
  }

  function compareTrash() {
    var item = compareItem(cmp.active);
    if (!item || item.state === 'trashed') return;
    if (!window.confirm('Trash now? The original file and media will be deleted (metadata kept).')) return;
    runAction('trash', [item.uid], {}).then(function () { return refreshCompareItem(item.uid); });
  }

  // Fullscreen viewer: same app-wide lightbox as the drawer, stepping through
  // the compare order instead of the grid order.
  function openCompareViewer(item) {
    if (typeof window.openLightbox !== 'function') { toast('Image viewer unavailable', true); return; }
    var previewSrc = item.state === 'trashed' ? '' : detailPreviewUrl(item);
    window.gv2LightboxNav = {
      nav: function (offset) { navCompareViewer(offset); },
      split: false,
      closeDetail: closeCompareWindow,
      cleanup: function () {}
    };
    detailViewerSrc(item, previewSrc, function (src) {
      if (window.gv2LightboxNav) window.openLightbox(src, { split: false });
    });
  }

  function navCompareViewer(offset) {
    var idx = cmp.keys.indexOf(cmp.active);
    var next = idx + offset;
    if (idx < 0 || next < 0 || next >= cmp.keys.length) return;
    cmp.active = cmp.keys[next];
    renderCompareList();
    loadCompareItem(cmp.active).then(function (item) {
      if (!window.gv2LightboxNav) return; // viewer was closed while loading
      renderCompareStage(item);
      renderCompareDetail(item);
      detailViewerSrc(item, detailPreviewUrl(item), function (src) {
        if (window.gv2LightboxNav) window.openLightbox(src, { split: false });
      });
    }).catch(function () {});
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
        } else if (ev.key === 'a' || ev.key === 'A') {
          ev.preventDefault();
          stepOpenViewer(-1);
        } else if (ev.key === 'd' || ev.key === 'D') {
          ev.preventDefault();
          stepOpenViewer(1);
        }
        return;
      }

      // `_lightboxHandled` covers the same-tick race: the viewer's own Escape
      // handler clears gv2LightboxNav before this listener runs.
      if (ev._lightboxHandled) return;
      if (compareOpen()) {
        if (isTypingTarget(ev.target)) return;
        if (ev.key === 'Escape') { ev.preventDefault(); closeCompareWindow(); return; }
        if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
        if (ev.key === 'ArrowLeft' || ev.key === 'a' || ev.key === 'A') { ev.preventDefault(); compareNavigate(-1); }
        else if (ev.key === 'ArrowRight' || ev.key === 'd' || ev.key === 'D') { ev.preventDefault(); compareNavigate(1); }
        else if (ev.key === 'ArrowUp') { ev.preventDefault(); if (!ev.repeat) compareApply('endorse'); }
        else if (ev.key === 'ArrowDown') { ev.preventDefault(); if (!ev.repeat) compareApply('dislike'); }
        else if (ev.key === 'Delete') { ev.preventDefault(); compareTrash(); }
        else if (ev.key === 'x' || ev.key === 'X') { ev.preventDefault(); if (!ev.repeat) compareApply('archive'); }
        else if (ev.key === 's' || ev.key === 'S') { ev.preventDefault(); if (!ev.repeat) compareApply('stage'); }
        return;
      }
      if (ev.key === 'Escape') {
        if (drawerOpen) { closeDetail(); return; }
        if (state.selectMode) setSelectMode(false);
        return;
      }
      if (!drawerOpen || isTypingTarget(ev.target)) return;
      if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
      if (ev.key === 'ArrowLeft' || ev.key === 'a' || ev.key === 'A') { ev.preventDefault(); detailNavigate(-1); }
      else if (ev.key === 'ArrowRight' || ev.key === 'd' || ev.key === 'D') { ev.preventDefault(); detailNavigate(1); }
      else if (ev.key === 'ArrowUp') { ev.preventDefault(); detailApply('endorse'); }
      else if (ev.key === 'ArrowDown') { ev.preventDefault(); detailApply('dislike'); }
      else if (ev.key === 'Delete') { ev.preventDefault(); detailTrash(); }
      else if (ev.key === 'x' || ev.key === 'X') { ev.preventDefault(); detailApply('archive'); }
      else if (ev.key === 's' || ev.key === 'S') {
        ev.preventDefault();
        if (!ev.repeat) detailToggleStage();
      }
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

  // A / D swipe the same way the arrow keys do: the open fullscreen viewer steps
  // through the drawer / compare order it was opened from.
  function stepOpenViewer(offset) {
    var nav = window.gv2LightboxNav;
    if (nav && typeof nav.nav === 'function') nav.nav(offset);
  }

  // ---------------------------------------------------------------- init

  var scheduled = false;
  function scheduleInit() {
    if (scheduled) return;
    scheduled = true;
    setTimeout(function () {
      scheduled = false;
      // gradio can tear the tab down while the compare window is open: the
      // overlay disappears with it, so release the scroll lock as well
      if (!el('gv2-compare') && document.documentElement.classList.contains('gv2-compare-open')) {
        document.documentElement.classList.remove('gv2-compare-open');
        cmp.keys = [];
        cmp.active = null;
        cmp.items = {};
        cmp.dragging = null;
      }
      init();
      watchPane();
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
    var y = paneScrollTop();
    btn.classList.toggle('gv2-top-hidden', y <= 600);
  }

  // style.css turns the gallery root into its own scroll pane (see "fixed top
  // band" there), so the back-to-top button has to read that pane, not the window.
  function paneEl() {
    return el(ROOT_ID);
  }

  function paneScrollTop() {
    var root = paneEl();
    if (root && root.scrollHeight > root.clientHeight) return root.scrollTop || 0;
    return window.scrollY || document.documentElement.scrollTop || 0;
  }

  function scrollPaneToTop() {
    var root = paneEl();
    if (root && root.scrollHeight > root.clientHeight) {
      root.scrollTo({ top: 0, behavior: 'smooth' });
      return;
    }
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  // The fixed top band (progress bar + the versions strip) cannot be scrolled
  // away, so the gallery is its own scroll pane and is sized to the space left in
  // the viewport: its top edge stays below the band and no card can slide under
  // the strip.  A hidden tab measures as zero and is fitted by the ResizeObserver
  // once it is shown.
  //
  // Vertical space the layout keeps below the pane (tab padding, the column gap,
  // the footer slot, the app container padding).  Each term is a layout constant,
  // so this stays right when the pane is resized - the document height itself is
  // clamped to the viewport and cannot be used for it.
  function spaceBelowPane(root) {
    var container = document.querySelector('gradio-app > .gradio-container') || document.body;
    var space = 0;
    var node = root;
    while (node && node !== container && node.parentElement) {
      var cs = getComputedStyle(node);
      space += (parseFloat(cs.paddingBottom) || 0) + (parseFloat(cs.marginBottom) || 0);
      var parent = node.parentElement;
      var parentStyle = getComputedStyle(parent);
      // a row gap only separates this node from a sibling that is actually laid out
      var columnFlow = parentStyle.display.indexOf('flex') >= 0 || parentStyle.display.indexOf('grid') >= 0;
      var next = node.nextElementSibling;
      if (columnFlow && next && next.getClientRects().length) space += parseFloat(parentStyle.rowGap) || 0;
      node = parent;
    }
    var footer = document.getElementById('footer');
    if (footer) {
      var footerStyle = getComputedStyle(footer);
      space += footer.getBoundingClientRect().height;
      space += (parseFloat(footerStyle.marginTop) || 0) + (parseFloat(footerStyle.marginBottom) || 0);
    }
    space += parseFloat(getComputedStyle(container).paddingBottom) || 0;
    return space;
  }

  // The pane owns the scrolling, so the window must never scroll: the fixed top
  // band would then paint over the cards.
  function fitPane() {
    var root = paneEl();
    if (!root || !root.getClientRects().length) return;
    var top = root.getBoundingClientRect().top + (window.scrollY || 0);
    var height = Math.max(280, Math.round(window.innerHeight - top - spaceBelowPane(root) - 2)) + 'px';
    if (root.style.getPropertyValue('--gv2-pane-height') !== height) {
      root.style.setProperty('--gv2-pane-height', height);
    }
  }

  var _paneWatched = false;
  function watchPane() {
    if (_paneWatched) return;
    var root = paneEl();
    if (!root) return;
    _paneWatched = true;
    fitPane();
    if (window.ResizeObserver) new ResizeObserver(function () { fitPane(); }).observe(root);
    window.addEventListener('resize', fitPane);
  }

  function hookAutoScroll() {
    if (_autoScrollHooked) return;
    _autoScrollHooked = true;
    var schedule = function () {
      if (_autoScrollScheduled) return;
      _autoScrollScheduled = true;
      requestAnimationFrame(function () {
        _autoScrollScheduled = false;
        updateTopButton();
        autoLoadCheck();
      });
    };
    // the gallery scrolls inside its own pane now, and scroll events do not
    // bubble - listen on the pane as well as on the window
    window.addEventListener('scroll', schedule, { passive: true });
    var root = paneEl();
    if (root) root.addEventListener('scroll', schedule, { passive: true });
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
    applyThumbRatio();
    wireChips(root);
    wireFolds(root);
    applyFolds();
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
