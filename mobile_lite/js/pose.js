/* Pure helpers for the txt2img "Pose inpaint" always-on script and the mask-editor pose tool. */

export const POSE_PARTS = ['Face', 'Hands', 'Feet'];
// Extra skeleton joints of the "Custom nodes" part; one mask per joint group.
export const POSE_CUSTOM_NODES = ['Shoulders', 'Elbows', 'Wrists', 'Hips', 'Knees', 'Ankles'];
export const POSE_CUSTOM_PART = 'Custom nodes';
export const POSE_PART_OPTIONS = [...POSE_PARTS, POSE_CUSTOM_PART];

function clamp(value, min, max, fallback) {
  if (value === null || value === undefined || value === '') return fallback;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(max, Math.max(min, numeric));
}

function radiusMode(value) {
  return value === 'px' ? 'px' : 'percent';
}

function sizeMode(value) {
  return value === 'px' ? 'px' : 'scale';
}

function backend(value) {
  const text = String(value || '').trim().toLowerCase();
  if (text === 'dwpose' || text === 'dw') return 'dwpose';
  if (text === 'torchvision' || text === 'coco' || text === 'coco 17') return 'torchvision';
  return 'auto';
}

/**
 * Arguments for ``alwayson['Pose inpaint'].args``, in the order the desktop script expects:
 * enable, parts, radius px, denoise, steps, save intermediate, inpaint size, one pass per part,
 * radius % of skeleton, hand/foot extend, point-size mode, inpaint-size mode, inpaint scale,
 * max skeletons, provider, custom nodes.
 */
export function poseInpaintArgs(params = {}) {
  const selected = new Set(Array.isArray(params.poseInpaintParts) ? params.poseInpaintParts : POSE_PARTS);
  const parts = POSE_PART_OPTIONS.filter((part) => selected.has(part));
  const picked = new Set(Array.isArray(params.poseInpaintCustomNodes) ? params.poseInpaintCustomNodes : []);
  return [
    true,
    parts,
    Math.round(clamp(params.poseInpaintRadius, 8, 400, 40)),
    clamp(params.poseInpaintDenoise, 0, 1, 0.4),
    Math.round(clamp(params.poseInpaintSteps, 0, 150, 0)),
    Boolean(params.poseInpaintSaveIntermediate),
    Math.round(clamp(params.poseInpaintSize, 256, 2048, 1024) / 64) * 64,
    params.poseInpaintSeparate !== false,
    Math.round(clamp(params.poseInpaintRadiusPercent, 0.5, 25, 5) * 2) / 2,
    Math.round(clamp(params.poseInpaintExtend, 0, 2, 0.5) * 20) / 20,
    radiusMode(params.poseInpaintRadiusMode),
    sizeMode(params.poseInpaintSizeMode),
    Math.round(clamp(params.poseInpaintScale, 1, 4, 2) * 10) / 10,
    Math.round(clamp(params.poseInpaintMaxPeople, 1, 16, 4)),
    backend(params.poseInpaintBackend),
    POSE_CUSTOM_NODES.filter((node) => picked.has(node)),
  ];
}

/** Compact summary-line badge; empty when the pass is off. */
export function poseInpaintSummary(params = {}) {
  if (!params.poseInpaintEnabled) return '';
  const selected = Array.isArray(params.poseInpaintParts) ? params.poseInpaintParts : POSE_PARTS;
  const count = POSE_PART_OPTIONS.filter((part) => selected.includes(part)).length;
  if (!count) return 'Pose (no parts)';

  const percent = Math.round(clamp(params.poseInpaintRadiusPercent, 0.5, 25, 5) * 2) / 2;
  const px = Math.round(clamp(params.poseInpaintRadius, 8, 400, 40));
  const radius = radiusMode(params.poseInpaintRadiusMode) === 'px' ? `${px}px` : `${percent}%`;

  const sizePx = Math.round(clamp(params.poseInpaintSize, 256, 2048, 1024) / 64) * 64;
  const scale = Math.round(clamp(params.poseInpaintScale, 1, 4, 2) * 10) / 10;
  const size = sizeMode(params.poseInpaintSizeMode) === 'px' ? `${sizePx}px` : `${scale}\u00D7`;
  const people = Math.round(clamp(params.poseInpaintMaxPeople, 1, 16, 4));

  return `Pose ${count}p r${radius} \u00B7 ${size} \u00B7 \u2264${people}`;
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
    radius_mode: radiusMode(options.radiusMode),
    radius_percent: Math.round(clamp(options.radiusPercent, 0.5, 25, 5) * 2) / 2,
    extend: Math.round(clamp(options.extend, 0, 2, 0.5) * 20) / 20,
    max_people: Math.round(clamp(options.maxPeople, 1, 16, 4)),
    backend: backend(options.backend),
    include_skeleton: false,
  };
}
