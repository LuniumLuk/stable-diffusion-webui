"""Local pose analysis for the img2img Inpaint tab.

The inpaint pose panel uses a local network to find face/hand/foot keypoints and turns
them into separate point-expanded masks for the batch-mask layer panel.

Two fully local backends are supported:

* DWPose ONNX (``yolox_l.onnx`` + ``dw-ll_ucoco_384.onnx``).  When the files are present
  it is preferred because COCO-WholeBody gives 68 face points, 21 points per hand and
  3 points per foot, which works well for both photos and anime.
* torchvision Keypoint R-CNN (COCO 17).  Used automatically when DWPose files are not
  available; hand/foot masks get an extra point along the forearm/shin so the radius
  covers the whole extremity.

No remote service is used for inference: model files are discovered on disk (or cached by
torchvision on first use) and all keypoint detection runs locally.  The only network
access is the explicit one-time "Get DWPose" download triggered from the panel.
"""

from __future__ import annotations

import base64
import glob
import importlib.util
import io
import math
import os
import sys
import threading
import time

import numpy as np
from PIL import Image, ImageDraw, ImageOps

REGION_CODES = ("face", "hands", "feet")
REGION_LABELS = {
    "face": "Face",
    "left_hand": "Left hand",
    "right_hand": "Right hand",
    "left_foot": "Left foot",
    "right_foot": "Right foot",
}
SUPPORTED_BACKENDS = ("auto", "dwpose", "torchvision")

SCORE_THRESHOLD = 0.30
PERSON_THRESHOLD = 0.60
MASK_FILL = (255, 64, 64, 255)

# COCO keypoint order; all parsed poses are normalized to it.
COCO_EDGES = (
    (0, 1), (0, 2), (1, 3), (2, 4),
    (5, 6), (5, 7), (7, 9), (6, 8), (8, 10),
    (5, 11), (6, 12), (11, 12),
    (11, 13), (13, 15), (12, 14), (14, 16),
)

# DWPose returns OpenPose body order after its neck insertion; this maps COCO indices
# to the equivalent OpenPose indices so the rest of the code only deals with COCO order.
OPENPOSE_TO_COCO = (0, 15, 14, 17, 16, 5, 2, 6, 3, 7, 4, 11, 8, 12, 9, 13, 10)

HAND_EDGES = (
    (0, 1), (1, 2), (2, 3), (3, 4),
    (0, 5), (5, 6), (6, 7), (7, 8),
    (0, 9), (9, 10), (10, 11), (11, 12),
    (0, 13), (13, 14), (14, 15), (15, 16),
    (0, 17), (17, 18), (18, 19), (19, 20),
)

DW_DETECTOR_FILE = "yolox_l.onnx"
DW_POSE_FILE = "dw-ll_ucoco_384.onnx"
DW_DETECTOR_URL = "https://huggingface.co/yzd-v/DWPose/resolve/main/yolox_l.onnx"
DW_POSE_URL = "https://huggingface.co/yzd-v/DWPose/resolve/main/dw-ll_ucoco_384.onnx"

_INFER_LOCK = threading.Lock()
_TORCHVISION = {"model": None, "device": None}
_DWPOSE = {"model": None, "paths": None}


class PoseModelUnavailable(RuntimeError):
    """Raised when no local pose network can be loaded."""


def _paths():
    from modules import paths

    return paths


def _dwpose_roots() -> list[str]:
    candidates = []

    env_dir = os.environ.get("SD_WEBUI_POSE_MODEL_DIR")
    if env_dir:
        candidates.append(env_dir)

    try:
        candidates.append(os.path.join(_paths().models_path, "pose"))
        controlnet = os.path.join(_paths().extensions_dir, "sd-webui-controlnet")
        candidates.append(os.path.join(controlnet, "annotator", "downloads", "openpose"))
        candidates.append(os.path.join(controlnet, "models", "openpose"))
    except (ImportError, AttributeError, OSError):
        pass

    seen = set()
    unique = []
    for path in candidates:
        path = os.path.abspath(path)
        if path not in seen:
            seen.add(path)
            unique.append(path)
    return unique


def dwpose_model_dir() -> str | None:
    """Return the first directory that contains both DWPose ONNX files."""
    for root in _dwpose_roots():
        detector = os.path.join(root, DW_DETECTOR_FILE)
        pose = os.path.join(root, DW_POSE_FILE)
        if (
            os.path.isfile(detector)
            and os.path.isfile(pose)
            and os.path.getsize(detector) > 1024 * 1024
            and os.path.getsize(pose) > 1024 * 1024
        ):
            return root
    return None


