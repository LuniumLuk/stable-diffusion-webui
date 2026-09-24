/* Shared parameters sheet (sampler/steps/size/seed + img2img extras). */

import { api_ } from './api.js';
import { closeSheet, el, openSheet, toast } from './ui.js';
import { emit, persist, resolveOutputSize, setParam, state } from './state.js';

const SIZE_PRESETS = [
  [512, 512],
  [768, 768],
  [832, 1216],
  [1216, 832],
  [1024, 1024],
];

function sliderRow(label, key, min, max, step, { format = (value) => value } = {}) {
  const number = el('input', { type: 'number', value: state.params[key], min, max, step, inputmode: 'decimal' });
  const range = el('input', { type: 'range', value: state.params[key], min, max, step });
  const valueLabel = el('span', { class: 'small', text: format(state.params[key]) });

  const sync = (value, source) => {
    const numeric = Number(value);
    if (Number.isNaN(numeric)) return;
    const bounded = Math.min(max, Math.max(min, numeric));
    state.params[key] = bounded;
    if (source !== 'range') range.value = bounded;
    if (source !== 'number') number.value = bounded;
    valueLabel.textContent = format(bounded);
    persist();
    emit('params', state.params);
  };

  range.addEventListener('input', () => sync(range.value, 'range'));
  number.addEventListener('change', () => sync(number.value, 'number'));

  return el('div', { class: 'field' }, [
    el('label', { text: label }),
    el('div', { class: 'row tight' }, [range, number]),
    valueLabel,
  ]);
}

function selectRow(label, options, value, onChange) {
  const select = el('select', {}, options.map((option) => {
    const optionValue = typeof option === 'string' ? option : option.value;
    const optionLabel = typeof option === 'string' ? option : option.label;
    return el('option', { value: optionValue, text: optionLabel, selected: optionValue === value });
  }));
  select.addEventListener('change', () => onChange(select.value));
  return el('div', { class: 'field' }, [el('label', { text: label }), select]);
}

function segmentedControl(label, options, value, onChange) {
  const buttons = options.map((option) => el('button', {
    type: 'button',
    class: option.value === value ? 'on' : '',
    text: option.label,
    onClick: () => {
      buttons.forEach((button, index) => button.classList.toggle('on', options[index].value === option.value));
      onChange(option.value);
    },
  }));
  const node = el('div', { class: 'field' }, [
    label ? el('label', { text: label }) : null,
    el('div', { class: 'segmented' }, buttons),
  ].filter(Boolean));
  const set = (next) => buttons.forEach((button, index) => button.classList.toggle('on', options[index].value === next));
  return { node, set };
}

function segmented(label, options, value, onChange) {
  return segmentedControl(label, options, value, onChange).node;
}

export async function applyModel(title) {
  const overlay = toast('switching checkpoint…', 'info', 6000);
  try {
    const response = await api_.options({ sd_model_checkpoint: title });
    state.boot.model = response.model || title;
    emit('model', state.boot.model);
    overlay.textContent = `\u2713 model: ${state.boot.model}`;
  } catch (error) {
    overlay.textContent = `model switch failed: ${error.message}`;
  }
}

