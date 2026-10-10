"""Gallery v2 tab: advanced filter / search / sort UI over gallery.db.

The heavy lifting lives in modules/gallery_api.py (HTTP endpoints) and
javascript/galleryV2.js (front-end). This script only mounts the container,
starts the lifecycle sweeper, and exposes the rollback option.
"""

from modules import script_callbacks, gallery_db, gallery_lifecycle

_TAB_NAME = "gallery_v2_tab"
_STARTUP_NAME = "gallery_v2_startup"


def on_ui_tabs():
    import gradio as gr

    with gr.Blocks(analytics_enabled=False) as tab:
        gr.HTML(
            value='<div id="gallery-v2-root" class="gv2-root">'
                  '<div class="gv2-loading">Loading Gallery v2\u2026</div>'
                  "</div>"
        )
    return [(tab, "Gallery v2", "gallery_v2_tab")]


def on_app_started(demo, app):
    try:
        gallery_db.init_db()
    except Exception as exc:
        print(f"[gallery-v2] init failed: {exc}")
        return
    try:
        gallery_lifecycle.start_sweeper()
    except Exception as exc:
        print(f"[gallery-v2] sweeper failed to start: {exc}")


def register_callbacks():
    # rollback switch (Settings > Gallery v2). Defaults to enabled.
    try:
        from modules import shared
        if "gallery_v2" not in shared.opts.data:
            shared.opts.add_option(
                "gallery_v2",
                shared.OptionInfo(
                    True,
                    "Gallery v2 (new gallery.db store, blob media, lifecycle sweeper)",
                    section=("gallery-v2", "Gallery v2"),
                ),
            )
    except Exception as exc:
        print(f"[gallery-v2] options registration skipped: {exc}")

    for registry, name, callback in (
        ("callbacks_ui_tabs", _TAB_NAME, on_ui_tabs),
        ("callbacks_app_started", _STARTUP_NAME, on_app_started),
    ):
        existing = script_callbacks.callback_map.get(registry, [])
        existing[:] = [cb for cb in existing if name not in getattr(cb, "name", "")]
        if registry == "callbacks_ui_tabs":
            script_callbacks.on_ui_tabs(callback, name=name)
        else:
            script_callbacks.on_app_started(callback, name=name)


register_callbacks()
