/**
 * Prompt syntax — grammar checks, highlight classes and hover hints.
 *
 * `@` directives — every keyword that starts with `@` is a directive:
 *
 *   @PICK{a, b, c}      draw 1 keyword at random for every image
 *   @PICK(2){a, b, c}   draw 2 keywords at random for every image
 *   @PICK(2){
 *     red,
 *     blue
 *   }                   keyword lists may span multiple lines
 *
 * `#` directives — a line of its own switches text per generation stage:
 *
 *   #if TXT2IMG
 *   lowres detail
 *   #elseif HIRES_FIX
 *   highres detail
 *   #else
 *   other passes
 *   #endif
 *
 * The macros are TXT2IMG, HIRES_FIX, IMG2IMG, INPAINT, POSE_INPAINT (1 while
 * that stage runs, 0 otherwise; HIRES_FIX is an img2img pass so IMG2IMG is 1 as
 * well, POSE_INPAINT an inpaint pass so INPAINT is 1 too) and POSE_INPAINT_PART
 * (0 outside a pose pass, FACE / FEET / HANDS inside one).
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
 * `analyzeConditionLine(line)` / `analyzeConditionLines(text)` do the same for
 * the `#` directives: one line at a time, and the whole prompt so a missing
 * `#endif` or a stray `#else` is reported on the line that caused it.
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

/* --------------------------------------------------------------- #if blocks */

/** Macro name -> what it is while a generation runs (mirror of the backend). */
export const CONDITION_MACROS = {
  TXT2IMG: '1 during the txt2img first pass',
  HIRES_FIX: '1 during the Hires. fix pass (an img2img pass, so IMG2IMG is 1 too)',
  IMG2IMG: '1 during img2img, Hires. fix and inpaint',
  INPAINT: '1 during inpaint and pose inpaint',
  POSE_INPAINT: '1 during a pose inpaint pass (an inpaint pass, so INPAINT is 1 too)',
  POSE_INPAINT_PART: 'the pose pass part: 0 (none), FACE, FEET or HANDS',
};
export const CONDITION_MACRO_NAMES = Object.keys(CONDITION_MACROS);
export const CONDITION_EXAMPLE = '#if TXT2IMG … #endif';

const DIRECTIVE_RE = /^[ \t]*#(if|elif|elseif|else|endif)(?![A-Za-z0-9_])(.*)$/i;
// one token per call; the trailing "y" flag keeps the scan position explicit
const CONDITION_TOKEN_RE = /[ \t]*(?:(!=|==|&&|\|\||[!()])|([A-Za-z_][A-Za-z0-9_]*)|(-?\d+(?:\.\d+)?)|(\S))/y;

/** True when the line is a standalone `#if` / `#elseif` / `#else` / `#endif` directive. */
export function isConditionLine(text) {
  return DIRECTIVE_RE.test(String(text == null ? '' : text));
}

function conditionTokens(expression) {
  const tokens = [];
  let index = 0;
  while (index < expression.length) {
    CONDITION_TOKEN_RE.lastIndex = index;
    const match = CONDITION_TOKEN_RE.exec(expression);
    if (!match) return null;
    if (match[1]) tokens.push({ type: 'op', value: match[1] });
    else if (match[2]) tokens.push({ type: 'word', value: match[2] });
    else if (match[3]) tokens.push({ type: 'number', value: match[3] });
    else return null;
    index = CONDITION_TOKEN_RE.lastIndex;
  }
  return tokens;
}

/**
 * Validates a `#if` / `#elseif` condition.
 * Returns `{ ok, macros, error }`; `macros` lists the referenced macro names.
 */
