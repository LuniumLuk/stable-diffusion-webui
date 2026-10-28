"""Unit tests for the Anima LoRA plumbing (modules/backends/anima.py, modules/model_registry.py)."""

import os
import socket

import pytest

from modules import model_registry
from modules.backends import anima, sdcpp_server
from modules.backends.sdcpp_server import SdcppServer


def _resolve_known(known):
    return lambda name: known.get(name.strip().lower())


def test_extract_loras_without_tags_is_a_noop():
    prompt = "masterpiece, a cat"
    assert anima.extract_loras(prompt, _resolve_known({})) == (prompt, [], [])


def test_extract_loras_keeps_text_and_returns_entries():
    prompt = "masterpiece, <lora:rda-3:0.8> a cat, <lora:style:> detailed"
    cleaned, loras, missing = anima.extract_loras(prompt, _resolve_known({"rda-3": "rda-3.safetensors", "style": "style.safetensors"}))

    assert cleaned == "masterpiece,  a cat,  detailed"
    assert loras == [
        {"path": "rda-3.safetensors", "multiplier": 0.8, "is_high_noise": False},
        {"path": "style.safetensors", "multiplier": 1.0, "is_high_noise": False},
    ]
    assert missing == []


def test_extract_loras_reports_unknown_names_and_drops_the_tags():
    cleaned, loras, missing = anima.extract_loras("<lora:missing:1> keep", _resolve_known({}))

    assert cleaned == "keep"
    assert loras == []
    assert missing == ["missing"]


def test_extract_loras_accepts_a1111_extra_multipliers():
    _, loras, _ = anima.extract_loras("<lora:rda-3:0.9:0.6>", _resolve_known({"rda-3": "rda-3.safetensors"}))

    assert loras == [{"path": "rda-3.safetensors", "multiplier": 0.9, "is_high_noise": False}]


def test_extract_loras_tag_without_weight():
    _, loras, _ = anima.extract_loras("<lora:rda-3>", _resolve_known({"rda-3": "rda-3.safetensors"}))

    assert loras == [{"path": "rda-3.safetensors", "multiplier": 1.0, "is_high_noise": False}]


def test_extract_loras_ignores_non_lora_angle_brackets():
    prompt = "a <tag> and <loraish:x:1> cat"
    assert anima.extract_loras(prompt, _resolve_known({})) == (prompt, [], [])


def test_build_payload_carries_the_lora_entries():
    loras = [{"path": "rda-3.safetensors", "multiplier": 0.7, "is_high_noise": False}]
    payload = anima.build_payload(
        prompt="a cat", negative_prompt="", width=512, height=512, steps=8,
        cfg_scale=4.5, sampler_name="Euler a", seed=1, loras=loras,
    )

    assert payload["lora"] == loras
    assert payload["prompt"] == "a cat"


def test_build_payload_omits_the_lora_key_without_loras():
    payload = anima.build_payload(
        prompt="a cat", negative_prompt="", width=512, height=512, steps=8,
        cfg_scale=4.5, sampler_name="Euler a", seed=1,
    )

    assert "lora" not in payload


def test_sidecar_points_at_the_anima_lora_folder():
    args = SdcppServer._args("model.safetensors", "te.gguf", "vae.safetensors", 7866)

    assert "--lora-model-dir" in args
    assert args[args.index("--lora-model-dir") + 1] == model_registry.lora_dir()


def _listening_socket():
    listener = socket.socket()
    listener.bind(("127.0.0.1", 0))
    listener.listen(1)
    return listener


def test_port_is_taken_detects_a_listener():
    listener = _listening_socket()
    try:
        assert sdcpp_server.port_is_taken(listener.getsockname()[1]) is True
    finally:
        listener.close()


def test_port_is_taken_on_a_free_port():
    probe = socket.socket()
    probe.bind(("127.0.0.1", 0))
    port = probe.getsockname()[1]
    probe.close()

    assert sdcpp_server.port_is_taken(port) is False


def test_ensure_running_refuses_a_port_held_by_a_stale_sidecar(tmp_path, monkeypatch):
    listener = _listening_socket()
    monkeypatch.setattr(sdcpp_server, "get_port", lambda: listener.getsockname()[1])
    model = tmp_path / "model.safetensors"
    text_encoder = tmp_path / "te.gguf"
    vae = tmp_path / "vae.safetensors"
    for path in (model, text_encoder, vae):
        path.write_bytes(b"")

    try:
        with pytest.raises(sdcpp_server.SdcppError) as error:
            sdcpp_server.SdcppServer().ensure_running(str(model), str(text_encoder), str(vae))
    finally:
        listener.close()

    assert "already used by another stable-diffusion.cpp instance" in str(error.value)


def test_find_lora_matches_tag_names(tmp_path, monkeypatch):
    monkeypatch.setattr(model_registry, "ANIMA_DIR", str(tmp_path))
    loras = tmp_path / "loras"
    loras.mkdir()
    (loras / "rda-3.safetensors").write_bytes(b"")
    (loras / "style.v2.pt").write_bytes(b"")
    (loras / "notes.txt").write_text("ignored")
    model_registry.invalidate_cache()

    try:
        assert model_registry.list_loras() == ["rda-3.safetensors", "style.v2.pt"]
        assert model_registry.find_lora("rda-3") == "rda-3.safetensors"
        assert model_registry.find_lora("RDA-3.safetensors") == "rda-3.safetensors"
        assert model_registry.find_lora("style.v2") == "style.v2.pt"
        assert model_registry.find_lora(" rda-3 ") == "rda-3.safetensors"
        assert model_registry.find_lora("rda") is None
        assert model_registry.find_lora("") is None
        assert model_registry.find_lora(None) is None
    finally:
        model_registry.invalidate_cache()


def test_lora_dir_is_inside_the_anima_folder():
    assert os.path.basename(model_registry.lora_dir()) == "loras"
    assert os.path.dirname(model_registry.lora_dir()) == model_registry.ANIMA_DIR
