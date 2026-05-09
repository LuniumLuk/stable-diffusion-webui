/**
 * Prompt Presets Manager
 * Handles UI interactions for saving, loading, and managing prompt text presets
 * Uses localStorage for persistence
 */

(function () {
    'use strict';

    // Preset storage namespace
    const STORAGE_KEY = 'prompt_presets';

    /**
     * Get all presets from localStorage
     */
    window.getPresets = function() {
        try {
            const data = localStorage.getItem(STORAGE_KEY);
            return data ? JSON.parse(data) : {};
        } catch (e) {
            console.warn('[Presets] Error reading from localStorage:', e);
            return {};
        }
    };

    /**
     * Save all presets to localStorage
     */
    window.savePresets = function(presets) {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(presets));
        } catch (e) {
            console.warn('[Presets] Error writing to localStorage:', e);
        }
    };

    /**
     * Insert text into textarea at cursor position
     */
    function insertAtCursor(textarea, text) {
        if (!textarea) return;
        
        const start = textarea.selectionStart;
        const end = textarea.selectionEnd;
        const before = textarea.value.substring(0, start);
        const after = textarea.value.substring(end);
        
        // Add comma separator if textarea is not empty
        const separator = textarea.value.trim() ? ', ' : '';
        textarea.value = before + separator + text + after;
        
        // Move cursor to after inserted text
        const newPos = start + text.length + separator.length;
        textarea.selectionStart = textarea.selectionEnd = newPos;
        
        // Trigger input event for Gradio to notice the change
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
        textarea.dispatchEvent(new Event('change', { bubbles: true }));
    }

    /**
     * Update preset dropdown with current presets
     */
    window.updateDropdown = function(tab) {
        const presets = window.getPresets();
        const names = Object.keys(presets).sort();
        const dropdown = gradioApp().querySelector(`#${tab}_preset_dropdown`);
        
        if (!dropdown) return;
        
        // Find the select element
        const selectEl = dropdown.querySelector('select');
        if (!selectEl) return;
        
        selectEl.innerHTML = names.length ? 
            names.map(name => `<option value="${name}">${name}</option>`).join('') :
            '<option value="">(No presets)</option>';
    };
    
    function updateDropdown(tab) {
        window.updateDropdown(tab);
    }

    /**
     * Global functions for preset operations
     */
    window.save_prompt_preset_txt2img = function(promptText) {
        return save_prompt_preset_impl('txt2img', promptText);
    };
    
    window.save_prompt_preset_img2img = function(promptText) {
        return save_prompt_preset_impl('img2img', promptText);
    };
    
    function save_prompt_preset_impl(tab, promptText) {
        const selectedStart = gradioApp().querySelector(`#${tab}_prompt textarea`)?.selectionStart || 0;
        const selectedEnd = gradioApp().querySelector(`#${tab}_prompt textarea`)?.selectionEnd || 0;
        const selectedText = gradioApp().querySelector(`#${tab}_prompt textarea`)?.value.substring(selectedStart, selectedEnd) || '';
        
        if (!selectedText.trim()) {
            alert('Please select some text first to save as a preset');
            return;
        }
        
        const presetName = prompt('Preset name:', selectedText.substring(0, 30));
        if (!presetName) return;
        
        const presets = window.getPresets();
        presets[presetName] = selectedText;
        window.savePresets(presets);
        updateDropdown(tab);
        
        console.log('[Presets] Saved:', presetName);
    }

    window.edit_prompt_preset_txt2img = function(name) {
        return edit_prompt_preset_impl('txt2img', name);
    };
    
    window.edit_prompt_preset_img2img = function(name) {
        return edit_prompt_preset_impl('img2img', name);
    };
    
    function edit_prompt_preset_impl(tab, name) {
        if (!name || name === '(No presets)') {
            alert('Please select a preset to edit');
            return;
        }
        
        const presets = window.getPresets();
        const currentContent = presets[name] || '';
        const newContent = prompt('Edit preset content:', currentContent);
        
        if (newContent === null) return;
        
        presets[name] = newContent;
        window.savePresets(presets);
        updateDropdown(tab);
        
        console.log('[Presets] Updated:', name);
    }

    window.preset_selected_txt2img = function(name) {
        return preset_selected_impl('txt2img', name);
    };
    
    window.preset_selected_img2img = function(name) {
        return preset_selected_impl('img2img', name);
    };
    
    function preset_selected_impl(tab, name) {
        if (!name || name === '(No presets)') return;
        
        const presets = window.getPresets();
        const content = presets[name];
        
        if (content) {
            const textarea = gradioApp().querySelector(`#${tab}_prompt textarea`);
            insertAtCursor(textarea, content);
        }
    }

    /**
     * Initialize presets dropdown interactions
     */
    function setupPresetDropdowns() {
        const tabs = ['txt2img', 'img2img'];
        tabs.forEach(tab => {
            const dropdown = gradioApp().querySelector(`#${tab}_preset_dropdown`);
            if (!dropdown) return;
            
            // Update dropdown on load
            updateDropdown(tab);
            
            // Set up dropdown change event
            const selectEl = dropdown.querySelector('select');
            if (selectEl) {
                selectEl.addEventListener('change', () => {
                    const name = selectEl.value;
                    preset_selected_impl(tab, name);
                    selectEl.value = '';  // Reset dropdown
                });
            }
        });
    }

    // Wait for Gradio to be ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            setTimeout(setupPresetDropdowns, 500);
        });
    } else {
        setTimeout(setupPresetDropdowns, 500);
    }
})();

