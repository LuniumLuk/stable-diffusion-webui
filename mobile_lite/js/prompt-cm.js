/**
 * CodeMirror 6 prompt editor for Mobile Lite — the mobile wrapper around the shared
 * editor core (`./prompt-cm-core.js`, also used by the desktop prompt hosts via
 * `javascript/promptCM.mjs`).  This file only binds the mobile UI helpers:
 *
 *   - the inline field and the fullscreen overlay are the two mount variants here;
 *   - toasts go through the Mobile Lite toast host;
 *   - the press / drag / tap manipulation grammar stays OFF (`gestures: false`): on a
 *     phone the tap-to-popup and drag-to-rearrange gestures made plain text selection
 *     and editing hard, so SD Lite uses the editor as a normal text field (native caret,
 *     selection and long-press).  The chips mode keeps the quick keyword tools, and the
 *     desktop mount keeps the full grammar.
 *
 * The vendored bundle (`../vendor/codemirror6.js`, built by `vendor/cm6build/build.bat`)
 * loads lazily on first use; when that fails the caller keeps the old textarea.
 */

import { toast } from './ui.js';
import { createPromptCM as createCore, loadBundle } from './prompt-cm-core.js';

export { loadBundle as loadPromptCM };

/** Mobile Lite mount: mobile toast host + plain (native) editing - no tool gestures. */
export function createPromptCM(options = {}) {
  return createCore({ notify: toast, gestures: false, ...options });
}


