import csv
import dataclasses
import json
import html
import os
from contextlib import nullcontext

import gradio as gr

from modules import call_queue, shared, ui_tempdir, util
from modules.infotext_utils import image_from_url_text
import modules.images
from modules.ui_components import ToolButton
import modules.infotext_utils as parameters_copypaste

folder_symbol = '\U0001f4c2'  # 📂
refresh_symbol = '\U0001f504'  # 🔄


def update_generation_info(generation_info, html_info, img_index):
    try:
        generation_info = json.loads(generation_info)
        if img_index < 0 or img_index >= len(generation_info["infotexts"]):
            return html_info, gr.update()
        return plaintext_to_html(generation_info["infotexts"][img_index]), gr.update()
    except Exception:
        pass
    # if the json parse or anything else fails, just return the old html_info
    return html_info, gr.update()


def plaintext_to_html(text, classname=None):
    content = "<br>\n".join(html.escape(x) for x in text.split('\n'))

    return f"<p class='{classname}'>{content}</p>" if classname else f"<p>{content}</p>"


def update_logfile(logfile_path, fields):
    """Update a logfile from old format to new format to maintain CSV integrity."""
    with open(logfile_path, "r", encoding="utf8", newline="") as file:
        reader = csv.reader(file)
        rows = list(reader)

    # blank file: leave it as is
    if not rows:
        return

    # file is already synced, do nothing
    if len(rows[0]) == len(fields):
        return

    rows[0] = fields

    # append new fields to each row as empty values
    for row in rows[1:]:
        while len(row) < len(fields):
            row.append("")

    with open(logfile_path, "w", encoding="utf8", newline="") as file:
        writer = csv.writer(file)
        writer.writerows(rows)


def save_files(js_data, images, do_make_zip, index):
    filenames = []
    fullfns = []
    parsed_infotexts = []

    # quick dictionary to class object conversion. Its necessary due apply_filename_pattern requiring it
    class MyObject:
        def __init__(self, d=None):
            if d is not None:
                for key, value in d.items():
                    setattr(self, key, value)

    data = json.loads(js_data)
    p = MyObject(data)

    path = shared.opts.outdir_save
    save_to_dirs = shared.opts.use_save_to_dirs_for_ui
    extension: str = shared.opts.samples_format
    start_index = 0

    if index > -1 and shared.opts.save_selected_only and (index >= data["index_of_first_image"]):  # ensures we are looking at a specific non-grid picture, and we have save_selected_only
        images = [images[index]]
        start_index = index

    os.makedirs(shared.opts.outdir_save, exist_ok=True)

    fields = [
        "prompt",
        "seed",
        "width",
        "height",
        "sampler",
        "cfgs",
        "steps",
        "filename",
        "negative_prompt",
        "sd_model_name",
        "sd_model_hash",
    ]
    logfile_path = os.path.join(shared.opts.outdir_save, "log.csv")

    # NOTE: ensure csv integrity when fields are added by
    # updating headers and padding with delimiters where needed
    if shared.opts.save_write_log_csv and os.path.exists(logfile_path):
        update_logfile(logfile_path, fields)

    with (open(logfile_path, "a", encoding="utf8", newline='') if shared.opts.save_write_log_csv else nullcontext()) as file:
        if file:
            at_start = file.tell() == 0
            writer = csv.writer(file)
            if at_start:
                writer.writerow(fields)

        for image_index, filedata in enumerate(images, start_index):
            image = image_from_url_text(filedata)

            is_grid = image_index < p.index_of_first_image

            p.batch_index = image_index-1

            parameters = parameters_copypaste.parse_generation_parameters(data["infotexts"][image_index], [])
            parsed_infotexts.append(parameters)
            fullfn, txt_fullfn = modules.images.save_image(image, path, "", seed=parameters['Seed'], prompt=parameters['Prompt'], extension=extension, info=p.infotexts[image_index], grid=is_grid, p=p, save_to_dirs=save_to_dirs)

            filename = os.path.relpath(fullfn, path)
            filenames.append(filename)
            fullfns.append(fullfn)
            if txt_fullfn:
                filenames.append(os.path.basename(txt_fullfn))
                fullfns.append(txt_fullfn)

        if file:
            writer.writerow([parsed_infotexts[0]['Prompt'], parsed_infotexts[0]['Seed'], data["width"], data["height"], data["sampler_name"], data["cfg_scale"], data["steps"], filenames[0], parsed_infotexts[0]['Negative prompt'], data["sd_model_name"], data["sd_model_hash"]])

    # Make Zip
    if do_make_zip:
        p.all_seeds = [parameters['Seed'] for parameters in parsed_infotexts]
        namegen = modules.images.FilenameGenerator(p, parsed_infotexts[0]['Seed'], parsed_infotexts[0]['Prompt'], image, True)
        zip_filename = namegen.apply(shared.opts.grid_zip_filename_pattern or "[datetime]_[[model_name]]_[seed]-[seed_last]")
        zip_filepath = os.path.join(path, f"{zip_filename}.zip")

        from zipfile import ZipFile
        with ZipFile(zip_filepath, "w") as zip_file:
            for i in range(len(fullfns)):
                with open(fullfns[i], mode="rb") as f:
                    zip_file.writestr(filenames[i], f.read())
        fullfns.insert(0, zip_filepath)

    return gr.File.update(value=fullfns, visible=True), plaintext_to_html(f"Saved: {filenames[0]}")


