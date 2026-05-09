"""API endpoints for prompt presets management"""

from modules.prompt_presets import prompt_presets


def prompt_preset_list():
    """Get list of available presets"""
    return prompt_presets.get_presets()


def prompt_preset_get(name: str):
    """Get preset content by name"""
    return prompt_presets.get_preset(name)


def prompt_preset_save(name: str, content: str):
    """Save or update a preset"""
    success = prompt_presets.save_preset(name, content)
    return {
        "success": success,
        "presets": prompt_presets.get_presets()
    }


def prompt_preset_delete(name: str):
    """Delete a preset"""
    success = prompt_presets.delete_preset(name)
    return {
        "success": success,
        "presets": prompt_presets.get_presets()
    }


def prompt_preset_rename(old_name: str, new_name: str):
    """Rename a preset"""
    success = prompt_presets.rename_preset(old_name, new_name)
    return {
        "success": success,
        "presets": prompt_presets.get_presets()
    }
