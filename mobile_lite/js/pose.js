/* Pure helpers for the txt2img "Pose inpaint" always-on script. */

export const POSE_PARTS = ['Face', 'Hands', 'Feet'];

function clamp(value, min, max, fallback) {
  if (value === null || value === undefined || value === '') return fallback;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(max, Math.max(min, numeric));
}

/** Arguments for ``alwayson['Pose inpaint'].args`` in the order the desktop script expects. */
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
  ];
}

/** Compact summary-line badge; empty when the pass is off. */
export function poseInpaintSummary(params = {}) {
  if (!params.poseInpaintEnabled) return '';
  const selected = Array.isArray(params.poseInpaintParts) ? params.poseInpaintParts : POSE_PARTS;
  const count = POSE_PARTS.filter((part) => selected.includes(part)).length;
  if (!count) return 'Pose (no parts)';
  return `Pose ${count}p r${Math.round(clamp(params.poseInpaintRadius, 8, 400, 40))}`;
}