def _torchvision_weights_cached() -> bool:
    try:
        import torch

        cache_dir = os.path.join(torch.hub.get_dir(), "checkpoints")
    except (ImportError, AttributeError, OSError):
        cache_dir = os.path.join(os.path.expanduser("~"), ".cache", "torch", "hub", "checkpoints")
    return bool(glob.glob(os.path.join(cache_dir, "keypointrcnn_resnet50_fpn_coco-*.pth")))


def _hf_url(url: str) -> str:
    """Honor HF_ENDPOINT so the download uses the same mirror as the rest of the UI."""
    endpoint = os.environ.get("HF_ENDPOINT")
    if not endpoint:
        return url
    endpoint = endpoint.rstrip("/")
    path = url.split("huggingface.co/", 1)[-1]
    return f"{endpoint}/{path}"


def _download_file(url: str, destination: str, timeout: float = 120.0) -> None:
    import shutil
    from urllib.request import Request, urlopen

    os.makedirs(os.path.dirname(destination), exist_ok=True)
    temporary = destination + ".part"

    request = Request(url, headers={"User-Agent": "stable-diffusion-webui-inpaint-pose"})
    try:
        with urlopen(request, timeout=timeout) as response, open(temporary, "wb") as handle:
            shutil.copyfileobj(response, handle)
    except Exception as error:
        if os.path.exists(temporary):
            os.remove(temporary)
        raise PoseModelUnavailable(f"Could not download {os.path.basename(destination)}: {error}") from error

    if os.path.getsize(temporary) < 1024 * 1024:
        os.remove(temporary)
        raise PoseModelUnavailable(f"Downloaded {os.path.basename(destination)} is too small; the mirror may be unavailable.")
    os.replace(temporary, destination)


def download_dwpose_models() -> dict:
    """One-time download of the two DWPose ONNX files into models/pose."""
    target = os.path.join(_paths().models_path, "pose")
    files = (
        (DW_DETECTOR_FILE, _hf_url(DW_DETECTOR_URL)),
        (DW_POSE_FILE, _hf_url(DW_POSE_URL)),
    )

    with _INFER_LOCK:
        for file_name, url in files:
            destination = os.path.join(target, file_name)
            if os.path.isfile(destination) and os.path.getsize(destination) > 1024 * 1024:
                continue
            print(f"Inpaint pose: downloading {file_name} from {url}")
            _download_file(url, destination)

    _DWPOSE["model"] = None
    _DWPOSE["paths"] = None
    return {"ok": True, "dir": target, "message": "DWPose models are ready"}


def _dwpose_importable() -> bool:
    if "annotator.openpose.wholebody" in sys.modules:
        return True
    try:
        root = os.path.join(_paths().extensions_dir, "sd-webui-controlnet")
    except (ImportError, AttributeError, OSError):
        return False
    return os.path.isfile(os.path.join(root, "annotator", "openpose", "wholebody.py"))


def backend_status() -> dict:
    dw_dir = dwpose_model_dir()
    dw_ready = dw_dir is not None and _dwpose_importable()
    torchvision_available = importlib.util.find_spec("torchvision") is not None

    if dw_ready:
        preferred = "dwpose"
        message = f"DWPose (local ONNX, full face/hand/foot keypoints)\n{dw_dir}"
    elif dw_dir:
        preferred = "torchvision" if torchvision_available else None
        message = "DWPose models found, but the ControlNet annotator is unavailable"
    elif torchvision_available:
        preferred = "torchvision"
        message = "Keypoint R-CNN (COCO 17)"
        if not _torchvision_weights_cached():
            message += " - weights are downloaded on first use"
    else:
        preferred = None
        message = "No local pose backend found"

    return {
        "available": preferred is not None,
        "backend": preferred,
        "message": message,
        "dwpose": dw_dir is not None,
        "dwpose_ready": dw_ready,
        "dwpose_dir": dw_dir,
        "torchvision": torchvision_available,
        "torchvision_weights": _torchvision_weights_cached(),
        "regions": list(REGION_CODES),
    }


