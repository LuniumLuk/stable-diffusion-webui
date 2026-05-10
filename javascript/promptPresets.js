/**
 * Prompt Presets Manager
 * Handles UI interactions for prompt preset payload/copy UX.
 * Persistence and dropdown choice updates are backend-driven from ui_toprow.py.
 */

(function () {
    'use strict';

    const STORAGE_KEY = 'prompt_presets_cache';

    function getPresets() {
        try {
            const data = localStorage.getItem(STORAGE_KEY);
            return data ? JSON.parse(data) : {};
        } catch (e) {
            console.warn('[Presets] Error reading cache:', e);
            return {};
        }
    }

    function savePresets(presets) {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(presets || {}));
        } catch (e) {
            console.warn('[Presets] Error writing cache:', e);
        }
    }

    function getDropdownSelectedName(tab) {
        const dropdown = gradioApp().querySelector(`#${tab}_preset_dropdown`);
        if (!dropdown) return '';
        const selectEl = dropdown.querySelector('select');
        if (selectEl) return String(selectEl.value || '').trim();
        const inputEl = dropdown.querySelector('input');
        return inputEl ? String(inputEl.value || '').trim() : '';
    }

    function copyText(text) {
        const content = String(text || '');
        if (!content) return;

        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(content).catch(() => {
                const temp = document.createElement('textarea');
                temp.value = content;
                temp.style.position = 'fixed';
                temp.style.opacity = '0';
                document.body.appendChild(temp);
                temp.focus();
                temp.select();
                try {
                    document.execCommand('copy');
                } finally {
                    document.body.removeChild(temp);
                }
            });
            return;
        }

        const temp = document.createElement('textarea');
        temp.value = content;
        temp.style.position = 'fixed';
        temp.style.opacity = '0';
        document.body.appendChild(temp);
        temp.focus();
        temp.select();
        try {
            document.execCommand('copy');
        } finally {
            document.body.removeChild(temp);
        }
    }

    async function refreshPresetCacheFromFile() {
        try {
            const res = await fetch(`/file=${encodeURIComponent('prompt_presets/presets.json')}?t=${Date.now()}`);
            if (!res.ok) return;
            const data = await res.json();
            if (data && typeof data === 'object' && !Array.isArray(data)) {
                savePresets(data);
            }
        } catch (_e) {
            // Ignore unavailable file fetch; cache will still work for session-created presets.
        }
    }

    function buildAddPayload(tab) {
        const promptText = gradioApp().querySelector(`#${tab}_prompt textarea`)?.value || '';
        const textarea = gradioApp().querySelector(`#${tab}_prompt textarea`);
        const selectedStart = textarea?.selectionStart || 0;
        const selectedEnd = textarea?.selectionEnd || 0;
        const selectedText = textarea?.value.substring(selectedStart, selectedEnd) || '';
        const fallbackText = String(promptText || textarea?.value || '').trim();
        const contentToSave = selectedText.trim() ? selectedText.trim() : fallbackText;

        if (!contentToSave) {
            alert('Prompt is empty. Type or select text first.');
            return '';
        }

        const presetName = prompt('Preset name:', contentToSave.substring(0, 30));
        if (!presetName) return '';

        const presets = getPresets();
        presets[presetName] = contentToSave;
        savePresets(presets);

        return JSON.stringify({ name: presetName, content: contentToSave });
    }

    function buildEditPayload(tab) {
        const name = getDropdownSelectedName(tab);
        if (!name || name === '(No presets)') {
            alert('Please select a preset to edit');
            return '';
        }

        const presets = getPresets();
        const currentContent = presets[name] || '';
        const newContent = prompt('Edit preset content:', currentContent);

        if (newContent === null) return '';

        presets[name] = newContent;
        savePresets(presets);

        return JSON.stringify({ name, content: newContent });
    }

    async function copyPresetByName(name) {
        if (!name || name === '(No presets)') return;

        let presets = getPresets();
        let content = presets[name];
        if (!content) {
            await refreshPresetCacheFromFile();
            presets = getPresets();
            content = presets[name] || '';
        }
        if (!content) return;

        copyText(content);
        console.log('[Presets] Copied to clipboard:', name);
    }

    window.buildPromptPresetAddPayload = function(tab) {
        return buildAddPayload(tab);
    };

    window.buildPromptPresetEditPayload = function(tab) {
        return buildEditPayload(tab);
    };

    window.confirmDeletePromptPreset = function(name) {
        const presetName = String(name || '').trim();
        if (!presetName || presetName === '(No presets)') {
            alert('Please select a preset to delete');
            return false;
        }
        const ok = confirm(`Delete preset "${presetName}"?`);
        if (ok) {
            const presets = getPresets();
            delete presets[presetName];
            savePresets(presets);
        }
        return ok;
    };

    window.copyPromptPresetByName = function(name) {
        copyPresetByName(name);
    };

    /**
     * Initialize preset cache sync for copy behavior.
     */
    function setupPresetDropdowns() {
        refreshPresetCacheFromFile();
        setTimeout(refreshPresetCacheFromFile, 1200);
        setTimeout(refreshPresetCacheFromFile, 2800);
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