def endorse_current(js_data, images, index):
    """Star/endorse the currently selected generated image – saves a copy + DB record."""
    import modules.endorsement_db as edb
    from PIL.PngImagePlugin import PngInfo
    from datetime import datetime as _dt

    try:
        data = json.loads(js_data)
    except Exception:
        return plaintext_to_html("Endorse failed: could not parse generation info.")

    if not images:
        return plaintext_to_html("No image to endorse.")

    idx = int(index or 0)
    if idx < 0 or idx >= len(images):
        idx = 0

    infotexts = data.get("infotexts", [])
    if not infotexts:
        return plaintext_to_html("No generation info available.")

    infotext_idx = idx if idx < len(infotexts) else 0
    infotext_str = infotexts[infotext_idx]
    params = parameters_copypaste.parse_generation_parameters(infotext_str, [])

    try:
        image = image_from_url_text(images[idx])
    except Exception as e:
        return plaintext_to_html(f"Endorse failed: could not read image: {e}")

    # Save a permanent copy under <outdir_save>/endorsed/
    try:
        endorsed_dir = os.path.join(shared.opts.outdir_save or "outputs/save", "endorsed")
        os.makedirs(endorsed_dir, exist_ok=True)
        ts = _dt.now().strftime("%Y%m%d_%H%M%S")
        seed = params.get("Seed", "unk")
        img_path = os.path.join(endorsed_dir, f"endorsed_{ts}_{seed}.png")
        png_info = PngInfo()
        png_info.add_text("parameters", infotext_str)
        image.save(img_path, pnginfo=png_info)
    except Exception as e:
        return plaintext_to_html(f"Endorse failed: could not save image: {e}")

    try:
        edb.init_db()
        edb.endorse(
            image_path=img_path,
            prompt=params.get("Prompt", ""),
            negative_prompt=params.get("Negative prompt", ""),
            seed=params.get("Seed", ""),
            steps=int(params.get("Steps", 0) or 0),
            sampler=params.get("Sampler", ""),
            cfg_scale=float(params.get("CFG scale", 0) or 0),
            width=int(data.get("width", 0) or 0),
            height=int(data.get("height", 0) or 0),
            model_name=data.get("sd_model_name", ""),
            model_hash=data.get("sd_model_hash", ""),
            infotext=infotext_str,
        )
    except Exception as e:
        return plaintext_to_html(f"Endorse failed (DB): {e}")

    seed_disp = params.get("Seed", "?")
    return plaintext_to_html(f"\u2b50 Endorsed! Seed: {seed_disp}")