class PersonPose:
    """Keypoints of one person, all in original-image pixels, normalized to COCO order."""

    __slots__ = ("body", "face", "left_foot", "left_hand", "right_foot", "right_hand")

    def __init__(self, body, face=None, left_hand=None, right_hand=None, left_foot=None, right_foot=None):
        self.body = list(body or [])
        self.face = list(face or [])
        self.left_hand = list(left_hand or [])
        self.right_hand = list(right_hand or [])
        self.left_foot = list(left_foot or [])
        self.right_foot = list(right_foot or [])


class DetectedPose:
    __slots__ = ("backend", "height", "people", "warnings", "width")

    def __init__(self, backend, width, height, people, warnings=None):
        self.backend = backend
        self.width = width
        self.height = height
        self.people = list(people or [])
        self.warnings = list(warnings or [])

    def mask_regions(self) -> list[tuple[str, list]]:
        """Return (region code, points) pairs; each pair becomes its own mask layer."""
        groups = {
            "face": [],
            "left_hand": [],
            "right_hand": [],
            "left_foot": [],
            "right_foot": [],
        }
        for person in self.people:
            for code, points in _region_groups(person).items():
                groups[code].extend(points)
        return [(code, points) for code, points in groups.items() if _valid_points(points)]

    def skeleton_extent(self) -> float:
        """Longest side of the bounding box around every usable point (0 when there are none).

        Used to size the repaint circles relative to the figure instead of a fixed pixel radius.
        """
        xs = []
        ys = []
        for person in self.people:
            groups = (person.body,) + tuple(_region_groups(person).values())
            for group in groups:
                for point in _valid_points(group):
                    xs.append(float(point[0]))
                    ys.append(float(point[1]))
        if not xs:
            return 0.0
        return max(max(xs) - min(xs), max(ys) - min(ys))


def _region_groups(person) -> dict[str, list]:
    return {
        "face": person.face,
        "left_hand": person.left_hand,
        "right_hand": person.right_hand,
        "left_foot": person.left_foot,
        "right_foot": person.right_foot,
    }


def _valid_points(points) -> list:
    return [pt for pt in (points or []) if pt is not None and len(pt) >= 3 and float(pt[2]) >= SCORE_THRESHOLD]


def _point(x, y, score):
    return (float(x), float(y), float(score))


def _mean_point(points):
    if not points:
        return None
    return (
        sum(pt[0] for pt in points) / len(points),
        sum(pt[1] for pt in points) / len(points),
        min(pt[2] for pt in points),
    )


def parse_dwpose_keypoints(raw) -> list[PersonPose]:
    """Split the DWPose COCO-WholeBody array into face/hand/foot keypoint groups.

    ``raw`` is the array returned by ControlNet's ``Wholebody``: ``(people, 134, 3)``.
    Index layout after the extra neck joint is inserted: 18 body (OpenPose order),
    6 foot, 68 face, 21 left hand, 21 right hand.
    """
    data = np.asarray(raw, dtype=np.float32)
    if data.ndim == 2:
        data = data[None, ...]
    if data.ndim != 3 or data.shape[1] < 134:
        raise ValueError(f"unexpected DWPose output shape: {data.shape}")

    people = []
    for person in data:
        body_openpose = [tuple(float(v) for v in person[i, :3]) for i in range(18)]
        body = [body_openpose[index] for index in OPENPOSE_TO_COCO]

        foot = [tuple(float(v) for v in person[i, :3]) for i in range(18, 24)]
        face = [tuple(float(v) for v in person[i, :3]) for i in range(24, 92)]
        left_hand = [tuple(float(v) for v in person[i, :3]) for i in range(92, 113)]
        right_hand = [tuple(float(v) for v in person[i, :3]) for i in range(113, 134)]

        # The ankles are the body points closest to the feet; including them makes the
        # foot circles cover the ankle as well as the toes/heel points.
        left_foot = foot[:3] + [body_openpose[13]]
        right_foot = foot[3:] + [body_openpose[10]]

        people.append(
            PersonPose(
                body=body,
                face=face,
                left_hand=left_hand + [body_openpose[7]],
                right_hand=right_hand + [body_openpose[4]],
                left_foot=left_foot,
                right_foot=right_foot,
            )
        )
    return people


