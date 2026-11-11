/* Lightweight mode: generation is a no-op with a hint while the server keeps every model unloaded. */

import { state } from './state.js';
import { toast } from './ui.js';

export const MESSAGE = 'Lightweight mode is on: models are unloaded and generation is disabled. Turn it off in the Lite settings sheet to generate again.';

export function enabled() {
  return !!(state.boot && state.boot.lightweight_mode);
}

/** True when the caller must stop: shows the hint and reports the blocked action. */
export function blocked() {
  if (!enabled()) return false;
  toast(MESSAGE, 'warn', 3600);
  return true;
}
