/* Input pre-resize helpers for the Mobile Lite Image screen (pure - no DOM, unit tested).

 * The optional "Input resize" runs before img2img/inpaint touches the picture: the init image is
 * resized once, and inpaint masks are resized with the same geometry. The backend
 * (``modules/mobile_lite.py::_apply_input_resize``) is authoritative; these mirrors power the
 * params-sheet preview and the screen summary only, so they must stay in sync with it.
 */

export function round8(value) {
  return Math.min(2048, Math.max(64, Math.round(value / 8) * 8));
}

export function inputResizeScale(params = {}) {
  return Math.min(4, Math.max(0.1, Number(params.inputResizeScale) || 1));
}

function inputResizeMode(params = {}) {
  return params.inputResize === 'scale' || params.inputResize === 'custom' ? params.inputResize : 'off';
}

/**
 * What the backend will do to the init image: target size (snapped to the 8 px grid), the fitting
 * rule ('fill' = cover then center-crop, 'stretch' = ignore aspect) and the automatic filter -
 * area averaging for downscales, Lanczos for upscales (same choice for the inpaint mask).
 */
export function planInputResize(source, params = {}) {
  if (!source) return null;
  const srcWidth = Math.max(1, Math.trunc(Number(source.width) || 0));
  const srcHeight = Math.max(1, Math.trunc(Number(source.height) || 0));
  if (!srcWidth || !srcHeight) return null;

  const mode = inputResizeMode(params);
  let width = round8(srcWidth);
  let height = round8(srcHeight);
  let fit = 'fill';

  if (mode === 'scale') {
    const factor = inputResizeScale(params);
    width = round8(srcWidth * factor);
    height = round8(srcHeight * factor);
  } else if (mode === 'custom') {
    width = round8(Number(params.inputResizeW) || srcWidth);
    height = round8(Number(params.inputResizeH) || srcHeight);
    fit = params.inputResizeFit === 'stretch' ? 'stretch' : 'fill';
  }

  const cover = mode === 'custom' && fit === 'fill';
  // same rule as the backend: cover is judged by its real scale factor, everything else by area
  const downscale = cover
    ? Math.max(width / srcWidth, height / srcHeight) < 1
    : width * height < srcWidth * srcHeight;
  return {
    mode,
    width,
    height,
    fit,
    cover,
    downscale,
    filter: downscale ? 'area' : 'lanczos',
    srcWidth,
    srcHeight,
    same: width === srcWidth && height === srcHeight,
    cropped: cover && width / height !== srcWidth / srcHeight,
  };
}

/** Effective input size after the pre-resize - the baseline for the output-size modes. */
export function resolveInputSize(source, params = {}) {
  const plan = planInputResize(source, params);
  return plan ? { width: plan.width, height: plan.height, plan } : null;
}