def parse_torchvision_keypoints(
    boxes,
    scores,
    keypoints,
    person_threshold: float = PERSON_THRESHOLD,
    width: float = 0,
    height: float = 0,
) -> list[PersonPose]:
    """Convert Keypoint R-CNN output (COCO 17) into our person pose groups.

    The model only predicts wrists/ankles for hands/feet, so a point is added further
    along the forearm/shin; expanding it with the user radius then covers the extremity.
    """
    boxes = np.asarray(boxes, dtype=np.float32) if len(boxes) else np.zeros((0, 4), dtype=np.float32)
    scores = np.asarray(scores, dtype=np.float32) if len(scores) else np.zeros((0,), dtype=np.float32)
    keypoints = np.asarray(keypoints, dtype=np.float32) if len(keypoints) else np.zeros((0, 17, 3), dtype=np.float32)
    if keypoints.ndim != 3 or keypoints.shape[1] < 17 or keypoints.shape[2] < 3:
        raise ValueError(f"unexpected Keypoint R-CNN output shape: {keypoints.shape}")

    min_limb = max(2.0, float(height) * 0.01)
    leg_tolerance = max(2.0, float(height) * 0.05)

    def limb_visible(person_index: int, elbow_index: int, wrist_index: int, box_bottom: float, box_margin: float) -> bool:
        elbow = keypoints[person_index, elbow_index]
        wrist = keypoints[person_index, wrist_index]
        if elbow[2] < SCORE_THRESHOLD or wrist[2] < SCORE_THRESHOLD:
            return False
        if wrist[1] >= box_bottom - box_margin:
            return False  # the arm continues below the detected person: hand is out of frame
        return float(np.hypot(wrist[0] - elbow[0], wrist[1] - elbow[1])) > min_limb

    def leg_visible(person_index: int, hip_index: int, knee_index: int, ankle_index: int, box_bottom: float, box_margin: float) -> bool:
        hip = keypoints[person_index, hip_index]
        knee = keypoints[person_index, knee_index]
        ankle = keypoints[person_index, ankle_index]
        if min(hip[2], knee[2], ankle[2]) < SCORE_THRESHOLD:
            return False
        if hip[1] >= box_bottom - box_margin or ankle[1] >= box_bottom - box_margin:
            return False  # the lower body continues below the detected person: feet are cut off
        # Keypoint R-CNN often hallucinates a full lower body on close-up crops; a knee
        # above the hip and an ankle above the knee mean the leg is not actually visible.
        return knee[1] >= hip[1] - leg_tolerance and ankle[1] >= knee[1] - leg_tolerance

    people = []
    for index in range(min(len(boxes), len(scores), len(keypoints))):
        if float(scores[index]) < person_threshold:
            continue

        box = boxes[index]
        box_margin = max(2.0, float(box[3] - box[1]) * 0.02)
        box_bottom = float(box[3])

        body = [
            _point(values[0], values[1], values[2])
            for values in keypoints[index, :17]
        ]
        # Drop joints that sit on the bottom of the person box: they belong to a lower
        # body that is outside the crop.  This keeps both the skeleton overlay and the
        # hand/foot masks from painting the edge of close-up portraits.
        for joint_index in range(5, 17):
            if body[joint_index][1] >= box_bottom - box_margin:
                body[joint_index] = (body[joint_index][0], body[joint_index][1], 0.0)

        face_parts = [body[i] for i in (0, 1, 2, 3, 4) if float(body[i][2]) >= SCORE_THRESHOLD]
        face = list(face_parts)
        center = _mean_point(face_parts)
        if center is not None:
            face.append(center)

        def extremity(point_index: int, joint_index: int, extension: float, body=body):
            point = body[point_index]
            if float(point[2]) < SCORE_THRESHOLD:
                return []
            points = [point]
            joint = body[joint_index]
            if float(joint[2]) >= SCORE_THRESHOLD:
                points.append(
                    _point(
                        point[0] + (point[0] - joint[0]) * extension,
                        point[1] + (point[1] - joint[1]) * extension,
                        point[2],
                    )
                )
            return points

        left_hand = extremity(9, 7, 0.35) if limb_visible(index, 7, 9, box_bottom, box_margin) else []
        right_hand = extremity(10, 8, 0.35) if limb_visible(index, 8, 10, box_bottom, box_margin) else []
        left_foot = extremity(15, 13, 0.30) if leg_visible(index, 11, 13, 15, box_bottom, box_margin) else []
        right_foot = extremity(16, 14, 0.30) if leg_visible(index, 12, 14, 16, box_bottom, box_margin) else []

        people.append(
            PersonPose(
                body=body,
                face=face,
                left_hand=left_hand,
                right_hand=right_hand,
                left_foot=left_foot,
                right_foot=right_foot,
            )
        )
    return people


