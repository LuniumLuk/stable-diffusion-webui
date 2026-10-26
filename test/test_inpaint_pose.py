import base64
import os
from types import SimpleNamespace

import numpy as np
import pytest
from PIL import Image

from modules import inpaint_pose


def make_dwpose_raw():
    raw = np.zeros((1, 134, 3), dtype=np.float32)
    raw[0, :, 0] = np.arange(134, dtype=np.float32)
    raw[0, :, 1] = np.arange(134, dtype=np.float32) * 2
    raw[0, :, 2] = 0.9
    raw[0, 0] = (10, 20, 0.95)  # nose (OpenPose 0)
    raw[0, 1] = (30, 40, 0.9)  # neck
    raw[0, 5] = (50, 60, 0.9)  # left shoulder
    raw[0, 7] = (70, 80, 0.9)  # left wrist
    raw[0, 10] = (90, 100, 0.9)  # right ankle
    raw[0, 13] = (110, 120, 0.9)  # left ankle
    raw[0, 14] = (130, 140, 0.9)  # right eye
    return raw


def test_parse_dwpose_normalizes_to_coco_order():
    people = inpaint_pose.parse_dwpose_keypoints(make_dwpose_raw())
    assert len(people) == 1
    person = people[0]

    assert person.body[0][:2] == (10.0, 20.0)  # nose
    assert person.body[2][:2] == (130.0, 140.0)  # COCO right eye is OpenPose 14
    assert person.body[5][:2] == (50.0, 60.0)  # COCO left shoulder is OpenPose 5
    assert person.body[9][:2] == (70.0, 80.0)  # left wrist

    assert len(person.face) == 68
    assert len(person.left_hand) == 22  # 21 hand points + wrist
    assert len(person.right_hand) == 22
    assert len(person.left_foot) == 4  # 3 foot points + ankle
    assert person.left_foot[0][:2] == (18.0, 36.0)
    assert person.left_foot[-1][:2] == (110.0, 120.0)
    assert person.right_foot[0][:2] == (21.0, 42.0)
    assert person.right_foot[-1][:2] == (90.0, 100.0)


def test_dwpose_people_render_skeleton():
    people = inpaint_pose.parse_dwpose_keypoints(make_dwpose_raw())
    pose = inpaint_pose.DetectedPose("dwpose", 400, 400, people)
    skeleton = inpaint_pose.render_skeleton(pose)

    assert skeleton.size == (400, 400)
    assert skeleton.getbbox() is not None


def test_parse_torchvision_adds_extremity_points():
    keypoints = np.zeros((2, 17, 3), dtype=np.float32)
    keypoints[0, 0] = (100, 100, 0.9)  # nose
    keypoints[0, 1] = (90, 100, 0.9)  # left eye
    keypoints[0, 2] = (110, 100, 0.9)  # right eye
    keypoints[0, 3] = (80, 100, 0.9)  # left ear
    keypoints[0, 4] = (120, 100, 0.9)  # right ear
    keypoints[0, 7] = (80, 200, 0.9)  # left elbow
    keypoints[0, 9] = (80, 260, 0.9)  # left wrist
    keypoints[0, 11] = (70, 150, 0.9)  # left hip
    keypoints[0, 13] = (140, 200, 0.9)  # left knee
    keypoints[0, 15] = (140, 260, 0.9)  # left ankle

    boxes = np.array([[0, 0, 200, 300], [0, 0, 200, 300]], dtype=np.float32)
    scores = np.array([0.99, 0.1], dtype=np.float32)

    people = inpaint_pose.parse_torchvision_keypoints(boxes, scores, keypoints)
    assert len(people) == 1
    person = people[0]

    assert len(person.face) == 6  # five head keypoints + their centre
    assert len(person.left_hand) == 2
    assert person.left_hand[1][1] > person.left_hand[0][1]  # extended past the wrist
    assert len(person.left_foot) == 2
    assert person.left_foot[1][1] > person.left_foot[0][1]
    assert person.right_hand == []


def test_point_mask_is_alpha_shaped():
    mask = inpaint_pose._draw_point_mask((120, 100), [(50, 40, 0.9)], radius=12)
    assert mask.mode == "RGBA"
    assert mask.size == (120, 100)
    assert mask.getpixel((50, 40))[3] == 255
    assert mask.getpixel((50, 40))[:3] == inpaint_pose.MASK_FILL[:3]
    assert mask.getpixel((5, 5))[3] == 0


def test_skeleton_is_transparent_overlay():
    body = [(100.0, 100.0, 0.9)] * 17
    person = inpaint_pose.PersonPose(
        body=body,
        face=[(100.0, 90.0, 0.9)],
        left_hand=[(60.0, 80.0, 0.9)],
        right_hand=[(140.0, 80.0, 0.9)],
        left_foot=[(80.0, 150.0, 0.9)],
        right_foot=[(120.0, 150.0, 0.9)],
    )
    pose = inpaint_pose.DetectedPose("test", 200, 200, [person])
    skeleton = inpaint_pose.render_skeleton(pose)

    assert skeleton.mode == "RGBA"
    assert skeleton.size == (200, 200)
    assert skeleton.getpixel((100, 100))[3] > 0
    assert skeleton.getpixel((5, 5))[3] == 0