export function parseCondition(expression) {
  const text = String(expression == null ? '' : expression).trim();
  const macros = [];
  const tokens = conditionTokens(text);
  if (!text) return { ok: false, macros, error: 'The condition is empty.' };
  if (!tokens) return { ok: false, macros, error: `The condition \u201c${text}\u201d is not valid.` };

  let index = 0;
  const peek = () => tokens[index];
  const fail = (message) => { throw new Error(message); };
  const atOperator = (...values) => {
    const token = peek();
    return !!token && token.type === 'op' && values.includes(token.value);
  };
  const atWord = (value) => {
    const token = peek();
    return !!token && token.type === 'word' && token.value.toLowerCase() === value;
  };

  function primary() {
    if (atOperator('!')) {
      index += 1;
      primary();
      return;
    }
    if (atOperator('(')) {
      index += 1;
      orExpression();
      if (!atOperator(')')) fail('Missing the closing \u201c)\u201d of the group.');
      index += 1;
      return;
    }
    const token = peek();
    if (!token) fail('The condition is incomplete.');
    if (token.type !== 'word') fail(`Unexpected \u201c${token.value}\u201d in the condition.`);
    const name = token.value.toUpperCase();
    if (!Object.prototype.hasOwnProperty.call(CONDITION_MACROS, name)) fail(`Unknown macro ${token.value}.`);
    if (!macros.includes(name)) macros.push(name);
    index += 1;
    if (atOperator('==', '!=')) {
      index += 1;
      const value = peek();
      if (!value || (value.type !== 'word' && value.type !== 'number')) fail('Missing the value to compare with.');
      index += 1;
    }
  }

  function andExpression() {
    primary();
    while (atOperator('&&') || atWord('and')) {
      index += 1;
      primary();
    }
  }

  function orExpression() {
    andExpression();
    while (atOperator('||') || atWord('or')) {
      index += 1;
      andExpression();
    }
  }

  try {
    orExpression();
    if (index !== tokens.length) fail(`Unexpected \u201c${tokens[index].value}\u201d in the condition.`);
  } catch (error) {
    return { ok: false, macros, error: error.message };
  }
  return { ok: true, macros, error: '' };
}

function conditionError(info, message, hint) {
  return { ...info, ok: false, headline: message, details: [hint, ...info.details].filter(Boolean) };
}

/**
 * Grammar-checks one line.  Returns null when the line is not a `#if` block
 * directive, otherwise `{ ok, keyword, expression, macros, headline, details }`.
 * `keyword` is 'if' | 'elseif' | 'else' | 'endif' ('#elif' is accepted as well).
 */
export function analyzeConditionLine(line) {
  const raw = String(line == null ? '' : line);
  const match = DIRECTIVE_RE.exec(raw);
  if (!match) return null;

  const typed = match[1].toLowerCase();
  const keyword = typed === 'elif' ? 'elseif' : typed;
  const expression = match[2].trim();
  const info = {
    ok: true,
    kind: 'condition',
    tag: '#' + keyword,
    keyword,
    raw: raw.trim(),
    expression,
    macros: [],
    headline: '',
    details: [],
  };

  if (keyword === 'else' || keyword === 'endif') {
    if (expression) {
      return conditionError(info, `Unexpected text after #${keyword}.`, `Write #${keyword} on its own line.`);
    }
    info.headline = keyword === 'else'
      ? 'Otherwise branch \u2014 used when no earlier branch of the #if block matched.'
      : 'Ends the #if block.';
    info.details = [CONDITION_EXAMPLE];
    return info;
  }

  if (!expression) {
    return conditionError(info, `Missing the condition after #${keyword}.`, `Example: ${CONDITION_EXAMPLE}`);
  }

  const parsed = parseCondition(expression);
  info.macros = parsed.macros;
  if (!parsed.ok) {
    return conditionError(info, parsed.error, `Known macros: ${CONDITION_MACRO_NAMES.join(', ')}`);
  }

  info.headline = `Conditional block \u2014 the text below is used only while ${expression} is true.`;
  info.details = parsed.macros.map((name) => `${name} is ${CONDITION_MACROS[name]}`);
  return info;
}

/** Enum values of POSE_INPAINT_PART, in the order the dropdown offers them. */
export const CONDITION_PART_VALUES = ['FACE', 'FEET', 'HANDS', '0', 'NONE'];

const CONDITION_HEAD_RE = /^[ \t]*#(if|elif|elseif)(?![A-Za-z0-9_])(.*)$/i;
// the enum / boolean values only show once the space after '==' / '!=' is typed
const CONDITION_VALUE_RE = /([A-Za-z_][A-Za-z0-9_]*)[ \t]*(==|!=)[ \t]+$/;
// an operator typed without its trailing space: stay quiet until the space arrives
const CONDITION_OPERATOR_TAIL_RE = /(==|!=|&&|\|\|)$/;