def _load_dwpose(model_dir: str):
    if _DWPOSE["model"] is not None and _DWPOSE["paths"] == model_dir:
        return _DWPOSE["model"]

    root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(model_dir))))
    # model_dir is normally <controlnet>/annotator/downloads/openpose; the extension root
    # is three levels up.  Also try the plain extension location when a custom dir is set.
    candidates = [root]
    try:
        candidates.append(os.path.join(_paths().extensions_dir, "sd-webui-controlnet"))
    except (ImportError, AttributeError, OSError):
        pass

    for candidate in candidates:
        if os.path.isdir(os.path.join(candidate, "annotator", "openpose")):
            if candidate not in sys.path:
                sys.path.insert(0, candidate)
            break

    from annotator.openpose.wholebody import Wholebody

    model = Wholebody(
        os.path.join(model_dir, DW_DETECTOR_FILE),
        os.path.join(model_dir, DW_POSE_FILE),
    )
    _DWPOSE["model"] = model
    _DWPOSE["paths"] = model_dir
    return model


def _detect_dwpose(image: Image.Image) -> DetectedPose:
    model_dir = dwpose_model_dir()
    if not model_dir:
        raise PoseModelUnavailable(
            "DWPose models were not found. Put yolox_l.onnx and dw-ll_ucoco_384.onnx into "
            "models/pose (or set SD_WEBUI_POSE_MODEL_DIR)."
        )

    with _INFER_LOCK:
        model = _load_dwpose(model_dir)
        raw = model(np.asarray(image.convert("RGB")))

    people = parse_dwpose_keypoints(raw) if raw is not None else []
    return DetectedPose("dwpose", image.width, image.height, people)


def _load_torchvision():
    if _TORCHVISION["model"] is not None:
        return _TORCHVISION["model"], _TORCHVISION["device"]

    import torch
    from torchvision.models.detection import (
        KeypointRCNN_ResNet50_FPN_Weights,
        keypointrcnn_resnet50_fpn,
    )

    model = keypointrcnn_resnet50_fpn(
        weights=KeypointRCNN_ResNet50_FPN_Weights.DEFAULT,
        box_score_thresh=0.35,
        box_detections_per_img=20,
    )
    model.eval()

    try:
        from modules import devices

        device = devices.get_device_for("inpaint_pose")
    except (ImportError, AttributeError, RuntimeError):
        device = torch.device("cpu")

    try:
        model.to(device)
    except RuntimeError:
        device = torch.device("cpu")
        model.to(device)

    _TORCHVISION["model"] = model
    _TORCHVISION["device"] = device
    return model, device


def _detect_torchvision(image: Image.Image) -> DetectedPose:
    if importlib.util.find_spec("torchvision") is None:
        raise PoseModelUnavailable("torchvision is not installed; install it or provide DWPose ONNX models.")

    import torch

    rgb = image.convert("RGB")
    # Keep the input bounded; torchvision would downscale internally anyway, and this
    # keeps the first-run VRAM/RAM spike reasonable for large inpaint canvases.
    scale = min(1.0, 1280.0 / max(rgb.width, rgb.height))
    if scale < 1.0:
        rgb = rgb.resize((max(1, round(rgb.width * scale)), max(1, round(rgb.height * scale))), Image.LANCZOS)

    tensor = torch.from_numpy(np.asarray(rgb, dtype=np.uint8).copy()).permute(2, 0, 1).float().div_(255.0)

    with _INFER_LOCK:
        model, device = _load_torchvision()
        try:
            with torch.inference_mode():
                output = model([tensor.to(device)])[0]
        except RuntimeError as error:
            if device.type != "cuda" or "out of memory" not in str(error).lower():
                raise
            # A generation may be holding the GPU: retry the analysis on CPU.
            device = torch.device("cpu")
            model.to(device)
            _TORCHVISION["device"] = device
            with torch.inference_mode():
                output = model([tensor.to(device)])[0]

    boxes = output.get("boxes", []).detach().cpu().numpy()
    scores = output.get("scores", []).detach().cpu().numpy()
    keypoints = output.get("keypoints", []).detach().cpu().numpy()
    people = parse_torchvision_keypoints(boxes, scores, keypoints, width=rgb.width, height=rgb.height)

    if scale != 1.0:
        inverse = 1.0 / scale
        for person in people:
            for group in (person.body, person.face, person.left_hand, person.right_hand, person.left_foot, person.right_foot):
                for index, point in enumerate(group):
                    group[index] = _point(point[0] * inverse, point[1] * inverse, point[2])

    return DetectedPose("torchvision", image.width, image.height, people)


