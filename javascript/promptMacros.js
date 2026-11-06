/**
 * Prompt macro editor.
 *
 * Renders the scrollable panel left of the txt2img / img2img result panel and
 * keeps a hidden JSON field (`<tab>_macro_values`) in sync with the custom macro
 * toggles / enum selects.  The same state is exposed to the prompt editors:
 *
 *   window.promptMacros.valuesFor(tab)   -> {MOOD: 'happy', FLAG: 1}
 *   window.promptMacros.macrosFor(tab)   -> system + custom macro values
 *   window.promptMacros.macrosForText(text, tab) -> macros for one editor text
 *   window.promptMacros.inactiveLines(text, macros)
 *
 * Definitions (`@MACRO(name)` / `@MACRO(name){a, b, c}`) and the fixed system
 * macros are read from the live prompt/negative text on every input event.
 * Undeclared names referenced by a condition get a boolean toggle as well.
 */
(function () {
  'use strict';

  const SYSTEM_MACROS = ['TXT2IMG', 'HIRES_FIX', 'IMG2IMG', 'INPAINT', 'POSE_INPAINT', 'POSE_INPAINT_PART'];
  const PART_VALUES = ['0', 'FACE', 'FEET', 'HANDS'];
  const STORE_PREFIX = 'pedit.macros.';

  let syntax = null;
  const state = {}; // tab -> {values, lastText}

  function tabState(tab) {
    if (!state[tab]) {
      let values = {};
      try {
        const saved = JSON.parse(localStorage.getItem(STORE_PREFIX + tab) || '{}');
        if (saved && typeof saved === 'object') {
          values = Object.fromEntries(Object.entries(saved).map(([key, value]) => [String(key).toUpperCase(), value]));
        }
      } catch (error) { /* ignore corrupt state */ }
      state[tab] = { values: values, lastText: null };
    }
    return state[tab];
  }

  function fieldFor(host) {
    if (!host) return null;
    if (host.tagName === 'TEXTAREA' || host.tagName === 'INPUT') return host;
    return host.querySelector('textarea') || host.querySelector('input');
  }

  function textareaValue(id) {
    const field = fieldFor(id ? document.getElementById(id) : null);
    return field ? field.value || '' : '';
  }

  function promptText(tab) {
    const positive = textareaValue(tab + '_prompt');
    const negative = textareaValue(tab + '_neg_prompt');
    const hires = tab === 'txt2img'
      ? [textareaValue('hires_prompt'), textareaValue('hires_neg_prompt')]
      : [];
    return [positive, negative, ...hires].filter(Boolean).join('\n');
  }

  function stageFor(tab) {
    if (tab === 'img2img' && typeof window.get_tab_index === 'function') {
      try {
        if (Number(window.get_tab_index('mode_img2img')) >= 2) return 'inpaint';
      } catch (error) { /* mode tabs not mounted yet */ }
    }
    return tab;
  }

  function fallbackStageMacros(stage) {
    const values = {};
    for (const name of SYSTEM_MACROS) values[name] = 0;
    const key = String(stage || '').toLowerCase();
    if (key === 'txt2img') values.TXT2IMG = 1;
    else if (key === 'hires_fix') { values.HIRES_FIX = 1; values.IMG2IMG = 1; }
    else if (key === 'img2img') values.IMG2IMG = 1;
    else if (key === 'inpaint') { values.INPAINT = 1; values.IMG2IMG = 1; }
    else if (key === 'pose_inpaint') { values.POSE_INPAINT = 1; values.INPAINT = 1; values.IMG2IMG = 1; }
    values.POSE_INPAINT_PART = 0;
    return values;
  }

  function boolValue(value) {
    if (typeof value === 'boolean') return value ? 1 : 0;
    if (typeof value === 'number') return value ? 1 : 0;
    return ['1', 'true', 'on', 'yes'].includes(String(value == null ? '' : value).trim().toLowerCase()) ? 1 : 0;
  }

  function definitionsFor(tab) {
    if (!syntax) return {};
    return syntax.parseMacroDefinitions(promptText(tab));
  }

  function referencesFor(tab) {
    if (!syntax) return new Set();
    return syntax.parseMacroReferences(promptText(tab));
  }

  function currentMacros(tab) {
    const info = tabState(tab);
    const stage = stageFor(tab);
    if (syntax) {
      return syntax.macroState(promptText(tab), stage, info.values).macros;
    }
    return fallbackStageMacros(stage);
  }

  function persistValues(tab, values) {
    const info = tabState(tab);
    info.values = values;
    try {
      localStorage.setItem(STORE_PREFIX + tab, JSON.stringify(values));
    } catch (error) { /* storage full/blocked - values stay in memory */ }
    writeHidden(tab, values);
    window.dispatchEvent(new CustomEvent('pedit-macros-changed', {
      detail: { tab: tab, values: values, macros: currentMacros(tab) },
    }));
  }

  function writeHidden(tab, values) {
    const panel = document.querySelector('.prompt-macro-panel[data-tab="' + CSS.escape(tab) + '"]');
    const id = panel ? panel.dataset.values : tab + '_macro_values';
    const field = fieldFor(document.getElementById(id));
    if (!field) return;
    const next = JSON.stringify(values);
    if (field.value === next) return;
    field.value = next;
    field.dispatchEvent(new Event('input', { bubbles: true }));
    field.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function element(tag, props, children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props || {})) {
      if (value === undefined || value === null) continue;
      if (key === 'class') node.className = value;
      else if (key === 'text') node.textContent = value;
      else if (key === 'dataset') Object.assign(node.dataset, value);
      else node[key] = value;
    }
    for (const child of children || []) if (child) node.append(child);
    return node;
  }

  function macroRow(key, label, control, kind) {
    return element('label', { class: 'prompt-macro-row is-' + kind + ' is-enum', dataset: { macroKey: key } }, [
      element('span', { class: 'prompt-macro-name', text: label }),
      control,
    ]);
  }

  function toggleRow(key, label, active, kind, title, tab) {
    const button = element('button', {
      type: 'button',
      class: 'prompt-macro-row is-' + kind + (active ? ' is-on' : ' is-off') + ' is-toggle',
      title: title,
      dataset: { macroKey: key },
      disabled: kind === 'system',
    }, [
      element('span', { class: 'prompt-macro-name', text: label }),
      element('span', { class: 'prompt-macro-state', text: active ? 'on' : 'off' }),
    ]);
    button.setAttribute('aria-pressed', active ? 'true' : 'false');
    if (tab) button.addEventListener('click', () => updateValue(tab, key, active ? 0 : 1));
    return button;
  }

  function systemRow(name, macros) {
    if (name === 'POSE_INPAINT_PART') {
      const select = element('select', { class: 'prompt-macro-select', disabled: true, title: 'Fixed system macro' });
      const current = String(macros[name] == null ? 0 : macros[name]).toUpperCase();
      for (const value of PART_VALUES) {
        const option = element('option', { value: value, text: value });
        if (value === current) option.selected = true;
        select.append(option);
      }
      return macroRow(name, name, select, 'system');
    }
    return toggleRow(name, name, !!macros[name], 'system', 'Fixed system macro');
  }

  function customRow(tab, key, definition, value) {
    if (definition && definition.macroType === 'enum') {
      const select = element('select', { class: 'prompt-macro-select', title: definition.headline });
      for (const item of definition.values) {
        const option = element('option', { value: item, text: item });
        if (item.toUpperCase() === String(value == null ? '' : value).toUpperCase()) option.selected = true;
        select.append(option);
      }
      select.addEventListener('change', () => updateValue(tab, key, select.value));
      return macroRow(key, definition.name || key, select, 'custom');
    }

    return toggleRow(
      key,
      definition ? definition.name || key : key,
      !!boolValue(value),
      'custom',
      definition ? definition.headline : 'Undeclared boolean macro (off by default)',
      tab,
    );
  }

  function updateValue(tab, key, value) {
    const info = tabState(tab);
    const values = Object.assign({}, info.values, { [key]: value });
    persistValues(tab, values);
    render(tab);
  }

  function render(tab, force = false) {
    const panel = document.querySelector('.prompt-macro-panel[data-tab="' + CSS.escape(tab) + '"]');
    if (!panel) return;
    const body = panel.querySelector('.prompt-macro-body');
    const count = panel.querySelector('.prompt-macro-count');
    if (!body) return;

    const info = tabState(tab);
    const definitions = definitionsFor(tab);
    const references = referencesFor(tab);
    const macros = currentMacros(tab);
    const hasPrompt = promptText(tab).trim() !== '';
    const values = {};
    for (const [key, value] of Object.entries(info.values)) {
      if (SYSTEM_MACROS.includes(key)) continue;
      if (!syntax || !hasPrompt || Object.prototype.hasOwnProperty.call(definitions, key) || references.has(key)) {
        values[key] = value;
      }
    }
    const customKeys = new Set(
      [...Object.keys(definitions), ...references].filter((name) => !SYSTEM_MACROS.includes(name))
    );

    for (const [key, definition] of Object.entries(definitions)) {
      if (SYSTEM_MACROS.includes(key)) continue;
      if (definition.macroType === 'enum') {
        const current = String(values[key] == null ? '' : values[key]).toUpperCase();
        if (!definition.values.some((item) => item.toUpperCase() === current)) values[key] = definition.defaultValue;
      } else {
        values[key] = boolValue(values[key]);
      }
    }
    for (const key of customKeys) {
      if (!Object.prototype.hasOwnProperty.call(values, key)) values[key] = definitions[key] && definitions[key].macroType === 'enum' ? definitions[key].defaultValue : 0;
    }
    info.values = values;
    try {
      localStorage.setItem(STORE_PREFIX + tab, JSON.stringify(values));
    } catch (error) { /* storage full/blocked - values stay in memory */ }

    const signature = JSON.stringify({
      definitions: Object.values(definitions).map((item) => [item.key, item.macroType, item.values]),
      references: [...references].sort(),
      values: Object.keys(values).sort().map((key) => [key, values[key]]),
      macros: Object.keys(macros).sort().map((key) => [key, macros[key]]),
      stage: stageFor(tab),
    });
    info.lastText = promptText(tab);
    info.lastStage = stageFor(tab);
    if (!force && signature === info.lastSignature) return;
    info.lastSignature = signature;

    body.replaceChildren();
    for (const name of SYSTEM_MACROS) body.append(systemRow(name, macros));

    const keys = Array.from(customKeys).sort((a, b) => a.localeCompare(b));
    for (const key of keys) body.append(customRow(tab, key, definitions[key], values[key]));

    if (!keys.length) body.append(element('div', { class: 'prompt-macro-empty', text: 'No custom macros' }));
    if (count) count.textContent = keys.length ? String(keys.length) : '';

    writeHidden(tab, values);
    window.dispatchEvent(new CustomEvent('pedit-macros-changed', {
      detail: { tab: tab, values: values, macros: macros },
    }));
  }

  function scheduleRender(tab) {
    const info = tabState(tab);
    if (promptText(tab) === info.lastText && stageFor(tab) === info.lastStage) return;
    render(tab);
  }

  function bindPanel(tab) {
    const prompt = document.getElementById(tab + '_prompt');
    const negative = document.getElementById(tab + '_neg_prompt');
    const extra = tab === 'txt2img'
      ? [document.getElementById('hires_prompt'), document.getElementById('hires_neg_prompt')]
      : [];
    for (const host of [prompt, negative, ...extra]) {
      const field = fieldFor(host);
      if (!field) continue;
      field.addEventListener('input', () => scheduleRender(tab));
      field.addEventListener('change', () => scheduleRender(tab));
    }
    setInterval(() => scheduleRender(tab), 600);
  }

  function scanPanels() {
    for (const panel of document.querySelectorAll('.prompt-macro-panel')) {
      const tab = panel.dataset.tab;
      if (!tab || panel.dataset.macroReady === '1') continue;
      panel.dataset.macroReady = '1';
      tabState(tab).lastSignature = null;
      bindPanel(tab);
      render(tab);
    }
  }

  function init() {
    scanPanels();
    // Gradio can mount the HTML/textarea fields after DOMContentLoaded.
    setTimeout(scanPanels, 500);
    setTimeout(scanPanels, 1500);
    setTimeout(() => window.promptMacros.refresh(), 2500);
    setInterval(scanPanels, 2000);
  }

  window.promptMacros = {
    valuesFor(tab) {
      return Object.assign({}, tabState(tab).values);
    },
    macrosFor(tab) {
      return currentMacros(tab);
    },
    macrosForText(text, tab = 'txt2img') {
      return syntax ? syntax.macroState(text, stageFor(tab), tabState(tab).values).macros : null;
    },
    contextFor(tab) {
      return { definitions: definitionsFor(tab), references: referencesFor(tab) };
    },
    inactiveLines(text, macros) {
      return syntax ? syntax.inactiveConditionLines(text, macros) : new Set();
    },
    stageMacros(stage) {
      return syntax ? syntax.stageMacros(stage) : fallbackStageMacros(stage);
    },
    refresh() {
      for (const panel of document.querySelectorAll('.prompt-macro-panel')) {
        if (panel.dataset.tab) render(panel.dataset.tab, true);
      }
    },
  };

  import('/file=mobile_lite/js/prompt-syntax.js')
    .then((module) => {
      syntax = module;
      window.promptMacros.refresh();
    })
    .catch((error) => console.warn('promptMacros: syntax module unavailable', error));

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
