"""Unit tests for the Video tab model catalog / request normalisation."""

import os

import pytest

from modules import video_manager


def test_unknown_engine_is_rejected():
    with pytest.raises(video_manager.VideoError):
        video_manager.parse_request({"engine": "sora", "prompt": "x"})


def test_animatediff_frames_round_to_a_multiple_of_four():
    req = video_manager.parse_request({"engine": "animatediff", "prompt": "x", "frames": 13})
    assert req.frames == 12
    req = video_manager.parse_request({"engine": "animatediff", "prompt": "x", "frames": 16})
    assert req.frames == 16
    req = video_manager.parse_request({"engine": "animatediff", "prompt": "x", "frames": 99})
    assert req.frames == 32


def test_animatediff_sizes_are_vae_friendly():
    req = video_manager.parse_request({"engine": "animatediff", "prompt": "x", "width": 500, "height": 513})
    assert req.width % 8 == 0 and req.height % 8 == 0


def test_cogvideox_uses_4k_plus_1_frames():
    req = video_manager.parse_request({"engine": "cogvideox", "prompt": "x", "frames": 16})
    assert req.frames == 13
    req = video_manager.parse_request({"engine": "cogvideox", "prompt": "x", "frames": 49})
    assert req.frames == 49


def test_cogvideox_defaults_are_480p():
    req = video_manager.parse_request({"engine": "cogvideox", "prompt": "x"})
    assert (req.width, req.height) == (720, 480)
    assert req.steps == 50


def test_svd_requires_an_init_image():
    with pytest.raises(video_manager.VideoError):
        video_manager.parse_request({"engine": "svd"})


def test_svd_keeps_the_closest_trained_orientation():
    req = video_manager.parse_request({"engine": "svd", "init_image": "x.png", "width": 600, "height": 900})
    assert (req.width, req.height) == (576, 1024)
    req = video_manager.parse_request({"engine": "svd", "init_image": "x.png", "width": 1200, "height": 700})
    assert (req.width, req.height) == (1024, 576)


def test_svd_frame_buckets():
    assert video_manager.parse_request({"engine": "svd", "init_image": "x.png", "frames": 10}).frames == 14
    assert video_manager.parse_request({"engine": "svd", "init_image": "x.png", "frames": 25}).frames == 25


def test_svd_prompt_guidance_defaults_and_clamps():
    req = video_manager.parse_request({"engine": "svd", "init_image": "x.png", "prompt": "rain"})
    assert req.refine == 0.25
    assert video_manager.parse_request({"engine": "svd", "init_image": "x.png", "prompt": "rain", "refine": 0.6}).refine == 0.6
    assert video_manager.parse_request({"engine": "svd", "init_image": "x.png", "prompt": "rain", "refine": 5}).refine == 0.9
    assert video_manager.parse_request({"engine": "svd", "init_image": "x.png", "prompt": "rain", "refine": -1}).refine == 0.0


def test_svd_without_prompt_never_refines():
    req = video_manager.parse_request({"engine": "svd", "init_image": "x.png", "refine": 0.5})
    assert req.refine == 0.0


def test_ltx_uses_8k_plus_1_frames():
    assert video_manager.parse_request({"engine": "ltx", "prompt": "x", "frames": 16}).frames == 9
    assert video_manager.parse_request({"engine": "ltx", "prompt": "x", "frames": 25}).frames == 25
    assert video_manager.parse_request({"engine": "ltx", "prompt": "x", "frames": 49}).frames == 49
    assert video_manager.parse_request({"engine": "ltx", "prompt": "x", "frames": 99}).frames == 49


def test_ltx_sizes_are_multiples_of_32():
    req = video_manager.parse_request({"engine": "ltx", "prompt": "x", "width": 500, "height": 770})
    assert req.width % 32 == 0 and req.height % 32 == 0
    assert (req.width, req.height) == (512, 768)


def test_ltx_defaults_and_optional_init_image():
    req = video_manager.parse_request({"engine": "ltx", "prompt": "x"})
    assert req.init_image == ""
    assert req.steps == 50 and req.guidance == 3.0
    req = video_manager.parse_request({"engine": "ltx", "prompt": "x", "init_image": "x.png"})
    assert req.init_image == "x.png"


def test_ltx_engine_only_encodes_the_mode_it_was_loaded_for():
    t2v = video_manager.parse_request({"engine": "ltx", "prompt": "x"})
    i2v = video_manager.parse_request({"engine": "ltx", "prompt": "x", "init_image": "x.png"})
    assert t2v.cache_key() != i2v.cache_key()


def test_clamping_keeps_values_in_range():
    req = video_manager.parse_request({
        "engine": "animatediff",
        "prompt": "x",
        "steps": 999,
        "guidance": 99,
        "fps": 0,
        "seed": -5,
        "offload": "sometimes",
    })
    assert req.steps == 100
    assert req.guidance == 20.0
    assert req.fps == 1
    assert req.seed == -1
    assert req.offload == "auto"


def test_status_lists_every_engine_and_base():
    info = video_manager.status()
    assert [engine["id"] for engine in info["engines"]] == list(video_manager.ENGINE_IDS)
    assert all("installed" in engine for engine in info["engines"])
    assert isinstance(info["bases"], list)
    assert isinstance(info["lightning"], list)
    for engine_id, defaults in info["defaults"].items():
        assert defaults["frames"] >= 8, engine_id


def test_install_hint_mentions_the_download_script():
    for engine in video_manager.ENGINE_IDS:
        assert "download_video_models.py" in video_manager.install_hint(engine)


def test_lightning_choice_names_are_stable():
    choices = video_manager.lightning_choices()
    assert "none" not in choices
    assert all(choice.endswith("step") for choice in choices)


def test_default_base_is_a_diffusers_folder_or_empty():
    base = video_manager.default_base()
    assert base == "" or os.path.isfile(os.path.join(base, "model_index.json"))


def test_svd_default_motion_bucket_keeps_the_subject_together():
    # 127 is the diffusers default and shreds anime faces within 25 frames
    req = video_manager.parse_request({"engine": "svd", "init_image": "x.png"})
    assert req.motion_bucket_id == video_manager.SVD_MOTION_BUCKET == 60


def test_ltx_samples_at_the_trained_frame_rate(monkeypatch):
    # frame_rate feeds the transformer's temporal RoPE scale: it must stay at the
    # training rate, otherwise short/low fps values collapse the motion into a still.
    captured = {}

    class FakePipe:
        def __call__(self, **kwargs):
            captured.update(kwargs)

            class _Out:
                def __init__(self):
                    self.frames = [[object()]]

            return _Out()

    engine = video_manager.LtxEngine()
    engine.pipe = FakePipe()
    monkeypatch.setattr(video_manager, "torch_generator", lambda seed: None)

    req = video_manager.parse_request({"engine": "ltx", "prompt": "x", "frames": 25, "fps": 10})
    engine.generate(req, lambda *args, **kwargs: None, lambda: False)

    assert captured["frame_rate"] == video_manager.LTX_FRAME_RATE == 25
    assert captured["num_frames"] == req.frames