def detect_pose(image: Image.Image, backend: str = "auto") -> DetectedPose:
    backend = (backend or "auto").lower()
    if backend not in SUPPORTED_BACKENDS:
        raise ValueError(f"unknown pose backend: {backend}")

    warnings = []
    if backend in ("auto", "dwpose") and dwpose_model_dir():
        try:
            return _detect_dwpose(image)
        except Exception as error:
            if backend == "dwpose":
                raise
            warnings.append(f"DWPose failed ({error}); falling back to Keypoint R-CNN")

    if backend == "dwpose":
        raise PoseModelUnavailable(
            "DWPose models were not found. Put yolox_l.onnx and dw-ll_ucoco_384.onnx into "
            "models/pose (or set SD_WEBUI_POSE_MODEL_DIR)."
        )

    pose = _detect_torchvision(image)
    pose.warnings.extend(warnings)
    return pose


def _draw_l_mask(size, points, radius: int) -> Image.Image:
    mask = Image.new("L", size, 0)
    draw = ImageDraw.Draw(mask)
    for x, y, _score in points:
        draw.ellipse(
            (round(x - radius), round(y - radius), round(x + radius), round(y + radius)),
            fill=255,
        )
    return mask


def _draw_point_mask(size, points, radius: int) -> Image.Image:
    """RGBA circles at every point; the alpha channel is the batch-mask mask."""
    mask = _draw_l_mask(size, points, radius)
    colored = Image.new("RGBA", size, (0, 0, 0, 0))
    colored.paste(MASK_FILL, mask=mask)
    return colored


def _expand_region_codes(regions) -> set[str]:
    expanded = {
        "face": {"face"},
        "hands": {"left_hand", "right_hand"},
        "feet": {"left_foot", "right_foot"},
    }
    allowed = set()
    for code in regions or REGION_CODES:
        if code in expanded:
            allowed.update(expanded[code])
    return allowed


def collect_region_points(pose: DetectedPose, regions=None, radius: int = 40, extend: float = 0.0) -> dict[str, list]:
    """Group the usable points of the requested parts by mask region.

    Points too close to the frame edge are dropped: pose models often hallucinate
    extremities there on close-up crops, and a circle there would refine empty space.

    ``extend`` walks hand and foot points further out along their limb (in multiples of the
    last bone, elbow->wrist or knee->ankle) so fingers and toes beyond the detected
    wrist/ankle are covered as well.  The original points stay and the walk is filled with
    overlapping circles, so the mask becomes a continuous capsule that only ever grows.
    """
    allowed = _expand_region_codes(regions)
    border = max(3.0, float(radius) * 0.25)
    collected: dict[str, list] = {}

    def inside(point):
        return border <= point[0] <= pose.width - border and border <= point[1] <= pose.height - border

    for person in pose.people:
        for code, points in _region_groups(person).items():
            if code not in allowed:
                continue
            filtered = [point for point in _valid_points(points) if inside(point)]
            if not filtered:
                continue
            offset = _limb_offset(person.body, code, extend)
            if offset is not None:
                walked = []
                for point in filtered:
                    walked.extend(_walk(point, offset, radius))
                filtered = filtered + [point for point in walked if inside(point)]
            collected.setdefault(code, []).extend(filtered)

    return collected


LIMB_BONES = {
    "left_hand": (7, 9),  # COCO elbow -> wrist
    "right_hand": (8, 10),
    "left_foot": (13, 15),  # COCO knee -> ankle
    "right_foot": (14, 16),
}


def _limb_offset(body, code: str, extend: float):
    """Offset that moves a hand/foot point ``extend`` x its last bone further along the limb."""
    bone = LIMB_BONES.get(code)
    if not bone or not extend or float(extend) <= 0:
        return None

    start, end = bone
    if start >= len(body) or end >= len(body):
        return None

    joint, tip = body[start], body[end]
    if float(joint[2]) < SCORE_THRESHOLD or float(tip[2]) < SCORE_THRESHOLD:
        return None

    amount = float(extend)
    return (float(tip[0]) - float(joint[0])) * amount, (float(tip[1]) - float(joint[1])) * amount


def _walk(point, offset, radius: int) -> list:
    """Points between ``point`` and ``point + offset``, spaced so their circles overlap."""
    dx, dy = offset
    distance = math.hypot(dx, dy)
    if distance <= 0:
        return []
    steps = max(1, math.ceil(distance / max(1.0, float(radius))))
    x, y, score = point
    return [_point(x + dx * step / steps, y + dy * step / steps, score) for step in range(1, steps + 1)]