export function openParamsSheet(kind = 'text') {
  const body = el('div');
  const params = state.params;

  body.append(selectRow(
    'Checkpoint',
    (state.boot.models || []).map((model) => ({ value: model.title, label: model.title })),
    state.boot.model,
    (value) => applyModel(value),
  ));

  body.append(selectRow('Sampler', state.boot.samplers || [], params.sampler, (value) => setParam('sampler', value)));
  body.append(selectRow('Scheduler', state.boot.schedulers || ['Automatic'], params.scheduler, (value) => setParam('scheduler', value)));

  body.append(sliderRow('Sampling steps', 'steps', 1, 80, 1));
  body.append(sliderRow('CFG scale', 'cfg', 1, 20, 0.5, { format: (value) => Number(value).toFixed(1) }));
  body.append(sliderRow('Batch count', 'batch', 1, 8, 1));

  // Size block -------------------------------------------------------------
  const widthInput = el('input', { type: 'number', value: params.width, min: 64, max: 2048, step: 8, inputmode: 'numeric' });
  const heightInput = el('input', { type: 'number', value: params.height, min: 64, max: 2048, step: 8, inputmode: 'numeric' });
  const sizeRow = el('div', { class: 'row tight' }, [widthInput, el('span', { text: '×' }), heightInput]);

  const sizeChips = el('div', { class: 'chips' }, SIZE_PRESETS.map(([width, height]) => el('button', {
    class: 'chip',
    type: 'button',
    text: `${width}×${height}`,
    onClick: () => {
      widthInput.value = width;
      heightInput.value = height;
      syncSize(); // also switches the size mode to custom
    },
  })));
  const sizeHint = el('span', { class: 'small muted' });
  const sizePreview = el('div', { class: 'size-preview' });
  let sizeMode = null; // assigned below (image screens only - they have the three size modes)
  let scaleField = null; // 'Scale x input' row, shown only in scale mode
  const scaleValue = () => Math.min(4, Math.max(0.1, Number(params.sizeScale) || 1));

  /**
   * Keep the output-size block readable: the mode control, the resolved size and the row that
   * belongs to the active mode sit together, and the W/H fields only appear for 'custom'.
   */
  const syncSizeControls = () => {
    if (kind !== 'image') return;
    const source = state.image.source;
    const mode = params.imageSizeMode;
    const custom = mode === 'custom';
    sizeChips.classList.toggle('hidden', !custom);
    sizeRow.classList.toggle('hidden', !custom);
    if (scaleField) scaleField.classList.toggle('hidden', mode !== 'scale');
    const size = resolveOutputSize();
    sizePreview.textContent = `${size.width}\u00D7${size.height}`;
    if (mode === 'scale') {
      sizeHint.textContent = source
        ? `input ${source.width}\u00D7${source.height} \u00D7${scaleValue()}`
        : 'load an image first - the factor applies to its dimensions';
    } else if (mode === 'auto') {
      sizeHint.textContent = source ? 'matches the input image' : 'load an image first';
    } else {
      sizeHint.textContent = 'custom size';
    }
  };

  const updateSizeHint = () => {
    if (kind !== 'image') {
      sizeHint.textContent = '';
      return;
    }
    syncSizeControls();
  };

  const selectSizeMode = (value) => {
    setParam('imageSizeMode', value);
    if (sizeMode) sizeMode.set(value);
    if (value === 'custom') {
      // start from what the previous mode resolved to instead of stale custom values
      const size = resolveOutputSize();
      widthInput.value = size.width;
      heightInput.value = size.height;
      setParam('width', size.width);
      setParam('height', size.height);
    }
    updateSizeHint();
  };

  const applyCustomSize = () => {
    if (params.imageSizeMode !== 'custom') {
      setParam('imageSizeMode', 'custom');
      if (sizeMode) sizeMode.set('custom');
    }
    updateSizeHint();
  };

  const syncSize = () => {
    const width = Math.min(2048, Math.max(64, Math.round(Number(widthInput.value) / 8) * 8 || 512));
    const height = Math.min(2048, Math.max(64, Math.round(Number(heightInput.value) / 8) * 8 || 512));
    widthInput.value = width;
    heightInput.value = height;
    setParam('width', width);
    setParam('height', height);
    // typing a size means the user wants it - switch off "match input" instead of ignoring it
    if (kind === 'image') applyCustomSize();
  };
  widthInput.addEventListener('change', syncSize);
  heightInput.addEventListener('change', syncSize);

  if (kind === 'image') {
    // no separate label - the selector belongs to the 'Output size' field above it
    sizeMode = segmentedControl('', [
      { value: 'auto', label: 'Match input' },
      { value: 'scale', label: 'Scale \u00D7' },
      { value: 'custom', label: 'Custom' },
    ], params.imageSizeMode, selectSizeMode);
  }

  const sizeField = el('div', { class: 'field' }, [
    el('label', { text: kind === 'image' ? 'Output size' : 'Size' }),
    ...(sizeMode ? [sizeMode.node] : []),
    ...(kind === 'image' ? [sizePreview] : []),
    sizeChips,
    sizeRow,
    sizeHint,
  ]);
  body.append(sizeField);
  updateSizeHint();

  // Seed block -------------------------------------------------------------
  const seedInput = el('input', { type: 'number', value: params.seed, min: -1, max: 2147483647, inputmode: 'numeric' });
  const lockButton = el('button', {
    class: `btn tiny ${params.seedLock ? 'on' : ''}`,
    type: 'button',
    text: params.seedLock ? '\u{1F512} locked' : '\u{1F513} auto',
    title: 'Keep this seed for every run',
  });
  lockButton.addEventListener('click', () => {
    params.seedLock = !params.seedLock;
    lockButton.textContent = params.seedLock ? '\u{1F512} locked' : '\u{1F513} auto';
    lockButton.classList.toggle('on', params.seedLock);
    persist();
    emit('params', params);
  });
  seedInput.addEventListener('change', () => {
    const value = Number(seedInput.value);
    setParam('seed', Number.isNaN(value) ? -1 : value);
  });

  body.append(el('div', { class: 'field' }, [
    el('label', { text: 'Seed (-1 = random)' }),
    el('div', { class: 'seed-row' }, [
      seedInput,
      el('button', {
        class: 'btn tiny dice', type: 'button', text: '\u{1F3B2}', title: 'Random seed',
        onClick: () => { seedInput.value = -1; setParam('seed', -1); },
      }),
      lockButton,
    ]),
  ]));

  // img2img extras ---------------------------------------------------------
  if (kind === 'image') {
    body.append(sliderRow('Denoising strength', 'denoise', 0, 1, 0.01, { format: (value) => Number(value).toFixed(2) }));
    body.append(sliderRow('Mask blur', 'maskBlur', 0, 32, 1));

    // 'Scale x input': same idea as the desktop 'Resize By' scale slider
    const SCALE_PRESETS = [0.5, 0.75, 1, 1.25, 1.5, 2];
    const scaleInput = el('input', { type: 'number', value: scaleValue(), min: 0.1, max: 4, step: 0.05, inputmode: 'decimal' });
    const scaleChips = SCALE_PRESETS.map((value) => el('button', {
      class: 'chip',
      type: 'button',
      text: `${value}\u00D7`,
      onClick: () => applyScale(value),
    }));
    const applyScale = (value) => {
      const numeric = Number(value);
      const bounded = Math.min(4, Math.max(0.1, Math.round((Number.isNaN(numeric) ? 1 : numeric) * 100) / 100));
      scaleInput.value = bounded;
      scaleChips.forEach((button, index) => button.classList.toggle('on', Math.abs(SCALE_PRESETS[index] - bounded) < 1e-9));
      setParam('sizeScale', bounded);
      syncSizeControls();
    };
    scaleField = el('div', { class: 'field hidden' }, [
      el('label', { text: 'Scale (\u00D7 input image)' }),
      el('div', { class: 'chips' }, scaleChips),
      el('div', { class: 'row tight' }, [scaleInput]),
    ]);
    scaleInput.addEventListener('change', () => applyScale(scaleInput.value));
    applyScale(scaleValue()); // normalises the stored factor and highlights its chip
    sizeField.insertBefore(scaleField, sizeHint);
    updateSizeHint();

    body.append(segmented('Resize mode', [
      { value: 0, label: 'Just resize' },
      { value: 1, label: 'Crop and resize' },
      { value: 2, label: 'Resize and fill' },
      { value: 3, label: 'Just resize (latent upscale)' },
    ], params.fitMode, (value) => setParam('fitMode', Number(value))));

    // inpaint-only controls (masked by the mode active when the sheet opens)
    if (state.image.mode === 'inpaint') {
      body.append(segmented('Masked content', [
        { value: 0, label: 'Fill' },
        { value: 1, label: 'Original' },
        { value: 2, label: 'Latent noise' },
        { value: 3, label: 'Latent nothing' },
      ], params.fill, (value) => setParam('fill', Number(value))));

      let paddingField = null;
      body.append(segmented('Inpaint area', [
        { value: 'whole', label: 'Whole picture' },
        { value: 'masked', label: 'Only masked' },
      ], params.inpaintFullRes ? 'masked' : 'whole', (value) => {
        setParam('inpaintFullRes', value === 'masked');
        if (paddingField) paddingField.classList.toggle('hidden', value !== 'masked');
      }));

      paddingField = sliderRow('Only masked padding, px', 'inpaintPadding', 0, 256, 4);
      paddingField.classList.toggle('hidden', !params.inpaintFullRes);
      body.append(paddingField);

      body.append(segmented('Mask mode', [
        { value: 'masked', label: 'Inpaint masked' },
        { value: 'inverted', label: 'Inpaint not masked' },
      ], params.invertMask ? 'inverted' : 'masked', (value) => setParam('invertMask', value === 'inverted')));
    }
  }

  openSheet({
    title: kind === 'image' ? 'Image parameters' : 'Text parameters',
    body,
    actions: [{ label: 'Done', primary: true, onClick: () => closeSheet() }],
  });
}