def test_detect_regions_builds_separate_masks(monkeypatch):
    body = [(100.0, 100.0, 0.9)] * 17
    person = inpaint_pose.PersonPose(
        body=body,
        face=[(100.0, 80.0, 0.9)],
        left_hand=[(50.0, 120.0, 0.9)],
        right_hand=[(150.0, 120.0, 0.9)],
        left_foot=[(80.0, 180.0, 0.9)],
        right_foot=[(120.0, 180.0, 0.9)],
    )
    pose = inpaint_pose.DetectedPose("test", 200, 200, [person])
    monkeypatch.setattr(inpaint_pose, "detect_pose", lambda image, backend="auto": pose)

    result = inpaint_pose.detect_inpaint_regions(
        Image.new("RGB", (200, 200), "white"),
        regions=["face", "hands", "feet"],
        radius=12,
    )

    assert [mask["name"] for mask in result["masks"]] == ["Face", "Left hand", "Right hand", "Left foot", "Right foot"]
    assert all(mask["data"].startswith("data:image/png;base64,") for mask in result["masks"])
    assert result["skeleton"].startswith("data:image/png;base64,")
    assert result["people"] == 1
    assert result["msg"] == "5 mask(s) from 1 person(s)"


def test_detect_regions_respects_selection(monkeypatch):
    person = inpaint_pose.PersonPose(
        body=[(100.0, 100.0, 0.9)] * 17,
        face=[(100.0, 80.0, 0.9)],
        left_hand=[(50.0, 120.0, 0.9)],
        right_hand=[(150.0, 120.0, 0.9)],
        left_foot=[(80.0, 180.0, 0.9)],
        right_foot=[(120.0, 180.0, 0.9)],
    )
    monkeypatch.setattr(
        inpaint_pose,
        "detect_pose",
        lambda image, backend="auto": inpaint_pose.DetectedPose("test", 200, 200, [person]),
    )

    result = inpaint_pose.detect_inpaint_regions(Image.new("RGB", (200, 200)), regions=["face"], radius=10, include_skeleton=False)
    assert [mask["name"] for mask in result["masks"]] == ["Face"]
    assert result["skeleton"] is None


def test_build_region_mask_unions_selected_parts():
    person = inpaint_pose.PersonPose(
        body=[(100.0, 100.0, 0.9)] * 17,
        face=[(100.0, 80.0, 0.9)],
        left_hand=[(50.0, 120.0, 0.9)],
        right_hand=[(150.0, 120.0, 0.9)],
        left_foot=[(80.0, 180.0, 0.9)],
        right_foot=[(120.0, 180.0, 0.9)],
    )
    pose = inpaint_pose.DetectedPose("test", 200, 200, [person])

    mask, points = inpaint_pose.build_region_mask(pose, regions=["face", "hands"], radius=10)
    assert mask is not None
    assert mask.mode == "L"
    assert points == 3
    assert mask.getpixel((100, 80)) == 255
    assert mask.getpixel((50, 120)) == 255
    assert mask.getpixel((150, 120)) == 255
    assert mask.getpixel((80, 180)) == 0


def test_build_region_mask_none_without_points():
    pose = inpaint_pose.DetectedPose("test", 200, 200, [inpaint_pose.PersonPose(body=[(100.0, 100.0, 0.9)] * 17)])

    mask, points = inpaint_pose.build_region_mask(pose, regions=["face"], radius=10)
    assert mask is None
    assert points == 0


def test_inpaint_crop_size_caps_large_images():
    assert inpaint_pose.inpaint_crop_size(512, 512) == (512, 512)
    assert inpaint_pose.inpaint_crop_size(1536, 1024) == (1024, 680)
    assert inpaint_pose.inpaint_crop_size(4096, 512) == (1024, 128)
    assert inpaint_pose.inpaint_crop_size(10, 10) == (64, 64)


def test_choose_inpaint_prompt_prefers_compiled_hr_prompt():
    p = SimpleNamespace(
        enable_hr=True,
        all_prompts=["main compiled"],
        all_negative_prompts=["main negative"],
        all_hr_prompts=["hires compiled"],
        all_hr_negative_prompts=["hires negative"],
        prompt="raw",
        negative_prompt="raw negative",
    )

    assert inpaint_pose.choose_inpaint_prompt(p, 0) == ("hires compiled", "hires negative")


def test_choose_inpaint_prompt_uses_compiled_main_without_hr():
    p = SimpleNamespace(
        enable_hr=False,
        all_prompts=["main compiled"],
        all_negative_prompts=["main negative"],
        all_hr_prompts=["hires compiled"],
        all_hr_negative_prompts=["hires negative"],
        prompt="raw",
        negative_prompt="raw negative",
    )

    assert inpaint_pose.choose_inpaint_prompt(p, 0) == ("main compiled", "main negative")


