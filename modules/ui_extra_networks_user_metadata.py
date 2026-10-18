import datetime
import html
import json
import os.path

import gradio as gr

from PIL import Image

from modules import infotext_utils, images, sysinfo, errors, ui_extra_networks


class UserMetadataEditor:

    def __init__(self, ui, tabname, page):
        self.ui = ui
        self.tabname = tabname
        self.page = page
        self.id_part = f"{self.tabname}_{self.page.extra_networks_tabname}_edit_user_metadata"

        self.box = None

        self.edit_name_input = None
        self.button_edit = None

        self.edit_name = None
        self.edit_description = None
        self.edit_notes = None
        self.html_filedata = None
        self.html_preview = None
        self.html_status = None

        self.button_cancel = None
        self.button_replace_preview = None
        self.button_save = None
        self.preview_file = None
        self.button_set_preview = None

    def get_user_metadata(self, name):
        item = self.page.items.get(name, {})

        user_metadata = item.get('user_metadata', None)
        if not user_metadata:
            user_metadata = {'description': item.get('description', '')}
            item['user_metadata'] = user_metadata

        return user_metadata

    def create_extra_default_items_in_left_column(self):
        pass

    def create_default_editor_elems(self):
        with gr.Row():
            with gr.Column(scale=2):
                self.edit_name = gr.HTML(elem_classes="extra-network-name")
                self.edit_description = gr.Textbox(label="Description", lines=4)
                self.html_filedata = gr.HTML()

                self.create_extra_default_items_in_left_column()

            with gr.Column(scale=1, min_width=0):
                self.html_preview = gr.HTML()
                self.preview_file = gr.File(label="Choose a thumbnail image", file_types=["image"], type="file", elem_id=f"{self.id_part}_preview_file")
                self.button_set_preview = gr.Button("Save as thumbnail", variant="secondary")

    def create_default_buttons(self):

        with gr.Row(elem_classes="edit-user-metadata-buttons"):
            self.button_cancel = gr.Button('Cancel')
            self.button_replace_preview = gr.Button('Replace preview', variant='primary')
            self.button_save = gr.Button('Save', variant='primary')

        self.html_status = gr.HTML(elem_classes="edit-user-metadata-status")

        self.button_cancel.click(fn=None, _js="closePopup")

    def get_card_html(self, name):
        item = self.page.items.get(name, {})

        preview_url = item.get("preview", None)

        if not preview_url:
            filename, _ = os.path.splitext(item["filename"])
            preview_url = self.page.find_preview(filename)
            item["preview"] = preview_url

        if preview_url:
            preview = f'''
            <div class='card standalone-card-preview'>
                <img src="{html.escape(preview_url)}" class="preview">
            </div>
            '''
        else:
            preview = "<div class='card standalone-card-preview'></div>"

        return preview

    def relative_path(self, path):
        for parent_path in self.page.allowed_directories_for_previews():
            if ui_extra_networks.path_is_parent(parent_path, path):
                return os.path.relpath(path, parent_path)

        return os.path.basename(path)

    def get_metadata_table(self, name):
        item = self.page.items.get(name, {})
        try:
            filename = item["filename"]
            shorthash = item.get("shorthash", None)

            stats = os.stat(filename)
            params = [
                ('Filename: ', self.relative_path(filename)),
                ('File size: ', sysinfo.pretty_bytes(stats.st_size)),
                ('Hash: ', shorthash),
                ('Modified: ', datetime.datetime.fromtimestamp(stats.st_mtime).strftime('%Y-%m-%d %H:%M')),
            ]

            return params
        except Exception as e:
            errors.display(e, f"reading info for {name}")
            return []

    def put_values_into_components(self, name):
        user_metadata = self.get_user_metadata(name)

        try:
            params = self.get_metadata_table(name)
        except Exception as e:
            errors.display(e, f"reading metadata info for {name}")
            params = []

        table = '<table class="file-metadata">' + "".join(f"<tr><th>{name}</th><td>{value}</td></tr>" for name, value in params if value is not None) + '</table>'

        return html.escape(name), user_metadata.get('description', ''), table, self.get_card_html(name), user_metadata.get('notes', '')

    def write_user_metadata(self, name, metadata):
        item = self.page.items.get(name, {})
        filename = item.get("filename", None)
        basename, ext = os.path.splitext(filename)

        metadata_path = basename + '.json'
        with open(metadata_path, "w", encoding="utf8") as file:
            json.dump(metadata, file, indent=4, ensure_ascii=False)
        self.page.lister.update_file_entry(metadata_path)

    def save_user_metadata(self, name, desc, notes):
        user_metadata = self.get_user_metadata(name)
        user_metadata["description"] = desc
        user_metadata["notes"] = notes

        self.write_user_metadata(name, user_metadata)

    def setup_save_handler(self, button, func, components):
        button\
            .click(fn=func, inputs=[self.edit_name_input, *components], outputs=[])\
            .then(fn=None, _js="function(name){closePopup(); extraNetworksRefreshSingleCard(" + json.dumps(self.page.name) + "," + json.dumps(self.tabname) + ", name);}", inputs=[self.edit_name_input], outputs=[])

    def create_editor(self):
        self.create_default_editor_elems()

        self.edit_notes = gr.TextArea(label='Notes', lines=4)

        self.create_default_buttons()

        self.button_edit\
            .click(fn=self.put_values_into_components, inputs=[self.edit_name_input], outputs=[self.edit_name, self.edit_description, self.html_filedata, self.html_preview, self.edit_notes])\
            .then(fn=lambda: gr.update(visible=True), inputs=[], outputs=[self.box])

        self.setup_save_handler(self.button_save, self.save_user_metadata, [self.edit_description, self.edit_notes])

    def create_ui(self):
        with gr.Box(visible=False, elem_id=self.id_part, elem_classes="edit-user-metadata") as box:
            self.box = box

            self.edit_name_input = gr.Textbox("Edit user metadata card id", visible=False, elem_id=f"{self.id_part}_name")
            self.button_edit = gr.Button("Edit user metadata", visible=False, elem_id=f"{self.id_part}_button")

            self.create_editor()

    def save_preview(self, index, gallery, name):
        if len(gallery) == 0:
            return self.get_card_html(name), "There is no image in gallery to save as a preview."

        item = self.page.items.get(name, {})

        index = int(index)
        index = 0 if index < 0 else index
        index = len(gallery) - 1 if index >= len(gallery) else index

        img_info = gallery[index if index >= 0 else 0]
        image = infotext_utils.image_from_url_text(img_info)
        geninfo, items = images.read_info_from_image(image)

        images.save_image_with_geninfo(image, geninfo, item["local_preview"])
        self.page.lister.update_file_entry(item["local_preview"])
        item['preview'] = self.page.find_preview(item["local_preview"])
        return self.get_card_html(name), ''

    def save_preview_from_file(self, name, file):
        """Save a user-selected image as the extra network thumbnail."""
        item = self.page.items.get(name, {})
        if not item:
            return self.get_card_html(name), "Unknown item."

        path = getattr(file, "name", file)
        if isinstance(path, (list, tuple)):
            path = path[0] if path else None
        if not path or not os.path.isfile(str(path)):
            return self.get_card_html(name), "Choose an image file first."

        target = item.get("local_preview") or os.path.splitext(item["filename"])[0] + ".preview.png"
        try:
            with Image.open(str(path)) as image:
                image.seek(0)
                image = image.convert("RGB")
                image.thumbnail((1024, 1024), Image.LANCZOS)
                image.save(target)
            self.page.lister.update_file_entry(target)
            item['preview'] = self.page.find_preview(os.path.splitext(item["filename"])[0])
            return self.get_card_html(name), "Thumbnail saved."
        except Exception as e:
            errors.display(e, f"saving thumbnail for {name}")
            return self.get_card_html(name), f"Could not save thumbnail: {e}"

    def setup_ui(self, gallery):
        self.button_replace_preview.click(
            fn=self.save_preview,
            _js=f"function(x, y, z){{return [selected_gallery_index_id('{self.tabname + '_gallery_container'}'), y, z]}}",
            inputs=[self.edit_name_input, gallery, self.edit_name_input],
            outputs=[self.html_preview, self.html_status]
        ).then(
            fn=None,
            _js="function(name){extraNetworksRefreshSingleCard(" + json.dumps(self.page.name) + "," + json.dumps(self.tabname) + ", name);}",
            inputs=[self.edit_name_input],
            outputs=[]
        )

        self.button_set_preview.click(
            fn=self.save_preview_from_file,
            inputs=[self.edit_name_input, self.preview_file],
            outputs=[self.html_preview, self.html_status]
        ).then(
            fn=None,
            _js="function(name){extraNetworksRefreshSingleCard(" + json.dumps(self.page.name) + "," + json.dumps(self.tabname) + ", name);}",
            inputs=[self.edit_name_input],
            outputs=[]
        )