@dataclasses.dataclass
class OutputPanel:
    gallery = None
    generation_info = None
    infotext = None
    html_log = None
    button_upscale = None
    button_quick_generate = None


def create_output_panel(tabname, outdir, toprow=None):
    res = OutputPanel()

    def open_folder(f, images=None, index=None):
        if shared.cmd_opts.hide_ui_dir_config:
            return

        try:
            if 'Sub' in shared.opts.open_dir_button_choice:
                image_dir = os.path.split(images[index]["name"].rsplit('?', 1)[0])[0]
                if 'temp' in shared.opts.open_dir_button_choice or not ui_tempdir.is_gradio_temp_path(image_dir):
                    f = image_dir
        except Exception:
            pass

        util.open_folder(f)

    with gr.Column(elem_id=f"{tabname}_results"):
        if toprow:
            toprow.create_inline_toprow_image()

        with gr.Column(variant='panel', elem_id=f"{tabname}_results_panel"):
            if tabname == "txt2img":
                with gr.Row(elem_id="txt2img_quick_generate_row"):
                    res.button_quick_generate = gr.Button("Quick Generate", elem_id="txt2img_quick_generate", variant='secondary')

            with gr.Group(elem_id=f"{tabname}_gallery_container"):
                res.gallery = gr.Gallery(label='Output', show_label=False, elem_id=f"{tabname}_gallery", columns=4, preview=True, height=shared.opts.gallery_height or None)

            with gr.Row(elem_id=f"image_buttons_{tabname}", elem_classes="image-buttons"):
                open_folder_button = ToolButton(folder_symbol, elem_id=f'{tabname}_open_folder', visible=not shared.cmd_opts.hide_ui_dir_config, tooltip="Open images output directory.")
                compare_button = ToolButton('🔀', elem_id=f'{tabname}_compare', tooltip="Compare two images with a sliding overlay.")

                if tabname != "extras":
                    save = ToolButton('💾', elem_id=f'save_{tabname}', tooltip=f"Save the image to a dedicated directory ({shared.opts.outdir_save}).")
                    save_zip = ToolButton('🗃️', elem_id=f'save_zip_{tabname}', tooltip=f"Save zip archive with images to a dedicated directory ({shared.opts.outdir_save})")
                    endorse_btn = ToolButton('\u2b50', elem_id=f'endorse_{tabname}', tooltip="Endorse this image – save a copy and record it in the starred gallery.")

                buttons = {
                    'img2img': ToolButton('🖼️', elem_id=f'{tabname}_send_to_img2img', tooltip="Send image and generation parameters to img2img tab."),
                    'inpaint': ToolButton('🎨️', elem_id=f'{tabname}_send_to_inpaint', tooltip="Send image and generation parameters to img2img inpaint tab."),
                    'extras': ToolButton('📐', elem_id=f'{tabname}_send_to_extras', tooltip="Send image and generation parameters to extras tab.")
                }

                if tabname == 'txt2img':
                    res.button_upscale = ToolButton('✨', elem_id=f'{tabname}_upscale', tooltip="Create an upscaled version of the current image using hires fix settings.")

            open_folder_button.click(
                fn=lambda images, index: open_folder(shared.opts.outdir_samples or outdir, images, index),
                _js="(y, w) => [y, selected_gallery_index()]",
                inputs=[
                    res.gallery,
                    open_folder_button,  # placeholder for index
                ],
                outputs=[],
            )

            compare_button.click(
                fn=lambda: None,
                _js=f"(x) => [window.launchImageCompare(x, selected_gallery_index()), null]",
                inputs=[res.gallery],
                outputs=[],
                show_progress=False,
            )

            if tabname != "extras":
                download_files = gr.File(None, file_count="multiple", interactive=False, show_label=False, visible=False, elem_id=f'download_files_{tabname}')

                with gr.Group():
                    res.infotext = gr.HTML(elem_id=f'html_info_{tabname}', elem_classes="infotext")
                    res.html_log = gr.HTML(elem_id=f'html_log_{tabname}', elem_classes="html-log")

                    res.generation_info = gr.Textbox(visible=False, elem_id=f'generation_info_{tabname}')
                    if tabname == 'txt2img' or tabname == 'img2img':
                        generation_info_button = gr.Button(visible=False, elem_id=f"{tabname}_generation_info_button")
                        generation_info_button.click(
                            fn=update_generation_info,
                            _js="function(x, y, z){ return [x, y, selected_gallery_index()] }",
                            inputs=[res.generation_info, res.infotext, res.infotext],
                            outputs=[res.infotext, res.infotext],
                            show_progress=False,
                        )

                    save.click(
                        fn=call_queue.wrap_gradio_call_no_job(save_files),
                        _js="(x, y, z, w) => [x, y, false, selected_gallery_index()]",
                        inputs=[
                            res.generation_info,
                            res.gallery,
                            res.infotext,
                            res.infotext,
                        ],
                        outputs=[
                            download_files,
                            res.html_log,
                        ],
                        show_progress=False,
                    )

                    endorse_btn.click(
                        fn=call_queue.wrap_gradio_call_no_job(endorse_current),
                        _js="(x, y, z) => [x, y, selected_gallery_index()]",
                        inputs=[
                            res.generation_info,
                            res.gallery,
                            res.infotext,
                        ],
                        outputs=[res.html_log],
                        show_progress=False,
                    )

                    save_zip.click(
                        fn=call_queue.wrap_gradio_call_no_job(save_files),
                        _js="(x, y, z, w) => [x, y, true, selected_gallery_index()]",
                        inputs=[
                            res.generation_info,
                            res.gallery,
                            res.infotext,
                            res.infotext,
                        ],
                        outputs=[
                            download_files,
                            res.html_log,
                        ]
                    )

            else:
                res.generation_info = gr.HTML(elem_id=f'html_info_x_{tabname}')
                res.infotext = gr.HTML(elem_id=f'html_info_{tabname}', elem_classes="infotext")
                res.html_log = gr.HTML(elem_id=f'html_log_{tabname}')

            paste_field_names = []
            if tabname == "txt2img":
                paste_field_names = modules.scripts.scripts_txt2img.paste_field_names
            elif tabname == "img2img":
                paste_field_names = modules.scripts.scripts_img2img.paste_field_names

            for paste_tabname, paste_button in buttons.items():
                parameters_copypaste.register_paste_params_button(parameters_copypaste.ParamBinding(
                    paste_button=paste_button, tabname=paste_tabname, source_tabname="txt2img" if tabname == "txt2img" else None, source_image_component=res.gallery,
                    paste_field_names=paste_field_names
                ))

    return res


