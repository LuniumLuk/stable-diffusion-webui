/**
 * CodeMirror 6 prompt editor for Mobile Lite — the mobile wrapper around the shared
 * editor core (`./prompt-cm-core.js`, also used by the desktop prompt hosts via
 * `javascript/promptCM.mjs`).  This file only binds the mobile UI helpers:
 *
 *   - the token popup / drag / suggestions grammar lives in the core;
 *   - the inline field and the fullscreen overlay are the two mount variants here;
 *   - toasts go through the Mobile Lite toast host.
 *
 * The vendored bundle (`../vendor/codemirror6.js`, built by `vendor/cm6build/build.bat`)
 * loads lazily on first use; when that fails the caller keeps the old textarea.
 */

import { toast } from './ui.js';
import { createPromptCM as createCore, loadBundle } from './prompt-cm-core.js';

export { loadBundle as loadPromptCM };

/** Mobile Lite mount: inject the mobile toast host, keep every other option as-is. */
export function createPromptCM(options = {}) {
  return createCore({ notify: toast, ...options });
}