def build_region_mask(pose: DetectedPose, regions=None, radius: int = 40, extend: float = 0.0):
    """Single binary mask covering every selected face/hand/foot point.

    Returns ``(mask, point_count)``; ``mask`` is None when no usable points exist.
    """
    radius = max(1, min(1024, int(radius)))
    collected = collect_region_points(pose, regions=regions, radius=radius, extend=extend)
    if not collected:
        return None, 0

    points = [point for group in collected.values() for point in group]
    mask = _draw_l_mask((pose.width, pose.height), points, radius)
    return mask, len(points)


REGION_MASK_ORDER = ("face", "left_hand", "right_hand", "left_foot", "right_foot")


def build_region_masks(pose: DetectedPose, regions=None, radius: int = 40, extend: float = 0.0) -> list[tuple[str, Image.Image, int]]:
    """One mask per body part, so each part gets its own (small) only-masked inpaint.

    Returns ``[(region code, mask, point count)]`` in ``REGION_MASK_ORDER``; parts without
    usable points are dropped.
    """
    radius = max(1, min(1024, int(radius)))
    collected = collect_region_points(pose, regions=regions, radius=radius, extend=extend)
    masks = []
    for code in REGION_MASK_ORDER:
        points = collected.get(code)
        if not points:
            continue
        masks.append((code, _draw_l_mask((pose.width, pose.height), points, radius), len(points)))
    return masks


def resolve_radius(pose: DetectedPose, radius: int = 40, percent: float = 0.0) -> int:
    """Point radius in pixels for this image.

    ``percent`` (> 0) makes the radius follow the figure: that percentage of the skeleton's
    longest side.  It falls back to the fixed ``radius`` when no skeleton was found.
    """
    fixed = max(1, min(1024, int(radius)))
    if not percent or float(percent) <= 0:
        return fixed

    extent = pose.skeleton_extent()
    if extent <= 0:
        return fixed
    return max(2, min(1024, round(extent * float(percent) / 100.0)))


