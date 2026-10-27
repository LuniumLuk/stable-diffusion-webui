"""Unit tests for the shared init-image pre-resize helpers (modules/input_resize.py)."""

from PIL import Image

from modules import input_resize


def _image(width, height, color=(10, 20, 30)):
    return Image.new("RGB", (width, height), color)


def test_round8_snaps_and_clamps():
    assert input_resize.round8(511) == 512
    assert input_resize.round8(512) == 512
    assert input_resize.round8(513) == 512
    assert input_resize.round8(420) == 424
    assert input_resize.round8(1) == 64
    assert input_resize.round8(99999) == 2048


def test_plan_resize_off_and_noop():
    assert input_resize.plan_resize(640, 480, "off") is None
    assert input_resize.plan_resize(640, 480, "") is None
    assert input_resize.plan_resize(640, 480, None) is None
    # a scale of 1.0 and a size equal to the source are no-ops
    assert input_resize.plan_resize(640, 480, "scale", scale=1.0) is None
    assert input_resize.plan_resize(640, 480, "size", width=640, height=480) is None
    # rounding lands back on the same box
    assert input_resize.plan_resize(640, 480, "size", width=641, height=479) is None


def test_plan_resize_scale_keeps_aspect_and_clamps():
    plan = input_resize.plan_resize(832, 1216, "scale", scale=1.5)
    assert (plan["width"], plan["height"]) == (1248, 1824)
    assert plan["fit"] == "fill"
    assert plan["cover"] is False
    assert plan["downscale"] is False

    plan = input_resize.plan_resize(1024, 1024, "Scale", scale=0.5)
    assert (plan["width"], plan["height"]) == (512, 512)
    assert plan["downscale"] is True

    assert input_resize.plan_resize(512, 512, "scale", scale=99)["width"] == 2048
    assert input_resize.plan_resize(512, 512, "scale", scale=0.0001)["width"] == 64


def test_plan_resize_size_fit_modes():
    fill = input_resize.plan_resize(832, 1216, "size", width=1024, height=1024, fit="fill")
    assert (fill["width"], fill["height"]) == (1024, 1024)
    assert fill["fit"] == "fill"
    assert fill["cover"] is True
    assert fill["downscale"] is False  # cover scales by max(1024/832, 1024/1216) = 1.23

    stretch = input_resize.plan_resize(832, 1216, "size", width=1024, height=1024, fit="stretch")
    assert stretch["cover"] is False
    assert stretch["downscale"] is False  # area grows

    # unknown fit falls back to aspect fill
    assert input_resize.plan_resize(512, 512, "size", width=1024, height=1024, fit="bogus")["fit"] == "fill"
    # mode labels from the UI are accepted
    assert input_resize.plan_resize(512, 512, "Size", width=1024, height=1024)["mode"] == "size"


def test_plan_resize_cover_downscale_uses_the_real_scale_factor():
    # 1024x1024 -> 512x512 cover: the real factor is 0.5 -> area filtering
    assert input_resize.plan_resize(1024, 1024, "size", width=512, height=512, fit="fill")["downscale"] is True
    # 1024x1024 -> 1536x512 cover: factor 1.5 -> Lanczos
    assert input_resize.plan_resize(1024, 1024, "size", width=1536, height=512, fit="fill")["downscale"] is False


def test_resize_pair_stretch_matches_the_target_exactly():
    image = _image(640, 480)
    mask = Image.new("L", (640, 480), 0)
    mask.paste(255, (0, 0, 320, 480))

    plan = input_resize.plan_resize(640, 480, "size", width=320, height=320, fit="stretch")
    out, out_mask, detail = input_resize.resize_pair(image, mask, plan)

    assert out.size == (320, 320)
    assert out_mask.size == (320, 320)
    assert "640x480 -> 320x320" in detail and "stretch" in detail
    # the painted half stays the left half
    assert out_mask.getpixel((10, 160)) == 255
    assert out_mask.getpixel((310, 160)) == 0


def test_resize_pair_aspect_fill_center_crops():
    image = Image.new("RGB", (640, 480), (0, 0, 0))
    # mark the middle band so the crop can be checked
    for x in range(640):
        for y in range(180, 300):
            image.putpixel((x, y), (255, 255, 255))

    plan = input_resize.plan_resize(640, 480, "size", width=256, height=256, fit="fill")
    out, _mask, detail = input_resize.resize_pair(image, None, plan)

    assert out.size == (256, 256)
    assert "aspect fill" in detail
    # cover scales 640x480 by 0.533 -> 342x256, then crops horizontally; the white band survives
    assert out.getpixel((128, 128))[0] > 200


def test_resize_pair_scale_and_mask_alignment():
    image = _image(400, 200)
    mask = Image.new("L", (400, 200), 255)

    plan = input_resize.plan_resize(400, 200, "scale", scale=2.0)
    out, out_mask, detail = input_resize.resize_pair(image, mask, plan)

    assert out.size == (800, 400)
    assert out_mask.size == (800, 400)
    assert "800x400" in detail and "lanczos" in detail
    assert out_mask.getpixel((799, 399)) == 255


def test_resize_pair_without_plan_or_image_is_passthrough():
    image = _image(64, 64)
    assert input_resize.resize_pair(image, None, None) == (image, None, None)
    assert input_resize.resize_pair(None, None, {"width": 8, "height": 8, "mode": "size", "fit": "fill", "cover": True, "downscale": True})[0] is None


def test_scaled_size_snaps_to_the_grid_and_clamps():
    assert input_resize.scaled_size(512, 512, 2) == (1024, 1024)
    assert input_resize.scaled_size(512, 768, 1.5) == (768, 1152)
    # clamped like every other size in the UI (64 - 2048, multiples of 8)
    assert input_resize.scaled_size(512, 512, 0.05) == (64, 64)
    assert input_resize.scaled_size(1024, 1024, 4) == (2048, 2048)


def test_working_size_scales_the_resized_input():
    # "Resize Input" 512x768 -> 512x512 (aspect fill), then "Resize by" x2 -> 1024x1024
    plan = input_resize.plan_resize(512, 768, "size", width=512, height=512, fit="fill")
    assert input_resize.working_size(plan, scale_by=2.0) == (1024, 1024)
    # the scale wins over "set output size to the resized input"
    assert input_resize.working_size(plan, set_output=True, scale_by=2.0) == (1024, 1024)
    # without a factor only the explicit "set output size" applies
    assert input_resize.working_size(plan, set_output=True) == (512, 512)
    assert input_resize.working_size(plan, set_output=False) is None
    assert input_resize.working_size(None, set_output=True, scale_by=2.0) is None
