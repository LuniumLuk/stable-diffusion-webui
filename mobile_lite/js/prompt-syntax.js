/**
 * `@` prompt syntax — grammar check, highlight class and hover hint.
 *
 * Every prompt keyword that starts with `@` is a directive and must pass this
 * grammar.  Right now there is one directive:
 *
 *   @PICK{a, b, c}      draw 1 keyword at random for every image
 *   @PICK(2){a, b, c}   draw 2 keywords at random for every image
 *   @PICK(2){
 *     red,
 *     blue
 *   }                   keyword lists may span multiple lines
 *
 * `analyzeAtSyntax(body)` returns null for an ordinary keyword and otherwise
 *   {
 *     ok,        // grammar is valid
 *     tag,       // 'pick' for a valid directive, the typed name for an unknown one
 *     raw,       // the keyword as typed
 *     count,     // keywords drawn per image (clamped to the group size)
 *     items,     // the keywords inside the braces
 *     kind,      // 'pick' | 'unknown'
 *     headline,  // one line: what the syntax does (or what is wrong with it)
 *     details,   // extra hint lines (preview of the result / the fix)
 *   }
 *
 * The CodeMirror core and the Mobile Lite chips editor import this module; the
 * desktop chips editor keeps a compact mirror, the same way it mirrors the token
 * parser in `prompt-parse.js`.
 */

export const PICK_EXAMPLE = '@PICK{a, b, c} or @PICK(2){a, b, c}';

const TAG_RE = /^@([A-Za-z][\w-]*)/;
const OPENING = '([{<';
const CLOSING = ')]}>';

/** Splits an @PICK body at top level commas (commas inside (), [], {}, <> stay). */
export function splitSyntaxItems(text) {
  const items = [];
  let current = '';
  let depth = 0;

  for (const ch of String(text == null ? '' : text)) {
    if (OPENING.includes(ch)) depth += 1;
    else if (CLOSING.includes(ch)) depth = Math.max(0, depth - 1);

    if (ch === ',' && depth === 0) {
      items.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  items.push(current);
  return items.map((item) => item.trim()).filter(Boolean);
}

function matchBrace(text, open) {
  let depth = 0;
  for (let index = open; index < text.length; index += 1) {
    if (text[index] === '{') depth += 1;
    else if (text[index] === '}') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function invalid(raw, { tag = '', kind = 'pick', error, hint = '' }) {
  return { ok: false, tag, raw, kind, count: 1, items: [], headline: error, details: [hint || `Example: ${PICK_EXAMPLE}`] };
}

/** Trims a long keyword list for the hover hint. */
function keywordPreview(items) {
  const shown = items.slice(0, 8).join(' \u00b7 ');
  return items.length > 8 ? `${shown} \u2026 (+${items.length - 8})` : shown;
}

function validPick(raw, count, items) {
  const total = items.length;
  const drawn = Math.min(Math.max(count, 1), total);
  let headline;
  if (total === 1) {
    headline = 'Random pick \u2014 the group holds a single keyword, so it is used for every image (nothing is drawn).';
  } else if (drawn >= total) {
    headline = `Random pick \u2014 all ${total} keywords are used for every image (nothing is drawn).`;
  } else {
    headline = `Random pick \u2014 ${drawn} of ${total} keywords ${drawn === 1 ? 'is' : 'are'} chosen at random for every image.`;
  }
  return {
    ok: true,
    tag: 'pick',
    raw,
    kind: 'pick',
    count: drawn,
    items,
    headline,
    details: [
      `Keywords: ${keywordPreview(items)}`,
      'Each image draws again (batch count 16 \u2192 16 draws) and the draw follows the image seed.',
    ],
  };
}

/**
 * Grammar-checks one prompt keyword.
 * Returns null when the keyword does not start with '@'.
 */
export function analyzeAtSyntax(body) {
  const raw = String(body == null ? '' : body).trim();
  if (!raw.startsWith('@')) return null;

  const tagMatch = TAG_RE.exec(raw);
  if (!tagMatch) {
    return invalid(raw, { tag: '', error: 'A prompt directive needs a name right after @.' });
  }

  const tag = tagMatch[1];
  if (tag.toLowerCase() !== 'pick') {
    return invalid(raw, {
      tag,
      kind: 'unknown',
      error: `Unknown prompt syntax @${tag}.`,
      hint: `Known syntax: ${PICK_EXAMPLE}`,
    });
  }

  const rest = raw.slice(tagMatch[0].length);
  let bodyStart = rest.search(/\S/);
  bodyStart = bodyStart < 0 ? rest.length : bodyStart;

  let count = 1;
  if (rest[bodyStart] === '(') {
    const close = rest.indexOf(')', bodyStart);
    if (close < 0) {
      return invalid(raw, { tag, error: 'Missing the closing \u201c)\u201d of the pick count.', hint: 'Pick count syntax: @PICK(2){a, b, c}' });
    }
    const countText = rest.slice(bodyStart + 1, close).trim();
    if (!/^\d+$/.test(countText)) {
      return invalid(raw, {
        tag,
        error: countText ? `The pick count \u201c${countText}\u201d is not a whole number.` : 'The pick count is empty \u2014 write a number, for example @PICK(2){a, b, c}.',
      });
    }
    count = parseInt(countText, 10);
    if (count < 1) {
      return invalid(raw, { tag, error: 'The pick count must be 1 or more.' });
    }
    bodyStart = close + 1;
    while (bodyStart < rest.length && /\s/.test(rest[bodyStart])) bodyStart += 1;
  }

  if (rest[bodyStart] !== '{') {
    return invalid(raw, {
      tag,
      error: 'Missing the { \u2026 } keyword list.',
      hint: `Write ${PICK_EXAMPLE}.`,
    });
  }

  const close = matchBrace(rest, bodyStart);
  if (close < 0) {
    return invalid(raw, { tag, error: 'Missing the closing \u201c}\u201d of the keyword list.' });
  }
  if (rest.slice(close + 1).trim()) {
    return invalid(raw, { tag, error: 'Unexpected text after the keyword list.' });
  }

  const items = splitSyntaxItems(rest.slice(bodyStart + 1, close));
  if (!items.length) {
    return invalid(raw, { tag, error: 'The keyword list is empty \u2014 separate keywords with commas.' });
  }

  return validPick(raw, count, items);
}

/** Plain-text hover hint (what the chip `title` shows). */
export function syntaxHint(syntax, fallback = '') {
  if (!syntax) return fallback;
  return [syntax.headline, ...syntax.details].filter(Boolean).join('\n');
}
