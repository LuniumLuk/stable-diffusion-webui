"""Prompt presets manager for saving, loading, and managing text snippets"""

import os
import json
from pathlib import Path


class PromptPresets:
    def __init__(self):
        self.presets_dir = Path("prompt_presets")
        self.presets_file = self.presets_dir / "presets.json"
        self.presets = {}
        self.ensure_dir()
        self.load_presets()

    def ensure_dir(self):
        """Create presets directory if it doesn't exist"""
        self.presets_dir.mkdir(exist_ok=True)

    def load_presets(self):
        """Load presets from file"""
        try:
            if self.presets_file.exists():
                with open(self.presets_file, 'r', encoding='utf-8') as f:
                    self.presets = json.load(f)
        except Exception as e:
            print(f"[Error] Failed to load presets: {e}")
            self.presets = {}

    def save_presets(self):
        """Save presets to file"""
        try:
            with open(self.presets_file, 'w', encoding='utf-8') as f:
                json.dump(self.presets, f, indent=2, ensure_ascii=False)
        except Exception as e:
            print(f"[Error] Failed to save presets: {e}")

    def get_presets(self):
        """Return list of preset names sorted alphabetically"""
        return sorted(list(self.presets.keys()))

    def get_preset(self, name):
        """Get preset content by name"""
        return self.presets.get(name, "")

    def save_preset(self, name, content):
        """Save or update a preset"""
        if not name or not name.strip():
            return False
        
        name = name.strip()
        self.presets[name] = content
        self.save_presets()
        return True

    def delete_preset(self, name):
        """Delete a preset"""
        if name in self.presets:
            del self.presets[name]
            self.save_presets()
            return True
        return False

    def rename_preset(self, old_name, new_name):
        """Rename a preset"""
        if old_name in self.presets and new_name.strip():
            content = self.presets[old_name]
            del self.presets[old_name]
            self.presets[new_name.strip()] = content
            self.save_presets()
            return True
        return False


# Global instance
prompt_presets = PromptPresets()
