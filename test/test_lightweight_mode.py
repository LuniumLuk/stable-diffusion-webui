"""Unit tests for lightweight mode: no checkpoint loading, generation refused."""

import types

import pytest

from modules import lightweight_mode, shared


@pytest.fixture(scope="module", autouse=True)
def app_initialized():
    """Options must exist before sd_models (via sd_samplers) can be imported."""
    if shared.opts is None:
        from modules import shared_init

        shared_init.initialize()


@pytest.fixture(scope="module")
def sd_models(app_initialized):
    from modules import sd_models as module

    return module


@pytest.fixture
def fake_opts(monkeypatch, sd_models):
    # sd_models must be imported before the real Options object is swapped for a stub:
    # its import chain reads shared.opts (sd_samplers.set_samplers).
    options = types.SimpleNamespace(lightweight_mode=False)
    monkeypatch.setattr(shared, "opts", options, raising=False)
    return options


def test_enabled_follows_the_option(fake_opts):
    assert lightweight_mode.enabled() is False
    fake_opts.lightweight_mode = True
    assert lightweight_mode.enabled() is True


def test_require_blocks_only_while_enabled(fake_opts):
    lightweight_mode.require()

    fake_opts.lightweight_mode = True
    with pytest.raises(lightweight_mode.LightweightModeBlocked):
        lightweight_mode.require()


def test_option_is_registered_in_the_system_section():
    from modules import shared_options

    info = shared_options.options_templates["lightweight_mode"]
    assert info.default is False
    assert info.section[0] == "system"


def test_option_change_is_wired_to_the_unload_path():
    from modules import shared_options

    info = shared_options.options_templates["lightweight_mode"]
    assert info.onchange is shared_options.lightweight_mode_changed


def test_generation_entry_points_refuse_while_enabled(fake_opts):
    from modules import deepbooru, postprocessing, processing, video_manager

    fake_opts.lightweight_mode = True

    with pytest.raises(lightweight_mode.LightweightModeBlocked):
        processing.process_images(None)
    with pytest.raises(lightweight_mode.LightweightModeBlocked):
        postprocessing.run_postprocessing(0, None, "", "", "", True)
    with pytest.raises(lightweight_mode.LightweightModeBlocked):
        video_manager.generate(None)
    with pytest.raises(lightweight_mode.LightweightModeBlocked):
        deepbooru.model.tag(None)


def test_checkpoint_is_not_loaded_while_enabled(fake_opts, sd_models, monkeypatch):
    monkeypatch.setattr(sd_models.model_data, "sd_model", None, raising=False)
    monkeypatch.setattr(sd_models.model_data, "was_loaded_at_least_once", False, raising=False)

    fake_opts.lightweight_mode = True

    assert sd_models.model_data.get_sd_model() is None
    assert sd_models.model_data.sd_model is None
    assert sd_models.load_model() is None


def test_deactivate_allows_the_next_load(fake_opts, sd_models, monkeypatch):
    monkeypatch.setattr(sd_models.model_data, "was_loaded_at_least_once", True, raising=False)

    fake_opts.lightweight_mode = False
    lightweight_mode.deactivate()

    assert sd_models.model_data.was_loaded_at_least_once is False


def test_activate_drops_every_checkpoint_reference(fake_opts, sd_models, monkeypatch):
    from modules import sd_hijack, sd_unet, sd_vae, vram

    model = object()
    monkeypatch.setattr(sd_models.model_data, "sd_model", model, raising=False)
    monkeypatch.setattr(sd_models.model_data, "loaded_sd_models", [model], raising=False)
    monkeypatch.setattr(sd_models.model_data, "was_loaded_at_least_once", True, raising=False)
    monkeypatch.setattr(sd_models, "send_model_to_cpu", lambda m=None: None)
    monkeypatch.setattr(sd_hijack.model_hijack, "undo_hijack", lambda m: None)
    monkeypatch.setattr(sd_unet, "current_unet", None, raising=False)
    monkeypatch.setattr(sd_vae, "checkpoints_loaded", {"cached": object()}, raising=False)
    monkeypatch.setattr(vram, "release_all", lambda reason=None: [])

    fake_opts.lightweight_mode = True
    lightweight_mode.activate()

    assert sd_models.model_data.sd_model is None
    assert sd_models.model_data.loaded_sd_models == []
    assert sd_models.model_data.was_loaded_at_least_once is False
    assert sd_vae.checkpoints_loaded == {}
