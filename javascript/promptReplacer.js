/**
 * Prompt replacer window.
 *
 * Sits under the macros panel of the txt2img / img2img result column and owns an
 * ordered list of find -> replace rules. The img2img tab keeps ONE rule set for
 * the image mode and another for the inpaint sub-modes (store keys `img2img` and
 * `img2img:inpaint`), picked from `get_tab_index('mode_img2img')`. The rules never
 * rewrite the prompt boxes: they are applied to the outgoing request (Generate,
 * Quick Generate, Queue), so the text on screen stays the text the user typed.
 *
 * txt2img and img2img preview the replacement INLINE in the prompt text: the
 * matched range is struck through and the replacement follows it (CodeMirror
 * text mode draws it as decorations, the chip editor decorates the chip text).
 *
 *   window.promptReplacer.rulesFor(tab)          -> active rules
 *   window.promptReplacer.applyText(text, rules) -> text with the rules applied
 *   window.promptReplacer.apply(tab, text)       -> same, using the tab rules
 *   window.promptReplacer.inlineMatches(text, tab) -> [{from, to, text}]
 *   window.promptReplacer.decorateChipText(text, tab) -> escaped inline HTML
 *   window.promptReplacer.refresh()              -> redraw panel + inline marks
 */
(function () {
  'use strict';

  var STORE_PREFIX = 'prepl.state.';
  var TABS = ['txt2img', 'img2img'];
  var SAVE_DELAY = 250;
  var state = {}; // tab -> {on, rules: [{id, find, replace, regex, enabled}]}
  var saveTimers = {};

  // ---------------------------------------------------------------- helpers

  function esc(text) {
    return String(text == null ? '' : text)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function newId() {
    return 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  function cssEscape(value) {
    if (window.CSS && CSS.escape) return CSS.escape(value);
    return String(value).replace(/[^a-zA-Z0-9_-]/g, '\\$&');
  }

  /** Current img2img sub-tab index (0 img2img, 1 sketch, 2+ the inpaint modes). */
  function img2imgModeIndex() {
    if (typeof window.get_tab_index !== 'function') return 0;
    try { return Number(window.get_tab_index('mode_img2img')) || 0; } catch (error) { return 0; }
  }

  /** Store key: the image and inpaint sub-modes of img2img keep separate rules. */
  function keyForTab(tab) {
    return tab === 'img2img' && img2imgModeIndex() >= 2 ? 'img2img:inpaint' : tab;
  }

  function keyForMode(tab, modeIndex) {
    return tab === 'img2img' && Number(modeIndex) >= 2 ? 'img2img:inpaint' : tab;
  }

  function tabOfKey(key) {
    return String(key).split(':')[0];
  }

  function normalize(raw) {
    var out = { on: true, rules: [] };
    if (!raw || typeof raw !== 'object') return out;
    out.on = raw.on !== false;
    var list = Array.isArray(raw.rules) ? raw.rules : [];
    for (var i = 0; i < list.length; i++) {
      var item = list[i];
      if (!item || typeof item !== 'object') continue;
      out.rules.push({
        id: String(item.id || newId()),
        find: String(item.find == null ? '' : item.find),
        replace: String(item.replace == null ? '' : item.replace),
        regex: !!item.regex,
        enabled: item.enabled !== false,
      });
    }
    return out;
  }

  function tabState(key) {
    if (!state[key]) {
      var raw = null;
      try {
        raw = JSON.parse(localStorage.getItem(STORE_PREFIX + key) || 'null');
      } catch (error) { raw = null; }
      state[key] = normalize(raw);
    }
    return state[key];
  }

  function persist(key) {
    try {
      localStorage.setItem(STORE_PREFIX + key, JSON.stringify(tabState(key)));
    } catch (error) { /* storage full/blocked - rules stay in memory */ }
    // rules changed: drop what we remember about the drawn marks and let the
    // chip editor redraw its inline preview
    inlineApplied = {};
    window.dispatchEvent(new CustomEvent('pedit-replacer-changed', { detail: { tab: key.split(':')[0] } }));
  }

  function scheduleSave(key) {
    clearTimeout(saveTimers[key]);
    saveTimers[key] = setTimeout(function () {
      persist(key);
      updateHits(tabOfKey(key));
      renderPreview(tabOfKey(key));
    }, SAVE_DELAY);
  }

  function ruleById(key, id) {
    var rules = tabState(key).rules;
    for (var i = 0; i < rules.length; i++) {
      if (rules[i].id === id) return rules[i];
    }
    return null;
  }

  /** Rules that actually change text (enabled, non-empty find, master switch on). */
  function activeRules(key) {
    var info = tabState(key);
    if (!info.on) return [];
    return info.rules.filter(function (rule) {
      return rule.enabled && rule.find !== '';
    });
  }

  function validRegex(pattern) {
    try {
      new RegExp(pattern, 'g');
      return true;
    } catch (error) {
      return false;
    }
  }

  function applyRule(text, rule) {
    if (!rule || !rule.find) return String(text == null ? '' : text);
    var out = String(text == null ? '' : text);
    if (rule.regex) {
      var re;
      try { re = new RegExp(rule.find, 'g'); } catch (error) { return out; }
      return out.replace(re, rule.replace);
    }
    return out.split(rule.find).join(rule.replace);
  }

  function applyRules(text, rules) {
    var out = String(text == null ? '' : text);
    for (var i = 0; i < (rules || []).length; i++) out = applyRule(out, rules[i]);
    return out;
  }

  /** Matching occurrences; -1 reports an unusable regular expression. */
  function countHits(text, rule) {
    var src = String(text == null ? '' : text);
    if (!rule || !rule.find || !src) return 0;
    if (rule.regex) {
      var re;
      try { re = new RegExp(rule.find, 'g'); } catch (error) { return -1; }
      var found = src.match(re);
      return found ? found.length : 0;
    }
    return src.split(rule.find).length - 1;
  }

  // ---------------------------------------------------------------- panel

  function hostFor(tab) {
    return document.querySelector('.prompt-replacer-panel[data-tab="' + tab + '"]');
  }

  function powerTitle(on) {
    return on
      ? 'Replacements are applied when generating - click to turn them off'
      : 'Replacements are off - the prompts are sent as typed';
  }

  function ruleRowHtml(rule, key) {
    var hits = '';
    if (rule.regex && !validRegex(rule.find)) hits = 'bad regex';
    return '<div class="prepl-rule' + (rule.enabled ? '' : ' is-off') + '" data-rule="' + esc(rule.id) + '"' +
        ' data-key="' + esc(key) + '">' +
      '<div class="prepl-rule-head">' +
        '<button type="button" class="prepl-en" data-prepl="enable" ' +
          'title="' + (rule.enabled ? 'Enabled - click to disable this replacer' : 'Disabled - click to enable this replacer') + '">' +
          (rule.enabled ? '\u2713' : '\u25CB') + '</button>' +
        '<button type="button" class="prepl-regex' + (rule.regex ? ' is-on' : '') + '" data-prepl="regex" ' +
          'title="Find is a regular expression (case sensitive, global)"><code>.*</code></button>' +
        '<span class="prepl-hits" data-hits="' + esc(rule.id) + '">' + hits + '</span>' +
        '<button type="button" class="prepl-del" data-prepl="delete" title="Delete this replacer">\u00d7</button>' +
      '</div>' +
      '<input type="text" class="prepl-input prepl-find" data-field="find" value="' + esc(rule.find) + '" ' +
        'placeholder="find\u2026" autocomplete="off" spellcheck="false" />' +
      '<input type="text" class="prepl-input prepl-replace" data-field="replace" value="' + esc(rule.replace) + '" ' +
        'placeholder="replace with\u2026" title="Leave empty to remove the matched text" autocomplete="off" spellcheck="false" />' +
    '</div>';
  }

  /** Small tag that tells img2img users which sub-mode's rules are shown. */
  function modeBadge(tab, key) {
    if (key === tab) return '';
    return '<span class="prepl-mode" title="img2img keeps separate replacers for the image and inpaint modes">' +
      (key === 'img2img:inpaint' ? 'inpaint' : 'image') + '</span>';
  }

  function panelHtml(tab, key) {
    var info = tabState(key);
    var count = activeRules(key).length;
    var rows = info.rules.map(function (rule) { return ruleRowHtml(rule, key); }).join('');
    return '<div class="prepl-head">' +
        '<span class="prepl-title">Replace</span>' + modeBadge(tab, key) +
        '<span class="prepl-count">' + (count ? count : '') + '</span>' +
        '<button type="button" class="prepl-power' + (info.on ? ' is-on' : '') + '" data-prepl="power" ' +
          'title="' + powerTitle(info.on) + '" aria-pressed="' + (info.on ? 'true' : 'false') + '">' +
          (info.on ? 'on' : 'off') + '</button>' +
      '</div>' +
      '<div class="prepl-body">' + (rows || '<div class="prepl-empty">No replacers</div>') + '</div>' +
      '<div class="prepl-foot">' +
        '<button type="button" class="prepl-add" data-prepl="add" title="Add another replacer">\uff0b rule</button>' +
        (info.rules.length ? '<button type="button" class="prepl-clear" data-prepl="clear" title="Remove every replacer">Clear</button>' : '') +
      '</div>';
  }

  var renderedKey = {}; // tab -> store key the panel currently shows

  function render(tab) {
    var host = hostFor(tab);
    if (!host) return;
    var key = keyForTab(tab);
    host.innerHTML = panelHtml(tab, key);
    host.dataset.preplReady = '1';
    host.dataset.preplKey = key;
    renderedKey[tab] = key;
    updateHits(tab);
  }

  /** Hit counters are cheap and must follow the prompt while typing. */
  function updateHits(tab) {
    var host = hostFor(tab);
    if (!host) return;
    var key = keyForTab(tab);
    var prompt = fieldText(tab + '_prompt');
    var negative = fieldText(tab + '_neg_prompt');
    var rules = tabState(key).rules;
    for (var i = 0; i < rules.length; i++) {
      var rule = rules[i];
      var label = host.querySelector('[data-hits="' + cssEscape(rule.id) + '"]');
      if (!label) continue;
      if (!rule.find) { label.textContent = ''; label.classList.remove('is-error', 'is-hit'); continue; }
      var hits = countHits(prompt, rule) + countHits(negative, rule);
      if (hits < 0) {
        label.textContent = 'bad regex';
        label.classList.add('is-error');
        label.classList.remove('is-hit');
      } else {
        label.textContent = hits ? '\u00d7' + hits : '';
        label.classList.toggle('is-hit', hits > 0);
        label.classList.remove('is-error');
      }
    }
    var count = host.querySelector('.prepl-count');
    if (count) count.textContent = activeRules(key).length || '';
  }

  function addRule(key) {
    tabState(key).rules.push({ id: newId(), find: '', replace: '', regex: false, enabled: true });
    persist(key);
    render(tabOfKey(key));
    var host = hostFor(tabOfKey(key));
    var inputs = host ? host.querySelectorAll('.prepl-find') : [];
    var last = inputs[inputs.length - 1];
    if (last) last.focus();
    renderPreview(tabOfKey(key));
  }

  function deleteRule(key, rule) {
    var info = tabState(key);
    info.rules = info.rules.filter(function (item) { return item.id !== rule.id; });
    persist(key);
    render(tabOfKey(key));
    renderPreview(tabOfKey(key));
  }

  function clearRules(key) {
    var info = tabState(key);
    if (!info.rules.length) return;
    if (!window.confirm('Remove all ' + info.rules.length + ' replacer(s) of this ' +
        (key === 'img2img:inpaint' ? 'inpaint mode' : 'tab') + '?')) return;
    info.rules = [];
    persist(key);
    render(tabOfKey(key));
    renderPreview(tabOfKey(key));
  }

  function wireHost(tab, host) {
    if (host.dataset.preplWired === '1') return;
    host.dataset.preplWired = '1';

    host.addEventListener('click', function (ev) {
      var btn = ev.target && ev.target.closest ? ev.target.closest('[data-prepl]') : null;
      if (!btn) return;
      ev.preventDefault();
      var action = btn.getAttribute('data-prepl');
      if (action === 'add') { addRule(keyForTab(tab)); return; }
      if (action === 'clear') { clearRules(keyForTab(tab)); return; }
      if (action === 'power') {
        var info = tabState(keyForTab(tab));
        info.on = !info.on;
        persist(keyForTab(tab));
        render(tab);
        renderPreview(tab);
        return;
      }
      var row = btn.closest('.prepl-rule');
      var key = row && row.getAttribute('data-key') ? row.getAttribute('data-key') : keyForTab(tab);
      var rule = row ? ruleById(key, row.getAttribute('data-rule')) : null;
      if (!rule) return;
      if (action === 'enable') {
        rule.enabled = !rule.enabled;
      } else if (action === 'regex') {
        rule.regex = !rule.regex;
      } else if (action === 'delete') {
        deleteRule(key, rule);
        return;
      }
      persist(key);
      render(tab);
      renderPreview(tab);
    });

    host.addEventListener('input', function (ev) {
      var field = ev.target && ev.target.getAttribute ? ev.target.getAttribute('data-field') : null;
      if (!field) return;
      var row = ev.target.closest ? ev.target.closest('.prepl-rule') : null;
      var key = row && row.getAttribute('data-key') ? row.getAttribute('data-key') : keyForTab(tab);
      var rule = row ? ruleById(key, row.getAttribute('data-rule')) : null;
      if (!rule) return;
      rule[field] = ev.target.value;
      scheduleSave(key);
    });

    host.addEventListener('keydown', function (ev) {
      if (ev.key !== 'Enter' || !ev.target || ev.target.tagName !== 'INPUT') return;
      ev.preventDefault();
      ev.target.blur();
    });
  }

  // ------------------------------------------------------------ edit preview

  function fieldText(id) {
    var field = document.getElementById(id);
    if (!field) return '';
    if (field.tagName === 'TEXTAREA' || field.tagName === 'INPUT') return field.value || '';
    var inner = field.querySelector('textarea') || field.querySelector('input');
    return inner ? inner.value || '' : '';
  }

  // Both generation tabs preview the replacement inline in their prompt boxes.
  var PREVIEW_FIELDS = {
    txt2img: ['txt2img_prompt', 'txt2img_neg_prompt'],
    img2img: ['img2img_prompt', 'img2img_neg_prompt'],
  };

  /** Character ranges one rule matches in `text` (empty for a broken regex). */
  function ruleRanges(text, rule) {
    var ranges = [];
    if (!rule || !rule.find) return ranges;
    if (rule.regex) {
      var re;
      try { re = new RegExp(rule.find, 'g'); } catch (error) { return ranges; }
      var match = re.exec(text);
      var guard = 0;
      while (match && guard++ < 20000) {
        ranges.push([match.index, match.index + match[0].length]);
        if (match[0] === '') re.lastIndex++;
        match = re.exec(text);
      }
    } else {
      var start = text.indexOf(rule.find);
      while (start >= 0) {
        ranges.push([start, start + rule.find.length]);
        start = text.indexOf(rule.find, start + rule.find.length);
      }
    }
    return ranges;
  }

  /** Every match of the active rules in `text` (the first rule wins on overlaps). */
  function inlineMatches(text, key) {
    var rules = activeRules(key);
    if (!rules.length) return [];
    var hits = [];
    for (var i = 0; i < rules.length; i++) {
      var ranges = ruleRanges(text, rules[i]);
      for (var j = 0; j < ranges.length; j++) {
        hits.push({ from: ranges[j][0], to: ranges[j][1], text: rules[i].replace });
      }
    }
    hits.sort(function (a, b) { return a.from - b.from || b.to - a.to; });
    var out = [];
    var last = -1;
    for (var k = 0; k < hits.length; k++) {
      if (hits[k].from < last) continue;
      out.push(hits[k]);
      last = hits[k].to;
    }
    return out;
  }

  /** Chip editor decoration: escaped text with the match struck out + replacement. */
  function decorateChipText(text, tab) {
    var source = String(text == null ? '' : text);
    var hits = inlineMatches(source, keyForTab(tab));
    if (!hits.length) return esc(source);
    var html = '';
    var pos = 0;
    for (var i = 0; i < hits.length; i++) {
      html += esc(source.slice(pos, hits[i].from));
      html += '<s class="prepl-inline-old">' + esc(source.slice(hits[i].from, hits[i].to)) + '</s>';
      if (hits[i].text) html += '<span class="prepl-inline-new">' + esc(hits[i].text) + '</span>';
      pos = hits[i].to;
    }
    return html + esc(source.slice(pos));
  }

  // Text mode (CodeMirror) draws the same preview as decorations. The editor
  // drops them on every edit, so the text (and rule set) we last applied decides
  // whether a refresh is needed.
  var inlineApplied = {}; // host id -> {editor, text, key}
  var inlineTimers = {};  // host id -> timer

  function scheduleInline(id, editor, ranges) {
    // never dispatch while CodeMirror is still applying the keystroke
    clearTimeout(inlineTimers[id]);
    inlineTimers[id] = setTimeout(function () {
      var last = inlineApplied[id];
      if (last && last.editor !== editor) return;
      try { editor.setReplacePreview(ranges); } catch (error) { /* stale offsets */ }
    }, 40);
  }

  function applyInline(tab) {
    var ids = PREVIEW_FIELDS[tab];
    var instances = window.promptCMInstances;
    if (!ids || !instances || typeof instances.get !== 'function') return;
    var key = keyForTab(tab);
    for (var i = 0; i < ids.length; i++) {
      var id = ids[i];
      var editor = instances.get(id);
      if (!editor || typeof editor.setReplacePreview !== 'function') continue;
      var text = fieldText(id);
      var last = inlineApplied[id];
      if (last && last.editor === editor && last.text === text && last.key === key) continue;
      inlineApplied[id] = { editor: editor, text: text, key: key };
      scheduleInline(id, editor, text.trim() ? inlineMatches(text, key) : []);
    }
  }

  function renderPreview(tab) {
    applyInline(tab);
  }

  // ------------------------------------------------------- request rewriting

  function rewriteOutgoing(key, res, promptIdx, negIdx) {
    if (!res || typeof res !== 'object') return res;
    var rules = activeRules(key);
    if (!rules.length) return res;
    if (typeof res[promptIdx] === 'string') res[promptIdx] = applyRules(res[promptIdx], rules);
    if (typeof res[negIdx] === 'string') res[negIdx] = applyRules(res[negIdx], rules);
    return res;
  }

  // The txt2img upscale path prepends the gallery payload to the same inputs,
  // which pushes prompt/negative from 1/2 to 4/5.
  function txt2imgPromptIndexes(res) {
    return Array.isArray(res[1]) ? [4, 5] : [1, 2];
  }

  // Gradio evaluates the `_js` hooks by name in the global scope, so wrapping the
  // shared entry points covers Generate, Quick Generate, upscale and Queue.
  // img2img picks its rule set from the sub-mode index the hook already sends.
  function wrapFn(name, tab, locate) {
    var original = window[name];
    if (typeof original !== 'function') return false;
    if (original.__preplWrapped) return true;
    var wrapped = function () {
      var res = original.apply(this, arguments);
      var idx = locate(res);
      return rewriteOutgoing(keyForMode(tab, res[1]), res, idx[0], idx[1]);
    };
    wrapped.__preplWrapped = true;
    window[name] = wrapped;
    return true;
  }

  function patchGenerationHooks() {
    var done = [
      wrapFn('submit', 'txt2img', txt2imgPromptIndexes),
      wrapFn('submit_img2img', 'img2img', function () { return [2, 3]; }),
      wrapFn('queue_job_txt2img', 'txt2img', function () { return [1, 2]; }),
      wrapFn('queue_job_img2img', 'img2img', function () { return [2, 3]; })
    ];
    return done.every(function (ok) { return ok; });
  }

  // ---------------------------------------------------------------- boot

  function scanPanels() {
    for (var i = 0; i < TABS.length; i++) {
      var tab = TABS[i];
      var host = hostFor(tab);
      if (!host) continue;
      wireHost(tab, host);
      var key = keyForTab(tab);
      // first mount, or the user switched img2img between image and inpaint
      if (host.dataset.preplReady !== '1' || renderedKey[tab] !== key) {
        if (host.dataset.preplReady === '1') inlineApplied = {}; // redraw the marks
        render(tab);
      } else {
        updateHits(tab);
      }
    }
  }

  /** Sub-mode switches must redraw the panel right away, not on the next tick. */
  function watchImg2imgModes() {
    // bubble phase: gradio has already moved `selected` by the time we run, so
    // get_tab_index() reports the newly clicked sub-mode
    document.addEventListener('click', function (ev) {
      var node = ev.target;
      if (!node || !node.closest || !node.closest('#mode_img2img')) return;
      tick();
      [120, 300, 600].forEach(function (delay) { setTimeout(tick, delay); });
    });
  }

  function bindPromptField(id, tab) {
    var field = document.getElementById(id);
    if (!field) return;
    var target = (field.tagName === 'TEXTAREA' || field.tagName === 'INPUT') ? field : (field.querySelector('textarea') || field.querySelector('input'));
    if (!target || target.dataset.preplBound === '1') return;
    target.dataset.preplBound = '1';
    var refresh = function () {
      updateHits(tab);
      renderPreview(tab);
    };
    target.addEventListener('input', refresh);
    target.addEventListener('change', refresh);
  }

  function tick() {
    scanPanels();
    // ui.js / jobQueue.js may be parsed after this module, and extensions can
    // replace the hooks - keep the wrapper installed while the page is alive
    patchGenerationHooks();
    for (var i = 0; i < TABS.length; i++) {
      bindPromptField(TABS[i] + '_prompt', TABS[i]);
      bindPromptField(TABS[i] + '_neg_prompt', TABS[i]);
      renderPreview(TABS[i]);
    }
  }

  patchGenerationHooks();

  function boot() {
    patchGenerationHooks();
    watchImg2imgModes();
    tick();
    setTimeout(tick, 500);
    setTimeout(tick, 1500);
    setTimeout(tick, 3000);
    setTimeout(renderPreview, 3500);
    setInterval(tick, 2000);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  window.promptReplacer = {
    keyFor: function (tab) {
      return keyForTab(tab);
    },
    keyForMode: function (tab, modeIndex) {
      return keyForMode(tab, modeIndex);
    },
    rulesFor: function (tab) {
      return activeRules(keyForTab(tab)).map(function (rule) {
        return { find: rule.find, replace: rule.replace, regex: rule.regex };
      });
    },
    applyText: function (text, rules) {
      return applyRules(text, rules);
    },
    apply: function (tab, text) {
      return applyRules(text, activeRules(keyForTab(tab)));
    },
    inlineMatches: function (text, tab) {
      return inlineMatches(text, keyForTab(tab));
    },
    decorateChipText: function (text, tab) {
      return decorateChipText(text, tab);
    },
    refresh: function () {
      for (var i = 0; i < TABS.length; i++) {
        if (hostFor(TABS[i])) render(TABS[i]);
        renderPreview(TABS[i]);
      }
    },
  };
})();
