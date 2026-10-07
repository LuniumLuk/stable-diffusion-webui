/* Parameter history controls for the folded summary line (▲ older / ▼ newer, max 10 per scope). */

import { stepParamHistory } from './state.js';
import { el, toast } from './ui.js';

/**
 * Two tiny step buttons that browse the stored parameter sets of one scope.
 * `key` (string or getter) names the scope; `store` (object or getter) is the live set the
 * stored snapshot is applied to. Applying emits 'params', which repaints the summary.
 */
export function historyControls(key, store) {
  const scope = () => (typeof key === 'function' ? key() : key);
  const target = () => (typeof store === 'function' ? store() : store);

  const step = (direction) => {
    const result = stepParamHistory(scope(), target(), direction);
    if (!result) {
      toast(direction < 0 ? 'no history yet' : 'already at the current setting', 'warn', 1600);
      return;
    }
    if (result.position === 0) toast('back to the current setting', 'ok', 1400);
    else toast(`history ${result.position}/${result.total}`, 'ok', 1400);
  };

  return el('div', { class: 'hist-controls' }, [
    el('button', {
      class: 'hist-btn', type: 'button', text: '\u25B2', title: 'Previous settings',
      'aria-label': 'Previous settings', onClick: () => step(-1),
    }),
    el('button', {
      class: 'hist-btn', type: 'button', text: '\u25BC', title: 'Next settings',
      'aria-label': 'Next settings', onClick: () => step(1),
    }),
  ]);
}
