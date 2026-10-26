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
    assert inpaint_pose.inpaint_crop_size(4000, 4000, 512) == (512, 512)


def test_build_region_masks_splits_every_part():
    person = inpaint_pose.PersonPose(
        body=[(100.0, 100.0, 0.9)] * 17,
        face=[(100.0, 80.0, 0.9)],
        left_hand=[(50.0, 120.0, 0.9)],
        right_hand=[(150.0, 120.0, 0.9)],
        left_foot=[(80.0, 180.0, 0.9)],
        right_foot=[(120.0, 180.0, 0.9)],
    )
    pose = inpaint_pose.DetectedPose("test", 200, 200, [person])

    masks = inpaint_pose.build_region_masks(pose, radius=10)
    assert [code for code, _mask, _count in masks] == ["face", "left_hand", "right_hand", "left_foot", "right_foot"]
    assert [count for _code, _mask, count in masks] == [1, 1, 1, 1, 1]
    assert masks[0][1].getpixel((100, 80)) == 255
    assert masks[0][1].getpixel((50, 120)) == 0
    assert masks[1][1].getpixel((50, 120)) == 255
    assert masks[4][1].getpixel((120, 180)) == 255
    assert inpaint_pose.build_region_masks(pose, regions=["face"], radius=10)[0][0] == "face"
    assert len(inpaint_pose.build_region_masks(pose, regions=["hands"], radius=10)) == 2


def test_build_region_masks_empty_without_points():
    pose = inpaint_pose.DetectedPose("test", 200, 200, [inpaint_pose.PersonPose(body=[(100.0, 100.0, 0.9)] * 17)])

    assert inpaint_pose.build_region_masks(pose, regions=["face"], radius=10) == []


def _limbed_person():
    body = [(100.0, 100.0, 0.9)] * 17
    body[7] = (60.0, 100.0, 0.9)   # left elbow
    body[9] = (40.0, 100.0, 0.9)   # left wrist
    body[13] = (90.0, 160.0, 0.9)  # left knee
    body[15] = (90.0, 180.0, 0.9)  # left ankle
    return inpaint_pose.PersonPose(
        body=body,
        left_hand=[(40.0, 100.0, 0.9)],
        left_foot=[(90.0, 180.0, 0.9)],
    )


def test_collect_region_points_extends_hands_and_feet_along_the_limb():
    pose = inpaint_pose.DetectedPose("test", 400, 400, [_limbed_person()])

    plain = inpaint_pose.collect_region_points(pose, regions=["hands", "feet"], radius=10)
    assert plain["left_hand"] == [(40.0, 100.0, 0.9)]
    assert plain["left_foot"] == [(90.0, 180.0, 0.9)]

    # left wrist - left elbow = (-20, 0); left ankle - left knee = (0, 20)
    extended = inpaint_pose.collect_region_points(pose, regions=["hands", "feet"], radius=10, extend=1.5)
    hand = extended["left_hand"]
    foot = extended["left_foot"]

    # the walk starts at the detected point and ends 1.5 bones further along, filled so the
    # circles overlap (steps <= radius apart)
    assert hand[0] == (40.0, 100.0, 0.9)
    assert hand[-1] == (10.0, 100.0, 0.9)
    assert len(hand) == 4
    assert all(y == 100.0 for _x, y, _score in hand)
    assert foot[0] == (90.0, 180.0, 0.9)
    assert foot[-1] == (90.0, 210.0, 0.9)
    assert len(foot) == 4
    assert all(x == 90.0 for x, _y, _score in foot)


def test_collect_region_points_extend_is_skipped_for_face_and_unknown_joints():
    person = _limbed_person()
    person.face = [(100.0, 80.0, 0.9)]
    pose = inpaint_pose.DetectedPose("test", 400, 400, [person])

    assert inpaint_pose.collect_region_points(pose, regions=["face"], radius=10, extend=2)["face"] == [(100.0, 80.0, 0.9)]

    # a missing (low-score) elbow leaves the hand point where the detector put it
    person.body[7] = (60.0, 100.0, 0.0)
    hidden = inpaint_pose.collect_region_points(pose, regions=["hands"], radius=10, extend=2)
    assert hidden["left_hand"] == [(40.0, 100.0, 0.9)]


