"""Extra Networks page for the Anima (DiT) LoRAs.

A1111's Lora page lists `models/Lora` only, and its loader applies the weights to
a loaded SD UNet. Anima LoRAs are stable-diffusion.cpp runtime adapters: they live
in `models/Anima/loras` and travel to the backend through the same
`<lora:name:weight>` prompt tag that the Anima runner resolves into its payload.
"""

from __future__ import annotations

import os

from modules import model_registry, shared, ui_extra_networks
from modules.ui_extra_networks import quote_js


class ExtraNetworksPageAnimaLora(ui_extra_networks.ExtraNetworksPage):
    def __init__(self):
        super().__init__('Anima LoRA')

    def _make_item(self, filename: str, index=None) -> dict:
        path = os.path.join(model_registry.lora_dir(), filename)
        stem, _ = os.path.splitext(path)
        name = os.path.basename(stem)

        item = {
            "name": name,
            "filename": path,
            "preview": self.find_preview(stem),
            "description": self.find_description(stem),
            "search_terms": [name, filename],
            "local_preview": f"{stem}.{shared.opts.samples_format}",
            "sort_keys": {"default": index, **self.get_sort_keys(path)},
        }
        self.read_user_metadata(item)

        preferred_weight = item["user_metadata"].get("preferred weight", 0.0)
        weight = str(preferred_weight) if preferred_weight else "opts.extra_networks_default_multiplier"
        item["prompt"] = quote_js(f"<lora:{name}:") + " + " + weight + " + " + quote_js(">")

        activation_text = item["user_metadata"].get("activation text")
        if activation_text:
            item["prompt"] += " + " + quote_js(" " + activation_text)

        return item

    def list_items(self):
        for index, filename in enumerate(model_registry.list_loras()):
            yield self._make_item(filename, index)

    def create_item(self, name, index=None):
        for filename in model_registry.list_loras():
            if os.path.splitext(filename)[0] == name:
                return self._make_item(filename, index)
        return None

    def allowed_directories_for_previews(self):
        return [model_registry.lora_dir()]