def create_refresh_button(refresh_component, refresh_method, refreshed_args, elem_id):
    refresh_components = refresh_component if isinstance(refresh_component, list) else [refresh_component]

    label = None
    for comp in refresh_components:
        label = getattr(comp, 'label', None)
        if label is not None:
            break

    def refresh():
        refresh_method()
        args = refreshed_args() if callable(refreshed_args) else refreshed_args

        for k, v in args.items():
            for comp in refresh_components:
                setattr(comp, k, v)

        return [gr.update(**(args or {})) for _ in refresh_components] if len(refresh_components) > 1 else gr.update(**(args or {}))

    refresh_button = ToolButton(value=refresh_symbol, elem_id=elem_id, tooltip=f"{label}: refresh" if label else "Refresh")
    refresh_button.click(
        fn=refresh,
        inputs=[],
        outputs=refresh_components
    )
    return refresh_button


def setup_dialog(button_show, dialog, *, button_close=None):
    """Sets up the UI so that the dialog (gr.Box) is invisible, and is only shown when buttons_show is clicked, in a fullscreen modal window."""

    dialog.visible = False

    button_show.click(
        fn=lambda: gr.update(visible=True),
        inputs=[],
        outputs=[dialog],
    ).then(fn=None, _js="function(){ popupId('" + dialog.elem_id + "'); }")

    if button_close:
        button_close.click(fn=None, _js="closePopup")

