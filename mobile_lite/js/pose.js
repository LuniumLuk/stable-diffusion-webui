/* Pure helpers for the txt2img "Pose inpaint" always-on script. */

export const POSE_PARTS = ['Face', 'Hands', 'Feet'];

function clamp(value, min, max, fallback) {
  if (value === null || value === undefined || value === '') return fallback;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(max, Math.max(min, numeric));
}

/**
 * Arguments for ``alwayson['Pose inpaint'].args``, in the order the desktop script expects:
 * enable, parts, radius px, denoise, steps, save intermediate, inpaint size, one pass per part,
 * radius % of skeleton, hand/foot extend.
 */
export function poseInpaintArgs(params = {}) {
  const selected = new Set(Array.isArray(params.poseInpaintParts) ? params.poseInpaintParts : POSE_PARTS);
  const parts = POSE_PARTS.filter((part) => selected.has(part));
  return [
    true,
    parts,
    Math.round(clamp(params.poseInpaintRadius, 8, 400, 40)),
    clamp(params.poseInpaintDenoise, 0, 1, 0.4),
    Math.round(clamp(params.poseInpaintSteps, 0, 150, 0)),
    Boolean(params.poseInpaintSaveIntermediate),
    Math.round(clamp(params.poseInpaintSize, 256, 2048, 1024) / 64) * 64,
    params.poseInpaintSeparate !== false,
    Math.round(clamp(params.poseInpaintRadiusPercent, 0, 25, 5) * 2) / 2,
    Math.round(clamp(params.poseInpaintExtend, 0, 2, 0.5) * 20) / 20,
  ];
}

/** Compact summary-line badge; empty when the pass is off. */
export function poseInpaintSummary(params = {}) {
  if (!params.poseInpaintEnabled) return '';
  const selected = Array.isArray(params.poseInpaintParts) ? params.poseInpaintParts : POSE_PARTS;
  const count = POSE_PARTS.filter((part) => selected.includes(part)).length;
  if (!count) return 'Pose (no parts)';
  const percent = Math.round(clamp(params.poseInpaintRadiusPercent, 0, 25, 5) * 2) / 2;
  const size = Math.round(clamp(params.poseInpaintSize, 256, 2048, 1024) / 64) * 64;
  const radius = percent > 0 ? `${percent}%` : `${Math.round(clamp(params.poseInpaintRadius, 8, 400, 40))}px`;
  return `Pose ${count}p r${radius} \u00B7 ${size}px`;
}

/** Mask-editor region codes for the selected parts (Face -> "face", Hands -> "hands"). */
export function poseMaskRegions(parts) {
  const selected = new Set(Array.isArray(parts) ? parts : POSE_PARTS);
  return POSE_PARTS.filter((part) => selected.has(part)).map((part) => part.toLowerCase());
}

/** Payload for ``/inpaint-pose/detect`` from the inpaint mask editor settings. */
export function poseMaskRequest(inputImage, options = {}) {
  return {
    input_image: inputImage,
    regions: poseMaskRegions(options.parts),
    radius: Math.round(clamp(options.radius, 8, 400, 40)),
    radius_percent: Math.round(clamp(options.radiusPercent, 0, 25, 5) * 2) / 2,
    extend: Math.round(clamp(options.extend, 0, 2, 0.5) * 20) / 20,
    include_skeleton: false,
  };
}

/** Editor hint for the current settings ("5% of skeleton", "40px"). */
export function poseMaskRadiusLabel(options = {}) {
  const percent = Math.round(clamp(options.radiusPercent, 0, 25, 5) * 2) / 2;
  return percent > 0 ? `${percent}% of skeleton` : `${Math.round(clamp(options.radius, 8, 400, 40))}px`;
}