def test_choose_inpaint_prompt_falls_back_to_raw_prompt():
    p = SimpleNamespace(
        enable_hr=False,
        all_prompts=[],
        all_negative_prompts=[],
        prompt="raw",
        negative_prompt="raw negative",
    )

    assert inpaint_pose.choose_inpaint_prompt(p, 0) == ("raw", "raw negative")


def test_detect_regions_skips_offscreen_points(monkeypatch):
    person = inpaint_pose.PersonPose(
        body=[(100.0, 100.0, 0.9)] * 17,
        face=[(100.0, 80.0, 0.9)],
        left_hand=[(250.0, 250.0, 0.9)],
        right_hand=[(150.0, 120.0, 0.9)],
        left_foot=[(80.0, 250.0, 0.9)],
        right_foot=[(120.0, 180.0, 0.9)],
    )
    monkeypatch.setattr(
        inpaint_pose,
        "detect_pose",
        lambda image, backend="auto": inpaint_pose.DetectedPose("test", 200, 200, [person]),
    )

    result = inpaint_pose.detect_inpaint_regions(Image.new("RGB", (200, 200)), regions=["hands", "feet"], radius=10)
    assert [mask["name"] for mask in result["masks"]] == ["Right hand", "Right foot"]


def test_detect_regions_reports_no_points(monkeypatch):
    person = inpaint_pose.PersonPose(body=[(100.0, 100.0, 0.9)] * 17)
    monkeypatch.setattr(
        inpaint_pose,
        "detect_pose",
        lambda image, backend="auto": inpaint_pose.DetectedPose("test", 200, 200, [person]),
    )

    result = inpaint_pose.detect_inpaint_regions(Image.new("RGB", (200, 200)), regions=["hands"], radius=10)
    assert result["masks"] == []
    assert result["msg"] == "No face/hand/foot points found"


def test_detect_regions_rejects_empty_selection(monkeypatch):
    monkeypatch.setattr(
        inpaint_pose,
        "detect_pose",
        lambda image, backend="auto": inpaint_pose.DetectedPose("test", 10, 10, []),
    )

    with pytest.raises(ValueError, match="no pose region selected"):
        inpaint_pose.detect_inpaint_regions(Image.new("RGB", (10, 10)), regions=[])


def test_decode_image_data_url(tmp_path):
    path = tmp_path / "test.png"
    Image.new("RGB", (8, 6), (12, 34, 56)).save(path)

    value = "data:image/png;base64," + base64.b64encode(path.read_bytes()).decode()

    image = inpaint_pose.decode_image_data_url(value)
    assert image.mode == "RGB"
    assert image.size == (8, 6)
    assert image.getpixel((0, 0)) == (12, 34, 56)


def test_dwpose_model_dir_prefers_env(tmp_path, monkeypatch):
    payload = b"x" * (1024 * 1024 + 1)
    (tmp_path / inpaint_pose.DW_DETECTOR_FILE).write_bytes(payload)
    (tmp_path / inpaint_pose.DW_POSE_FILE).write_bytes(payload)
    monkeypatch.setenv("SD_WEBUI_POSE_MODEL_DIR", str(tmp_path))

    assert inpaint_pose.dwpose_model_dir() == str(tmp_path)


def test_hf_url_uses_configured_mirror(monkeypatch):
    monkeypatch.setenv("HF_ENDPOINT", "https://hf-mirror.example/")

    assert inpaint_pose._hf_url(inpaint_pose.DW_DETECTOR_URL) == (
        "https://hf-mirror.example/yzd-v/DWPose/resolve/main/yolox_l.onnx"
    )


def test_download_dwpose_models(monkeypatch, tmp_path):
    monkeypatch.setattr(inpaint_pose, "_paths", lambda: SimpleNamespace(models_path=str(tmp_path)))
    monkeypatch.delenv("HF_ENDPOINT", raising=False)

    calls = []

    def fake_download(url, destination, timeout=120.0):
        calls.append((url, destination))
        os.makedirs(os.path.dirname(destination), exist_ok=True)
        with open(destination, "wb") as handle:
            handle.write(b"x" * (1024 * 1024 + 1))

    monkeypatch.setattr(inpaint_pose, "_download_file", fake_download)

    result = inpaint_pose.download_dwpose_models()
    assert result["ok"] is True
    assert len(calls) == 2
    assert (tmp_path / "pose" / inpaint_pose.DW_DETECTOR_FILE).is_file()
    assert (tmp_path / "pose" / inpaint_pose.DW_POSE_FILE).is_file()

    calls.clear()
    inpaint_pose.download_dwpose_models()
    assert calls == []


def test_backend_status_shape():
    status = inpaint_pose.backend_status()
    assert set(status) >= {"available", "backend", "message", "dwpose", "dwpose_ready", "torchvision", "regions"}
    assert status["regions"] == ["face", "hands", "feet"]