/**
 * Inline completions for a `#if` / `#elseif` condition.
 *
 * `before` is the text of the current line up to the caret.  Returns null when the
 * line is not a condition, otherwise `{ from, options, macro }`:
 *   - after `POSE_INPAINT_PART == ` / `!= ` (space included): the enum values
 *     (FACE / FEET / HANDS / 0 / NONE), or `1` / `0` for the other macros;
 *   - anywhere else in the expression: the macro names.
 * The list only opens once the space after `#if` / `#elseif` is typed, and it stays
 * quiet right after an operator until that operator's space arrives.  `from` is the
 * offset of the fragment being replaced, `options` carry the `label` and the `detail`
 * the dropdown shows; the list is filtered by what is typed.
 */
export function conditionCompletions(before) {
  const text = String(before == null ? '' : before);
  const head = CONDITION_HEAD_RE.exec(text);
  if (!head) return null;

  const rest = head[2];
  // the dropdown opens on '#if ' / '#elseif ', not while the directive is still '#if'
  if (!/^[ \t]/.test(rest)) return { from: text.length, options: [], macro: '' };

  const fragment = /[A-Za-z_][A-Za-z0-9_]*$/.exec(rest);
  const typedText = fragment ? fragment[0] : '';
  const from = text.length - typedText.length;
  const upToFragment = rest.slice(0, rest.length - typedText.length);
  const typed = typedText.toUpperCase();

  // value position: '#if POSE_INPAINT_PART == ' / '#elseif TXT2IMG != 1'
  const comparison = CONDITION_VALUE_RE.exec(upToFragment);
  if (comparison) {
    const macro = comparison[1].toUpperCase();
    const values = macro === 'POSE_INPAINT_PART' ? CONDITION_PART_VALUES : ['1', '0'];
    const options = values
      .filter((value) => !typed || value.startsWith(typed))
      .map((value) => ({
        label: value,
        detail: macro === 'POSE_INPAINT_PART'
          ? (value === '0' || value === 'NONE' ? 'no pose part (every other stage)' : `${value.toLowerCase()} pose pass`)
          : (value === '1' ? 'true while the stage runs' : 'false'),
      }));
    return { from, options, macro };
  }

  // '… ==' / '… &&' typed but not the space yet: keep the dropdown closed
  if (CONDITION_OPERATOR_TAIL_RE.test(upToFragment)) return { from, options: [], macro: '' };

  const options = CONDITION_MACRO_NAMES
    .filter((name) => !typed || name.startsWith(typed))
    .map((name) => ({ label: name, detail: CONDITION_MACROS[name] }));
  return { from, options, macro: '' };
}

/**
 * Validates every `#if` block of the prompt.
 * Returns one entry per line, `null` for ordinary lines; structural mistakes
 * (missing `#endif`, stray `#else`, a second `#else`) mark the line that caused them.
 */
export function analyzeConditionLines(text) {
  const lines = String(text == null ? '' : text).split('\n');
  const results = lines.map((line) => analyzeConditionLine(line));
  const stack = [];

  results.forEach((info, index) => {
    if (!info) return;

    // the nesting is tracked even for a broken line, so one bad condition does not
    // cascade into "dangling #endif" reports on every line after it
    if (info.keyword === 'if') {
      stack.push({ index, seenElse: false });
      return;
    }

    const frame = stack[stack.length - 1];
    const report = (message, hint) => {
      if (info.ok) results[index] = conditionError(info, message, hint);
    };

    if (info.keyword === 'elseif') {
      if (!frame) report('#elseif without an #if.', 'Add a #if above it.');
      else if (frame.seenElse) report('This #if already has an #else branch.', 'Move this #elseif above the #else.');
      return;
    }
    if (info.keyword === 'else') {
      if (!frame) report('#else without an #if.', 'Add a #if above it.');
      else if (frame.seenElse) report('This #if already has an #else branch.', 'Only one #else is allowed per #if.');
      else frame.seenElse = true;
      return;
    }
    if (info.keyword === 'endif') {
      if (!frame) report('#endif without an #if.', 'Remove it, or add the matching #if.');
      else stack.pop();
    }
  });

  stack.forEach((frame) => {
    // a broken condition on that line is the better message - do not hide it
    if (results[frame.index].ok) {
      results[frame.index] = conditionError(results[frame.index], 'Missing #endif \u2014 this #if is never closed.', `Example: ${CONDITION_EXAMPLE}`);
    }
  });

  return results;
}