def test_build_region_mask_extension_grows_the_mask():
    pose = inpaint_pose.DetectedPose("test", 400, 400, [_limbed_person()])

    plain, _points = inpaint_pose.build_region_mask(pose, regions=["hands"], radius=10)
    extended, points = inpaint_pose.build_region_mask(pose, regions=["hands"], radius=10, extend=1.5)
    assert extended.getpixel((10, 100)) == 255
    assert plain.getpixel((10, 100)) == 0
    # the walk fills the gap, so the whole extension is one continuous capsule
    assert extended.getpixel((25, 100)) == 255
    assert plain.getpixel((25, 100)) == 0
    assert points == 4


def test_skeleton_extent_uses_the_point_bounding_box():
    person = inpaint_pose.PersonPose(
        body=[(100.0, 100.0, 0.9)] * 17,
        face=[(100.0, 80.0, 0.9)],
        right_foot=[(300.0, 400.0, 0.9)],
    )
    pose = inpaint_pose.DetectedPose("test", 500, 500, [person])

    assert pose.skeleton_extent() == 320.0
    assert inpaint_pose.DetectedPose("test", 500, 500, []).skeleton_extent() == 0.0


def test_resolve_radius_follows_the_skeleton_when_a_percent_is_given():
    person = inpaint_pose.PersonPose(body=[(100.0, 100.0, 0.9)] * 17, right_foot=[(300.0, 400.0, 0.9)])
    pose = inpaint_pose.DetectedPose("test", 500, 500, [person])

    assert pose.skeleton_extent() == 300.0
    assert inpaint_pose.resolve_radius(pose, 40, 0) == 40
    assert inpaint_pose.resolve_radius(pose, 40, 5) == 15  # 5% of 300
    assert inpaint_pose.resolve_radius(pose, 40, 50) == 150
    # no skeleton: keep the fixed radius
    assert inpaint_pose.resolve_radius(inpaint_pose.DetectedPose("test", 500, 500, []), 40, 5) == 40
    # clamps
    assert inpaint_pose.resolve_radius(pose, 4000, 0) == 1024
    assert inpaint_pose.resolve_radius(pose, 40, 0.01) == 2


def test_region_inpaint_size_keeps_region_aspect():
    mask = Image.new("L", (400, 400), 0)
    mask.paste(255, (100, 100, 200, 160))  # 100x60 region

    width, height = inpaint_pose.region_inpaint_size(mask, inpaint_size=1024, padding=0)
    assert (width, height) == (1024, 608)
    # padding grows both sides of the box
    assert inpaint_pose.region_inpaint_size(mask, inpaint_size=1024, padding=20) == (1024, 728)
    # the size setting is honoured, and stays on the 8px grid
    assert max(inpaint_pose.region_inpaint_size(mask, inpaint_size=512, padding=0)) == 512
    assert all(dimension % 8 == 0 for dimension in inpaint_pose.region_inpaint_size(mask, inpaint_size=700, padding=0))


def test_region_inpaint_size_honours_small_and_empty_regions():
    tiny = Image.new("L", (400, 400), 0)
    tiny.paste(255, (100, 100, 110, 110))  # 10x10 region

    assert inpaint_pose.region_inpaint_size(tiny, inpaint_size=1024, padding=0) == (1024, 1024)
    assert inpaint_pose.region_inpaint_size(tiny, inpaint_size=99999, padding=0) == (2048, 2048)
    assert inpaint_pose.region_inpaint_size(Image.new("L", (8, 8), 0), inpaint_size=1024) == (64, 64)


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
