"""Unit tests for the mask geometry helpers used by the inpaint "By mask" resize tab."""

from PIL import Image, ImageDraw

from modules import masking


def _mask(size, box=None):
    mask = Image.new("L", size, 0)
    if box:
        ImageDraw.Draw(mask).rectangle(box, fill=255)
    return mask


def test_union_crop_region_single_mask():
    assert masking.mask_union_crop_region([_mask((512, 512), (100, 60, 299, 209))]) == (100, 60, 300, 210)


def test_union_crop_region_merges_layers():
    masks = [_mask((512, 512), (50, 50, 149, 99)), _mask((512, 512), (300, 300, 399, 349))]
    assert masking.mask_union_crop_region(masks) == (50, 50, 400, 350)


def test_union_crop_region_skips_empty_and_none():
    masks = [None, _mask((512, 512)), _mask((512, 512), (10, 20, 29, 39))]
    assert masking.mask_union_crop_region(masks) == (10, 20, 30, 40)


def test_union_crop_region_without_content_is_none():
    assert masking.mask_union_crop_region([None, _mask((64, 64))]) is None
    assert masking.mask_union_crop_region([]) is None


def test_union_crop_region_invert_measures_complement():
    # painting a box in the middle means "Inpaint not masked" covers the whole picture
    assert masking.mask_union_crop_region([_mask((128, 96), (32, 24, 95, 71))], invert=True) == (0, 0, 128, 96)


def test_union_crop_region_accepts_rgb_masks():
    rgb = Image.new("RGB", (64, 64), 0)
    ImageDraw.Draw(rgb).rectangle((8, 8, 23, 23), fill=255)
    assert masking.mask_union_crop_region([rgb]) == (8, 8, 24, 24)
