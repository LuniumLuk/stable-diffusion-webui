"""Unit tests for the LoRA thumbnail late-fill (modules/lora_previews.py)."""

from PIL import Image

from modules import lora_previews


def make_image(path, size=(900, 700)):
    path.parent.mkdir(parents=True, exist_ok=True)
    Image.new("RGB", size, (120, 40, 200)).save(path)
    return path


def test_preview_path_sits_next_to_the_lora(tmp_path):
    assert lora_previews.preview_path(str(tmp_path / "genshin-000008.safetensors")) == str(tmp_path / "genshin-000008.preview.png")


def test_dataset_dirs_from_metadata_accepts_json_and_dict():
    assert lora_previews.metadata_dataset_dirs({"ss_dataset_dirs": '{"3_lora_mika_v2": {"n_repeats": 3}}'}) == ["3_lora_mika_v2"]
    assert lora_previews.metadata_dataset_dirs({"ss_dataset_dirs": {"10_flat": {}}}) == ["10_flat"]
    assert lora_previews.metadata_dataset_dirs({"ss_dataset_dirs": "not json"}) == []
    assert lora_previews.metadata_dataset_dirs({}) == []


def test_output_folder_with_images_is_used(tmp_path, monkeypatch):
    root = tmp_path / "train_data"
    make_image(root / "genshin" / "a.png")
    make_image(root / "genshin" / "b.png")
    monkeypatch.setattr(lora_previews, "training_roots", lambda: [str(root)])

    dataset = lora_previews.choose_dataset_dir("genshin", ["3_lora_mika_v2"])
    assert dataset == str(root / "genshin")


def test_exact_dataset_dir_wins_over_subfolders(tmp_path, monkeypatch):
    root = tmp_path / "train_data"
    make_image(root / "mychar" / "10_face" / "x.png")
    make_image(root / "mychar" / "20_body" / "y.png")
    monkeypatch.setattr(lora_previews, "training_roots", lambda: [str(root)])

    assert lora_previews.choose_dataset_dir("mychar", ["20_body"]) == str(root / "mychar" / "20_body")


def test_legacy_training_data_folder_is_a_fallback(tmp_path, monkeypatch):
    root = tmp_path / "train_data"
    legacy = tmp_path / "training_data"
    make_image(legacy / "lora_kiwi" / "1.png")
    (root).mkdir()
    monkeypatch.setattr(lora_previews, "training_roots", lambda: [str(root), str(legacy)])

    assert lora_previews.choose_dataset_dir("kiwi", []) == str(legacy / "lora_kiwi")


def test_dataset_folder_name_match_is_the_last_resort(tmp_path, monkeypatch):
    root = tmp_path / "train_data"
    make_image(root / "bak" / "10_kocchi" / "1.png")
    monkeypatch.setattr(lora_previews, "training_roots", lambda: [str(root)])

    assert lora_previews.choose_dataset_dir("kocchi", ["10_kocchi"]) == str(root / "bak" / "10_kocchi")


def test_no_dataset_means_no_preview(tmp_path, monkeypatch):
    root = tmp_path / "train_data"
    root.mkdir()
    monkeypatch.setattr(lora_previews, "training_roots", lambda: [str(root)])

    assert lora_previews.choose_dataset_dir("missing", ["10_missing"]) is None


def test_ensure_preview_creates_a_resized_png(tmp_path, monkeypatch):
    root = tmp_path / "train_data"
    make_image(root / "genshin" / "first.png", size=(1600, 1200))
    monkeypatch.setattr(lora_previews, "training_roots", lambda: [str(root)])

    lora = tmp_path / "models" / "genshin.safetensors"
    lora.parent.mkdir()
    lora.write_bytes(b"not a real checkpoint")

    created = lora_previews.ensure_preview(str(lora), {"ss_output_name": "genshin", "ss_dataset_dirs": '{"3_lora_mika_v2": {}}'})

    assert created == str(tmp_path / "models" / "genshin.preview.png")
    with Image.open(created) as image:
        assert image.format == "PNG"
        assert max(image.size) == lora_previews.PREVIEW_SIZE


def test_ensure_preview_prefers_the_first_dataset_image(tmp_path, monkeypatch):
    root = tmp_path / "train_data"
    make_image(root / "set" / "b.png", size=(64, 64))
    make_image(root / "set" / "a.png", size=(80, 80))
    monkeypatch.setattr(lora_previews, "training_roots", lambda: [str(root)])

    lora = tmp_path / "set.safetensors"
    lora.write_bytes(b"x")

    lora_previews.ensure_preview(str(lora), {"ss_output_name": "set"})

    with Image.open(lora_previews.preview_path(str(lora))) as image:
        assert image.size == (80, 80)


def test_ensure_preview_is_a_noop_when_the_thumbnail_exists(tmp_path, monkeypatch):
    root = tmp_path / "train_data"
    make_image(root / "kept" / "a.png")
    monkeypatch.setattr(lora_previews, "training_roots", lambda: [str(root)])

    lora = tmp_path / "kept.safetensors"
    lora.write_bytes(b"x")
    existing = lora_previews.preview_path(str(lora))
    make_image(tmp_path / "kept.preview.png", size=(10, 10))

    assert lora_previews.ensure_preview(str(lora), {"ss_output_name": "kept"}) == existing
    with Image.open(existing) as image:
        assert image.size == (10, 10)
