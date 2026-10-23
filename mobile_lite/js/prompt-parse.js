/**
 * Prompt token model for the Mobile Lite prompt editor.
 *
 * Faithful port of the pure parser in `javascript/promptEditor.js` (the desktop chips
 * editor): a line is split into segments at *top level* commas (commas inside (), [], <>
 * or an @PICK{...} group are not separators), each segment keeps its raw lead/body/tail
 * so an untouched line re-serialises byte-identically.  `classify()` reports the
 * *effective* A1111 weight ('((x))' -> 1.21, '[x]' -> 0.909) and `rebuild()` writes a
 * token back with a new weight / disabled flag - every user edit goes through it.
 * A keyword that starts with '@' is checked by `prompt-syntax.js`: a well formed
 * directive is a `pick` token, a broken one an `at` token that carries the error.
 *
 * The same test expectations as `tmp/pedit_test.js` apply (see `tmp/lite_pedit_test.mjs`).
 */

import { analyzeAtSyntax } from './prompt-syntax.js';

export const DEFAULT_WEIGHT = 1.0;

export function formatWeight(weight) {
  const rounded = Math.round(weight * 1000) / 1000;
  // A1111 writes weights with a decimal part; "1.0" is what console/API users expect.
  return Number.isInteger(rounded) ? rounded + '.0' : String(rounded);
}

export function splitSegments(line) {
  const segments = [];
  let lead = '';
  let body = '';
  let depth = 0;
  let index = 0;

  while (index < line.length && /\s/.test(line[index])) lead += line[index++];
  if (index >= line.length) return [{ lead, body: '', tail: '' }];

  for (; index < line.length; index += 1) {
    const ch = line[index];
    if (ch === '(' || ch === '[' || ch === '<' || ch === '{') depth += 1;
    else if (ch === ')' || ch === ']' || ch === '>' || ch === '}') depth = Math.max(0, depth - 1);

    if (ch === ',' && depth === 0) {
      let tail = ',';
      index += 1;
      while (index < line.length && /\s/.test(line[index])) tail += line[index++];
      index -= 1;
      segments.push({ lead, body, tail });
      lead = '';
      body = '';
      continue;
    }
    body += ch;
  }
  segments.push({ lead, body, tail: '' });
  return segments;
}

export function joinSegments(segments) {
  return segments.map((segment) => segment.lead + segment.body + segment.tail).join('');
}

function colonWeight(inner) {
  let depth = 0;
  for (let index = inner.length - 1; index >= 0; index -= 1) {
    const ch = inner[index];
    if (ch === ')' || ch === ']' || ch === '>') depth += 1;
    else if (ch === '(' || ch === '[' || ch === '<') depth -= 1;
    else if (ch === ':' && depth === 0) {
      const tailText = inner.slice(index + 1);
      const weight = parseFloat(tailText);
      if (!Number.isNaN(weight) && /^\s*-?[\d.]+\s*$/.test(tailText)) {
        return { text: inner.slice(0, index), weight, hasColon: true };
      }
      return { text: inner, weight: null, hasColon: false };
    }
  }
  return { text: inner, weight: null, hasColon: false };
}

function wrapperLevels(text, open, close) {
  let inner = text;
  let levels = 0;
  while (levels < 9 && inner.length >= 2 && inner[0] === open && inner[inner.length - 1] === close) {
    let depth = 0;
    let closesAtEnd = false;
    for (let index = 0; index < inner.length; index += 1) {
      if (inner[index] === open) depth += 1;
      else if (inner[index] === close) {
        depth -= 1;
        if (depth === 0) {
          closesAtEnd = index === inner.length - 1;
          break;
        }
      }
    }
    if (!closesAtEnd) break;
    inner = inner.slice(1, -1);
    levels += 1;
  }
  return { levels, inner };
}