def _scaled_size(width: int, height: int, target: int) -> tuple[int, int]:
    """Scale ``width``/``height`` so the long side is ``target``, snapped to the 8px grid."""
    scale = target / max(width, height)
    return (
        max(64, int(width * scale) // 8 * 8),
        max(64, int(height * scale) // 8 * 8),
    )


def inpaint_crop_size(width: int, height: int, max_size: int = 1024) -> tuple[int, int]:
    """Sampling size for an only-masked crop: the crop as-is, capped at ``max_size``."""
    target = max(64, min(int(max_size), 2048, max(width, height)))
    return _scaled_size(width, height, target)


def region_inpaint_size(mask: Image.Image, inpaint_size: int = 1024, padding: int = 32) -> tuple[int, int]:
    """Sampling size for one region: its padded box scaled so the long side is ``inpaint_size``."""
    box = mask.getbbox()
    if box is None:
        return (64, 64)
    x1, y1, x2, y2 = box
    width = max(1, x2 - x1) + max(0, int(padding)) * 2
    height = max(1, y2 - y1) + max(0, int(padding)) * 2
    return _scaled_size(width, height, max(64, min(int(inpaint_size), 2048)))


def choose_inpaint_prompt(p, index: int) -> tuple[str, str]:
    """Compiled prompt for one image, using the hires prompt when hires fix ran.

    ``index`` is the global image index (iteration * batch_size + batch_index).
    """

    def at(sequence):
        if isinstance(sequence, (list, tuple)) and 0 <= index < len(sequence):
            value = sequence[index]
            if isinstance(value, str) and value:
                return value
        return None

    prompt = None
    negative = None

    if getattr(p, "enable_hr", False):
        prompt = at(getattr(p, "all_hr_prompts", None))
        negative = at(getattr(p, "all_hr_negative_prompts", None))

    prompt = prompt or at(getattr(p, "all_prompts", None)) or getattr(p, "prompt", "") or ""
    negative = negative or at(getattr(p, "all_negative_prompts", None)) or getattr(p, "negative_prompt", "") or ""
    return prompt, negative


def _draw_joint(draw: ImageDraw.ImageDraw, point, radius: int, color):
    x, y, score = point
    if score < SCORE_THRESHOLD:
        return
    draw.ellipse(
        (round(x - radius), round(y - radius), round(x + radius), round(y + radius)),
        fill=color,
        outline=(0, 0, 0, 210),
        width=1,
    )


def _draw_edges(draw, points, edges, color, width: int):
    for start, end in edges:
        if start >= len(points) or end >= len(points):
            continue
        a = points[start]
        b = points[end]
        if a[2] < SCORE_THRESHOLD or b[2] < SCORE_THRESHOLD:
            continue
        draw.line((a[0], a[1], b[0], b[1]), fill=color, width=width)


def render_skeleton(pose: DetectedPose) -> Image.Image:
    """Transparent overlay with the body skeleton and every used keypoint."""
    image = Image.new("RGBA", (pose.width, pose.height), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    scale = max(pose.width, pose.height)
    line = max(2, round(scale / 250))
    joint = max(2, round(line * 1.35))
    small = max(1, round(line * 0.65))

    body_color = (72, 232, 128, 255)
    face_color = (255, 214, 64, 255)
    left_color = (64, 202, 255, 255)
    right_color = (255, 112, 220, 255)
    foot_left_color = (255, 164, 64, 255)
    foot_right_color = (255, 96, 96, 255)

    for person in pose.people:
        _draw_edges(draw, person.body, COCO_EDGES, body_color, line)
        _draw_edges(draw, person.left_hand, HAND_EDGES, left_color, max(1, line - 1))
        _draw_edges(draw, person.right_hand, HAND_EDGES, right_color, max(1, line - 1))

        for index, point in enumerate(person.body):
            if index <= 4:
                continue  # head points are drawn in the face color below
            _draw_joint(draw, point, joint, body_color)

        for point in person.face:
            _draw_joint(draw, point, small, face_color)
        for point in person.left_hand:
            _draw_joint(draw, point, small, left_color)
        for point in person.right_hand:
            _draw_joint(draw, point, small, right_color)
        for point in person.left_foot:
            _draw_joint(draw, point, joint, foot_left_color)
        for point in person.right_foot:
            _draw_joint(draw, point, joint, foot_right_color)

    return image


def encode_png_data_url(image: Image.Image) -> str:
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return "data:image/png;base64," + base64.b64encode(buffer.getvalue()).decode("ascii")


def decode_image_data_url(value: str) -> Image.Image:
    if not isinstance(value, str) or not value:
        raise ValueError("empty image")

    payload = value.split(",", 1)[1] if value.startswith("data:") else value
    raw = base64.b64decode(payload)
    image = Image.open(io.BytesIO(raw))
    image.load()
    image = ImageOps.exif_transpose(image)

    if image.mode in ("RGBA", "LA", "PA") or (image.mode == "P" and "transparency" in image.info):
        background = Image.new("RGBA", image.size, (255, 255, 255, 255))
        image = Image.alpha_composite(background, image.convert("RGBA"))
    return image.convert("RGB")


def detect_inpaint_regions(
    image: Image.Image,
    regions=None,
    radius: int = 40,
    backend: str = "auto",
    include_skeleton: bool = True,
    extend: float = 0.0,
    radius_percent: float = 0.0,
) -> dict:
    started = time.time()
    requested = [code for code in (REGION_CODES if regions is None else regions) if code in REGION_CODES]
    if not requested:
        raise ValueError("no pose region selected")

    pose = detect_pose(image, backend=backend)
    radius = resolve_radius(pose, radius, radius_percent)
    collected = collect_region_points(pose, regions=requested, radius=radius, extend=extend)

    masks = []
    for code, points in collected.items():
        mask = _draw_point_mask((pose.width, pose.height), points, radius)
        masks.append(
            {
                "region": code,
                "name": REGION_LABELS[code],
                "points": len(points),
                "data": encode_png_data_url(mask),
            }
        )

    skeleton = encode_png_data_url(render_skeleton(pose)) if include_skeleton else None
    elapsed = time.time() - started
    people = len(pose.people)
    print(f"Inpaint pose: {pose.backend} found {people} person(s), {len(masks)} mask(s) in {elapsed:.2f}s")

    if masks:
        message = f"{len(masks)} mask(s) from {people} person(s)"
    elif people:
        message = "No face/hand/foot points found"
    else:
        message = "No person detected"

    return {
        "backend": pose.backend,
        "people": people,
        "radius": radius,
        "masks": masks,
        "skeleton": skeleton,
        "elapsed": round(elapsed, 3),
        "warnings": pose.warnings,
        "msg": message,
    }
