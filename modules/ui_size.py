"""Width/height number inputs and the shared resolution presets.

Every image-size control in the UI uses the same pair of plain number inputs plus
one compact row of preset buttons, so the list below is the single source of
truth for the presets.
"""

import gradio as gr

from modules.ui_components import FormRow

# Frequently used resolutions, in display order.
SIZE_PRESETS = (
    (512, 512),
    (512, 768),
    (768, 512),
    (832, 1216),
    (1024, 1024),
    (1216, 832),
)


def size_input(value=512, *, elem_id=None, label="Width", minimum=64, maximum=2048, step=8):
    return gr.Number(
        value=value,
        label=label,
        precision=0,
        minimum=minimum,
        maximum=maximum,
        step=step,
        elem_id=elem_id,
    )


def apply_size_preset(width, height):
    return gr.update(value=width), gr.update(value=height)


def size_preset_row(width, height, *, elem_id=None, elem_prefix=None, presets=SIZE_PRESETS, form_row=True):
    """Row of preset buttons that writes both size inputs."""
    row_class = FormRow if form_row else gr.Row
    with row_class(elem_id=elem_id, elem_classes=["size-preset-row"]) as row:
        for preset_width, preset_height in presets:
            button = gr.Button(
                f"{preset_width}\u00D7{preset_height}",
                size="sm",
                elem_id=f"{elem_prefix}_{preset_width}x{preset_height}" if elem_prefix else None,
            )
            button.click(
                fn=(lambda w=preset_width, h=preset_height: apply_size_preset(w, h)),
                inputs=None,
                outputs=[width, height],
                show_progress=False,
            )

    return row