/** Classify a segment body -> { kind, text, weight, disabled }. */
export function classify(body) {
  const text = String(body == null ? '' : body).trim();
  if (!text) return { kind: 'plain', text: '', weight: DEFAULT_WEIGHT, disabled: false };
  if (text === ',') return { kind: 'plain', text: ',', weight: DEFAULT_WEIGHT, disabled: false };

  // every keyword starting with '@' is a directive and must pass the grammar:
  // a well formed @PICK is a `pick` token, a broken directive an `at` token carrying
  // the error (the chips and the CodeMirror decorations style it as broken)
  const syntax = analyzeAtSyntax(text);
  if (syntax) {
    return {
      kind: syntax.ok ? 'pick' : 'at',
      text,
      weight: DEFAULT_WEIGHT,
      disabled: false,
      pickCount: syntax.ok ? syntax.count : 0,
      syntax,
    };
  }

  // #(...) / #[...] / #<...> -> disabled keyword group (stripped when generating)
  if (text[0] === '#' && text.length > 3) {
    const inner = classify(text.slice(1));
    if (inner.kind !== 'plain') {
      inner.disabled = true;
      return inner;
    }
  }

  if (text[0] === '(' && text[text.length - 1] === ')') {
    const wrap = wrapperLevels(text, '(', ')');
    if (wrap.levels > 0) {
      const colon = colonWeight(wrap.inner);
      const base = colon.hasColon ? colon.weight : 1.1;
      return {
        kind: 'paren',
        text: colon.hasColon ? colon.text : wrap.inner,
        weight: base * Math.pow(1.1, wrap.levels - 1),
        disabled: false,
      };
    }
  }

  if (text[0] === '[' && text[text.length - 1] === ']') {
    const wrap = wrapperLevels(text, '[', ']');
    if (wrap.levels > 0) {
      const colon = colonWeight(wrap.inner);
      const base = colon.hasColon ? colon.weight : 1 / 1.1;
      return {
        kind: 'bracket',
        text: colon.hasColon ? colon.text : wrap.inner,
        weight: base * Math.pow(1 / 1.1, wrap.levels - 1),
        disabled: false,
      };
    }
  }

  if (text[0] === '<' && text[text.length - 1] === '>') {
    const inner = text.slice(1, -1);
    const parts = inner.split(':');
    let weight = DEFAULT_WEIGHT;
    let label = inner;
    if (parts.length >= 3) {
      const parsed = parseFloat(parts[parts.length - 1]);
      if (!Number.isNaN(parsed)) {
        weight = parsed;
        label = parts.slice(0, -1).join(':');
      }
    }
    return { kind: 'angle', text: label, weight, disabled: false };
  }

  return { kind: 'plain', text, weight: DEFAULT_WEIGHT, disabled: false };
}

/** Build the body text for a token with the given weight / disabled flag. */
export function rebuild(token, weight, disabled) {
  // a random-pick group has no weight of its own and cannot be disabled with '#(...)',
  // and a broken '@' directive must keep its text so the user can fix it in place
  if (token.kind === 'pick' || token.kind === 'at') return token.text;

  const flat = Math.abs(weight - DEFAULT_WEIGHT) < 1e-9;
  let inner;
  if (token.kind === 'angle') {
    inner = flat ? `<${token.text}>` : `<${token.text}:${formatWeight(weight)}>`;
  } else {
    inner = flat ? token.text : `${token.text}:${formatWeight(weight)}`;
  }
  if (disabled) return `#(${inner})`;
  if (token.kind === 'angle' || flat) return inner; // weight 1 -> drop the brackets entirely
  return `(${inner})`;
}

/* ------------------------------------------------------------------ line weights
 *
 * A line can carry one weight for the whole line: every keyword wrapped in a single group,
 * `(keyword, keyword:1.2)` - the same syntax A1111 uses for `(a, b:1.2)`. The chips editor
 * unwraps such lines for display (per-keyword chips stay editable) and re-applies the group
 * after every edit. Only an EXPLICIT numeric tail counts, so a manually written
 * single-keyword group like `(cat)` keeps being a keyword weight, not a line weight.
 */

