/* Hires. fix helpers for the Mobile Lite UI (pure - no DOM, unit tested).

 * The stage-config syntax and the derived plan mirror the desktop implementation in
 * ``modules/processing.py`` (``parse_hr_stage_config_text`` / ``build_hr_stage_plan``) so the
 * live hint in the params sheet matches what the backend will actually execute.
 */

const LATENT_GRID = 8;

const roundToLatentGrid = (value) => Math.max(LATENT_GRID, Math.round(value / LATENT_GRID) * LATENT_GRID);

/**
 * Parse the stage config textarea. Entries are separated by newlines or semicolons; each entry
 * carries an optional ``cfg``, ``steps`` and ``denoise`` next to the required ``scale``.
 * Entries without a scale > 1.0 are ignored, exactly like the backend parser.
 */
export function parseHrStageConfig(text) {
  const stages = [];
  for (const chunk of String(text || '').split(/[;\n]+/)) {
    const line = chunk.trim();
    if (!line) continue;

    const stage = {};
    for (const part of line.split(',')) {
      const item = part.trim();
      const colon = item.indexOf(':');
      if (colon < 0) continue;
      const key = item.slice(0, colon).trim().toLowerCase();
      const value = item.slice(colon + 1).trim();

      if (key === 'scale') {
        const numeric = Number(value);
        if (Number.isFinite(numeric)) stage.scale = numeric;
      } else if (key === 'cfg') {
        const numeric = Number(value);
        if (Number.isFinite(numeric)) stage.cfg = numeric;
      } else if (key === 'steps') {
        const numeric = Number(value);
        if (Number.isFinite(numeric) && numeric >= 0) stage.steps = Math.round(numeric);
      } else if (key === 'denoise') {
        const numeric = Number(value);
        if (Number.isFinite(numeric) && numeric >= 0 && numeric <= 1) stage.denoise = numeric;
      }
    }

    if (typeof stage.scale === 'number' && stage.scale > 1) {
      stages.push({
        scale: stage.scale,
        cfg: stage.cfg ?? null,
        steps: stage.steps ?? null,
        denoise: stage.denoise ?? null,
      });
    }
  }
  return stages;
}

export function hrScaleValue(params = {}) {
  return Math.min(4, Math.max(1, Number(params.hrScale) || 2));
}

/** Final hires resolution: the backend uses ``int(width * hr_scale)`` (no resize fields in lite). */
export function hrFinalSize(params = {}) {
  const width = Math.max(64, Number(params.width) || 512);
  const height = Math.max(64, Number(params.height) || 512);
  const scale = hrScaleValue(params);
  return { width: Math.trunc(width * scale), height: Math.trunc(height * scale) };
}

/**
 * Derived stage plan for the live hint: per configured stage a latent-grid target capped at the
 * final size (non-growing stages are skipped), then the final origin-parameter pass when the last
 * stage does not already reach the target. Without a config there are no stages - the plan is the
 * plain single hires pass to the target.
 */
export function hrStagePlan(params = {}) {
  const baseWidth = Math.max(64, Number(params.width) || 512);
  const baseHeight = Math.max(64, Number(params.height) || 512);
  const final = hrFinalSize(params);

  let current = { width: baseWidth, height: baseHeight };
  const stages = [];
  for (const stage of parseHrStageConfig(params.hrStageConfig)) {
    const target = {
      width: Math.min(final.width, roundToLatentGrid(baseWidth * stage.scale)),
      height: Math.min(final.height, roundToLatentGrid(baseHeight * stage.scale)),
    };
    if (target.width <= current.width && target.height <= current.height) continue;
    stages.push({ ...stage, width: target.width, height: target.height, final: false });
    current = target;
  }

  const reached = current.width === final.width && current.height === final.height;
  const appended = !reached && stages.length > 0;
  if (appended) {
    stages.push({ scale: null, cfg: null, steps: null, denoise: null, width: final.width, height: final.height, final: true });
  }
  return { stages, appended, final };
}
