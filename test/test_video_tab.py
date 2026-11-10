"""Regression tests for the Video tab's gradio wiring.

The app is launched with ``--no-gradio-queue``, which makes gradio reject
generator callbacks ("Need to enable queue to use generators"), and Button
updates only accept ``value`` - not ``label``.  Both used to break generation.
"""

import importlib.util
import inspect
import os

import gradio as gr
import pytest

from modules import video_manager

SCRIPT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "scripts", "video_tab.py")


@pytest.fixture(scope="module")
def video_tab():
    spec = importlib.util.spec_from_file_location("video_tab_under_test", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_generate_handler_is_not_a_generator(video_tab):
    # gradio raises ValueError for generator callbacks when the queue is disabled
    assert not inspect.isgeneratorfunction(video_tab._run)


def test_preset_updates_only_use_button_keywords(video_tab):
    allowed = set(inspect.signature(gr.Button.update).parameters)
    for engine, visible in (("animatediff", 4), ("cogvideox", 3), ("svd", 2), ("ltx", 4)):
        updates, engine_id = video_tab._preset_updates(engine, 4)
        assert engine_id == engine
        assert len(updates) == 4
        for update in updates:
            assert set(update) - {"__type__"} <= allowed
        assert [update.get("visible") for update in updates] == [True] * visible + [False] * (4 - visible)


def test_preset_captions_follow_the_engine(video_tab):
    updates, _ = video_tab._preset_updates("svd", 2)
    assert [update["value"] for update in updates] == [label for label, _w, _h in video_tab.SIZES["svd"]]


def test_failed_start_still_returns_every_output(video_tab):
    # SVD without an init image is rejected by parse_request - the handler must
    # still answer with the five outputs the generate event declares.
    args = (
        video_manager.ENGINE_INFO["svd"]["title"], "", "", "", "", None,
        1024, 576, 14, 8, 25, 3.0, -1, True, "auto", 0.25, 127, 0.02, False, True,
    )
    result = video_tab._run(*args)

    assert len(result) == 5
    assert "Cannot start" in result[2]
    # gradio's Video component treats "" as a file path and raises FileNotFoundError
    assert result[1] is None


def test_result_view_uses_none_instead_of_an_empty_video_path(video_tab):
    _preview, mp4, summary = video_tab._result_view({"ok": False, "error": "an init image is required"})
    assert mp4 is None
    assert "an init image is required" in summary

    _preview, mp4, summary = video_tab._result_view({
        "ok": True,
        "gif": os.path.join("outputs", "video", "clip.gif"),
        "info": {"frames": 16, "width": 512, "height": 512, "fps": 8, "seed": 1, "seconds": 2.5},
    })
    assert mp4 is None
    assert "GIF only" in summary


def test_video_component_accepts_the_handler_values():
    component = gr.Video(interactive=False)
    assert component.postprocess(None) is None
