import os
import re

import network
import networks

from modules import shared, ui_extra_networks
from modules.ui_extra_networks import quote_js
from ui_edit_user_metadata import LoraUserMetadataEditor


re_lora_variant = re.compile(r"^(?P<base>.+?)-\d{5,}$")


def lora_variant_group(name):
    match = re_lora_variant.match(name)
    return match.group("base") if match else name


def lora_variant_sort_key(name, item):
    metadata = item.get("metadata") or {}
    try:
        epoch = int(metadata.get("ss_epoch"))
    except (TypeError, ValueError):
        epoch = None

    if epoch is not None:
        return (0, epoch)

    match = re_lora_variant.match(name)
    return (1, int(match.group(0).rsplit("-", 1)[1]) if match else float("inf"))


class ExtraNetworksPageLora(ui_extra_networks.ExtraNetworksPage):
    def __init__(self):
        super().__init__('Lora')

    def refresh(self):
        networks.list_available_networks()

    def _grouped_network_names(self):
        groups = {}
        for name in networks.available_networks:
            groups.setdefault(lora_variant_group(name), []).append(name)
        return groups

    def _variation_label(self, name, item):
        metadata = item.get("metadata") or {}
        epoch = metadata.get("ss_epoch")
        is_variant = bool(re_lora_variant.match(name))
        if epoch not in (None, "", "None"):
            return f"epoch {epoch}" + ("" if is_variant else " (final)")
        return name.rsplit("-", 1)[-1] if is_variant else "final"

    def create_item(self, name, index=None, enable_filter=True):
        groups = self._grouped_network_names()
        members = groups.get(name)
        if members is None:
            members = [name]

        items = []
        for member in members:
            item = self._create_single_item(member, index, enable_filter)
            if item is not None:
                items.append((member, item))

        if not items:
            return None

        items.sort(key=lambda pair: lora_variant_sort_key(pair[0], pair[1]))
        default_name, default_item = items[-1]
        group_item = default_item

        if len(items) > 1:
            group_item = default_item.copy()
            group_item["name"] = name
            group_item["default_variation"] = default_name
            group_item["variations"] = [
                {
                    "name": member,
                    "label": self._variation_label(member, item),
                    "prompt": item["prompt"],
                    "negative_prompt": item.get("negative_prompt", "''"),
                    "preview": item.get("preview"),
                }
                for member, item in items
            ]

            search_terms = []
            for _, item in items:
                for term in item.get("search_terms", []):
                    if term not in search_terms:
                        search_terms.append(term)

            group_item["search_terms"] = search_terms
            group_item["filename"] = default_item["filename"]
            group_item["preview"] = default_item.get("preview")
            group_item["prompt"] = default_item["prompt"]
            group_item["negative_prompt"] = default_item.get("negative_prompt", "''")
            group_item["local_preview"] = default_item.get("local_preview")
            group_item["shorthash"] = default_item.get("shorthash")
            group_item["metadata"] = default_item.get("metadata")
            group_item["sort_keys"] = default_item.get("sort_keys")
            group_item["sd_version"] = default_item.get("sd_version")
        elif name not in networks.available_networks:
            group_item = default_item.copy()
            group_item["name"] = default_name

        return group_item

    def _create_single_item(self, name, index=None, enable_filter=True):
        lora_on_disk = networks.available_networks.get(name)
        if lora_on_disk is None:
            return

        path, ext = os.path.splitext(lora_on_disk.filename)

        alias = lora_on_disk.get_alias()

        search_terms = [self.search_terms_from_path(lora_on_disk.filename)]
        if lora_on_disk.hash:
            search_terms.append(lora_on_disk.hash)
        item = {
            "name": name,
            "filename": lora_on_disk.filename,
            "shorthash": lora_on_disk.shorthash,
            "preview": self.find_preview(path) or self.find_embedded_preview(path, name, lora_on_disk.metadata),
            "description": self.find_description(path),
            "search_terms": search_terms,
            "local_preview": f"{path}.{shared.opts.samples_format}",
            "metadata": lora_on_disk.metadata,
            "sort_keys": {'default': index, **self.get_sort_keys(lora_on_disk.filename)},
            "sd_version": lora_on_disk.sd_version.name,
        }

        self.read_user_metadata(item)
        activation_text = item["user_metadata"].get("activation text")
        preferred_weight = item["user_metadata"].get("preferred weight", 0.0)
        item["prompt"] = quote_js(f"<lora:{alias}:") + " + " + (str(preferred_weight) if preferred_weight else "opts.extra_networks_default_multiplier") + " + " + quote_js(">")

        if activation_text:
            item["prompt"] += " + " + quote_js(" " + activation_text)

        negative_prompt = item["user_metadata"].get("negative text")
        item["negative_prompt"] = quote_js("")
        if negative_prompt:
            item["negative_prompt"] = quote_js('(' + negative_prompt + ':1)')

        sd_version = item["user_metadata"].get("sd version")
        if sd_version in network.SdVersion.__members__:
            item["sd_version"] = sd_version
            sd_version = network.SdVersion[sd_version]
        else:
            sd_version = lora_on_disk.sd_version

        if shared.opts.lora_show_all or not enable_filter or not shared.sd_model:
            pass
        elif sd_version == network.SdVersion.Unknown:
            model_version = network.SdVersion.SDXL if shared.sd_model.is_sdxl else network.SdVersion.SD2 if shared.sd_model.is_sd2 else network.SdVersion.SD1
            if model_version.name in shared.opts.lora_hide_unknown_for_versions:
                return None
        elif shared.sd_model.is_sdxl and sd_version != network.SdVersion.SDXL:
            return None
        elif shared.sd_model.is_sd2 and sd_version != network.SdVersion.SD2:
            return None
        elif shared.sd_model.is_sd1 and sd_version != network.SdVersion.SD1:
            return None

        return item

    def list_items(self):
        # Group training checkpoints (name-000002, name-000004, ...) into one card.
        groups = self._grouped_network_names()
        for index, name in enumerate(groups):
            item = self.create_item(name, index)
            if item is not None:
                yield item

    def allowed_directories_for_previews(self):
        return [shared.cmd_opts.lora_dir, shared.cmd_opts.lyco_dir_backcompat]

    def create_user_metadata_editor(self, ui, tabname):
        return LoraUserMetadataEditor(ui, tabname, self)