/** `{ inner, weight }` when the whole line is one weighted group, else null. */
export function parseLineWeight(line) {
  const text = String(line == null ? '' : line).trim();
  if (text.length < 4 || text[0] !== '(' || text[text.length - 1] !== ')') return null;
  let depth = 0;
  for (let index = 0; index < text.length; index += 1) {
    const ch = text[index];
    if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth < 0) return null;
      if (depth === 0 && index !== text.length - 1) return null; // the group closes early
    }
  }
  if (depth !== 0) return null;
  const colon = colonWeight(text.slice(1, -1));
  if (!colon.hasColon || !colon.text.trim()) return null;
  return { inner: colon.text, weight: colon.weight };
}

/** Wrap a line's content in a line-weight group (weight null / 1.0 removes the group). */
export function applyLineWeight(line, weight) {
  const text = String(line == null ? '' : line);
  const core = text.trim();
  if (!core) return text;
  const leading = text.slice(0, text.length - text.trimStart().length);
  const trailing = text.slice(text.trimEnd().length);
  const current = parseLineWeight(core);
  const inner = current ? current.inner.replace(/\s+$/, '') : core;
  const numeric = weight == null ? null : Number(weight);
  const flat = numeric === null || Number.isNaN(numeric) || Math.abs(numeric - DEFAULT_WEIGHT) < 1e-9;
  if (flat || !inner) return leading + inner + trailing;
  return `${leading}(${inner}:${formatWeight(numeric)})${trailing}`;
}

/* ------------------------------------------------------------------ block comments
 *
 * Same contract as the desktop text-mode overlay (javascript/promptComment.js):
 * a "block starter" is a line beginning (after whitespace) with `# ---` (extra dashes
 * and a trailing label are fine); the block it opens runs up to - but not including -
 * the NEXT starter line, and both marker lines are never modified.  A starter without
 * a following marker has no block, so it cannot be toggled.
 */

const BLOCK_MARKER = /^\s*#\s*-{3,}/;

export function isBlockMarker(line) {
  return BLOCK_MARKER.test(line);
}

/** Build a block divider line for the given name: `# --- name ---`. */
export function blockMarker(name) {
  const label = String(name == null ? '' : name).trim();
  return label ? `# --- ${label} ---` : '# --- ---';
}

/** `{ from, to }` line indexes covered by the block opened at `index`, or null. */
export function blockBounds(lines, index) {
  if (index < 0 || index >= lines.length || !isBlockMarker(lines[index])) return null;
  for (let i = index + 1; i < lines.length; i += 1) {
    if (isBlockMarker(lines[i])) return { from: index + 1, to: i };
  }
  return null;
}

/** True when the line starts with '#' but not with a disabled keyword group ('#(' ...). */
function startsWithLineHash(line) {
  const trimmed = line.trimStart();
  if (trimmed.charAt(0) !== '#') return false;
  return '([<'.indexOf(trimmed.charAt(1)) < 0;
}

/** A block is off when every non-empty line inside it starts with '#'. */
export function blockIsOff(lines, from, to) {
  let any = false;
  for (let i = from; i < to; i += 1) {
    if (!lines[i].trim()) continue;
    any = true;
    if (!startsWithLineHash(lines[i])) return false;
  }
  return any;
}

/** Toggle the block opened at `index`; returns the new line array (unchanged when no block). */
export function toggleBlockLines(lines, index) {
  const bounds = blockBounds(lines, index);
  if (!bounds) return lines;
  const off = blockIsOff(lines, bounds.from, bounds.to);
  const next = lines.slice();
  for (let i = bounds.from; i < bounds.to; i += 1) {
    const line = next[i];
    if (!line.trim()) continue;
    const trimmed = line.trimStart();
    const indent = line.slice(0, line.length - trimmed.length);
    if (off) {
      if (trimmed.slice(0, 2) === '# ') next[i] = indent + trimmed.slice(2);
      else if (trimmed.charAt(0) === '#') next[i] = indent + trimmed.slice(1);
    } else if (!startsWithLineHash(line)) {
      next[i] = `${indent}# ${trimmed}`;
    }
  }
  return next;
}
