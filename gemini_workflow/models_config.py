"""
models_config.py — load default Gemini models from config_states/gemini_models.txt.

Shared by gemini_workflow/generate.py, gemini_workflow/comic_maker.py and
scripts/gemini_nano_banana.py so the user can change default models in one
place without editing code.

Format (key=value, case-insensitive, '#' comments ignored):
  TEXT_MODEL=<llm model id>
  IMAGE_MODEL=<image model id>
"""
import os

_ROOT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CONFIG_PATH = os.path.join(_ROOT_DIR, "config_states", "gemini_models.txt")

DEFAULTS = {
    "text_model": "gemini-3.5-flash",
    "image_model": "gemini-2.5-flash-image",
}

_ALIASES = {
    "text_model": ("text_model", "text-model", "llm", "llm_model"),
    "image_model": ("image_model", "image-model", "image"),
}


def load_model_config():
    """Return {'text_model': ..., 'image_model': ...}.

    Values come from config_states/gemini_models.txt when present, else the
    built-in defaults. Missing/invalid entries fall back per-key.
    """
    cfg = dict(DEFAULTS)
    if not os.path.exists(CONFIG_PATH):
        return cfg
    try:
        with open(CONFIG_PATH, "r", encoding="utf-8") as f:
            for raw in f:
                line = raw.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                name, _, val = line.partition("=")
                name = name.strip().lower()
                val = val.strip()
                if not val:
                    continue
                for key, aliases in _ALIASES.items():
                    if name in aliases:
                        cfg[key] = val
                        break
    except Exception:
        pass
    return cfg
