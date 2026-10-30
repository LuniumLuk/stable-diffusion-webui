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
 * `@` custom macros — a line of its own declares a macro used by conditions:
 *
 *   @MACRO(FLAG)                 boolean macro, off by default
 *   @MACRO(MOOD){happy, sad}     enum macro, first alias by default
 *
 * `@` block directives — a line of its own switches text per generation stage:
 *
 *   @IF TXT2IMG
 *   lowres detail
 *   @ELSEIF HIRES_FIX
 *   highres detail
 *   @ELSE
 *   other passes
 *   @ENDIF
 *
 * The macros are TXT2IMG, HIRES_FIX, IMG2IMG, INPAINT, POSE_INPAINT (1 while
 * that stage runs, 0 otherwise; HIRES_FIX is an img2img pass so IMG2IMG is 1 as
 * well, POSE_INPAINT an inpaint pass so INPAINT is 1 too) and POSE_INPAINT_PART
 * (0 outside a pose pass, FACE / FEET / HANDS inside one).  `#` stays reserved
 * for comments and disabled keyword groups.
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
 * the `@IF` block directives: one line at a time, and the whole prompt so a
 * missing `@ENDIF` or a stray `@ELSE` is reported on the line that caused it.
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

/* --------------------------------------------------------------- @MACRO blocks */

const MACRO_HEAD_RE = /^[ \t]*@macro(?![A-Za-z0-9_])/i;
const MACRO_DEFINITION_RE = /^[ \t]*@macro[ \t]*\([ \t]*([A-Za-z_][A-Za-z0-9_]*)[ \t]*\)[ \t]*(\{[^\n]*\})?[ \t]*$/i;

/**
 * Grammar-checks one `@MACRO(name)` / `@MACRO(name){a, b, c}` line.
 * Returns null for an ordinary line; a malformed `@MACRO…` line returns an
 * `{ ok: false }` entry instead of falling through to the unknown-@ error.
 */
export function analyzeMacroLine(line) {
  const raw = String(line == null ? '' : line);
  if (!MACRO_HEAD_RE.test(raw)) return null;

  const match = MACRO_DEFINITION_RE.exec(raw);
  if (!match) {
    return {
      ok: false,
      kind: 'macro',
      tag: '@MACRO',
      name: '',
      key: '',
      macroType: 'bool',
      values: [],
      defaultValue: 0,
      raw: raw.trim(),
      headline: 'Malformed custom macro definition.',
      details: ['Write @MACRO(name) for a boolean macro or @MACRO(name){a, b, c} for an enum.'],
    };
  }

  const name = match[1];
  const rawValues = match[2];
  const values = rawValues ? [...new Set(splitSyntaxItems(rawValues.slice(1, -1)))] : [];
  if (rawValues && !values.length) {
    return {
      ok: false,
      kind: 'macro',
      tag: '@MACRO',
      name,
      key: name.toUpperCase(),
      macroType: 'enum',
      values: [],
      defaultValue: 0,
      raw: raw.trim(),
      headline: 'The custom macro has no enum values.',
      details: ['Write at least one value: @MACRO(name){a, b, c}.'],
    };
  }

  const macroType = rawValues ? 'enum' : 'bool';
  const defaultValue = macroType === 'enum' ? values[0] : 0;
  return {
    ok: true,
    kind: 'macro',
    tag: '@MACRO',
    name,
    key: name.toUpperCase(),
    macroType,
    values,
    defaultValue,
    raw: raw.trim(),
    headline: macroType === 'enum'
      ? `Defines the enum macro ${name} (${values.join(', ')}); the first value is selected by default.`
      : `Defines the boolean macro ${name} (off by default).`,
    details: ['Use it in conditions: @IF ' + name + (macroType === 'enum' ? ' == ' + values[0] : '') + '.'],
  };
}

/** True for any @MACRO line, valid or not (so it is not treated as an @PICK). */
export function isMacroLine(text) {
  return MACRO_HEAD_RE.test(String(text == null ? '' : text));
}

/** Valid custom macro definitions of a prompt, keyed by upper-case name. */
export function parseMacroDefinitions(text) {
  const definitions = {};
  const source = String(text == null ? '' : text);
  if (!source.includes('@')) return definitions;
  for (const line of source.split('\n')) {
    const info = analyzeMacroLine(line);
    if (info && info.ok) definitions[info.key] = info;
  }
  return definitions;
}

/** Upper-case names referenced by @IF / @ELSEIF expressions (system names included). */
export function parseMacroReferences(text) {
  const names = new Set();
  const source = String(text == null ? '' : text);
  for (const line of source.split('\n')) {
    const match = DIRECTIVE_RE.exec(line);
    if (!match) continue;
    const keyword = match[1].toLowerCase();
    if (keyword === 'else' || keyword === 'endif') continue;
    const tokens = conditionTokens(match[2].trim());
    if (!tokens) continue;
    let comparison = false;
    for (const token of tokens) {
      if (token.type === 'op') {
        if (token.value === '==' || token.value === '!=') comparison = true;
        else comparison = false;
        continue;
      }
      if (token.type === 'word') {
        const word = token.value.toLowerCase();
        if (word === 'and' || word === 'or') {
          comparison = false;
          continue;
        }
        if (!comparison) names.add(token.value.toUpperCase());
        comparison = false;
        continue;
      }
      comparison = false;
    }
  }
  return names;
}

export const SYSTEM_MACRO_NAMES = ['TXT2IMG', 'HIRES_FIX', 'IMG2IMG', 'INPAINT', 'POSE_INPAINT', 'POSE_INPAINT_PART'];

/** Fixed stage macro values (mirror of prompt_parser.stage_macros). */
export function stageMacros(stage) {
  const values = {};
  for (const name of SYSTEM_MACRO_NAMES) values[name] = 0;
  const name = String(stage || '').toLowerCase();
  if (name === 'txt2img') values.TXT2IMG = 1;
  else if (name === 'hires_fix') { values.HIRES_FIX = 1; values.IMG2IMG = 1; }
  else if (name === 'img2img') values.IMG2IMG = 1;
  else if (name === 'inpaint') { values.INPAINT = 1; values.IMG2IMG = 1; }
  else if (name === 'pose_inpaint') { values.POSE_INPAINT = 1; values.INPAINT = 1; values.IMG2IMG = 1; }
  values.POSE_INPAINT_PART = 0;
  return values;
}

function macroBool(value) {
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'number') return value ? 1 : 0;
  return ['1', 'true', 'on', 'yes'].includes(String(value == null ? '' : value).trim().toLowerCase()) ? 1 : 0;
}

/**
 * Definitions, references and resolved values for one prompt/editor.
 * `customValues` is the macro editor state (`{name: 0|1|alias}`).
 */
export function macroState(text, stage = 'txt2img', customValues = {}) {
  const source = String(text == null ? '' : text);
  const definitions = parseMacroDefinitions(source);
  const references = parseMacroReferences(source);
  const macros = stageMacros(stage);
  const selected = {};
  for (const [key, value] of Object.entries(customValues || {})) selected[key.toUpperCase()] = value;

  const keys = new Set([...Object.keys(definitions), ...references]);
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(macros, key)) continue;
    const definition = definitions[key];
    if (definition && definition.macroType === 'enum') {
      const chosen = String(selected[key] == null ? '' : selected[key]).trim().toUpperCase();
      const picked = definition.values.find((value) => value.toUpperCase() === chosen);
      macros[key] = picked == null ? definition.defaultValue : picked;
    } else {
      macros[key] = macroBool(selected[key] == null ? 0 : selected[key]);
    }
  }
  return { definitions, references, macros };
}

/** Comparable form of a macro value / literal (NONE and 0 are the same). */
function comparable(value) {
  if (typeof value === 'number') return ['num', value];
  if (typeof value === 'boolean') return ['num', value ? 1 : 0];
  const text = String(value == null ? '' : value).trim().toUpperCase();
  if (['', '0', 'NONE', 'FALSE', 'OFF'].includes(text)) return ['num', 0];
  if (/^-?\d+$/.test(text)) return ['num', parseInt(text, 10)];
  return ['text', text];
}

function truthy(value) {
  const [kind, result] = comparable(value);
  return !(kind === 'num' && result === 0);
}

/** Evaluates an @IF / @ELSEIF expression (broken expressions are false). */
export function evaluateCondition(expression, macros = {}) {
  const tokens = conditionTokens(String(expression == null ? '' : expression).trim());
  if (!tokens) return false;
  let index = 0;
  const peek = () => tokens[index];
  const atOperator = (...values) => {
    const token = peek();
    return !!token && token.type === 'op' && values.includes(token.value);
  };
  const atWord = (value) => {
    const token = peek();
    return !!token && token.type === 'word' && token.value.toLowerCase() === value;
  };
  let failed = false;

  function primary() {
    if (failed) return false;
    if (atOperator('!')) {
      index += 1;
      return !primary();
    }
    if (atOperator('(')) {
      index += 1;
      const result = orExpression();
      if (!atOperator(')')) {
        failed = true;
        return false;
      }
      index += 1;
      return result;
    }
    const token = peek();
    if (!token || token.type !== 'word') {
      failed = true;
      return false;
    }
    const name = token.value.toUpperCase();
    const left = Object.prototype.hasOwnProperty.call(macros, name) ? macros[name] : 0;
    index += 1;
    if (atOperator('==', '!=')) {
      const operator = peek().value;
      index += 1;
      const value = peek();
      if (!value || (value.type !== 'word' && value.type !== 'number')) {
        failed = true;
        return false;
      }
      index += 1;
      const equal = comparable(left).join('\u0000') === comparable(value.value).join('\u0000');
      return operator === '!=' ? !equal : equal;
    }
    return truthy(left);
  }

  function andExpression() {
    let result = primary();
    while (!failed && (atOperator('&&') || atWord('and'))) {
      index += 1;
      const right = primary();
      result = result && right;
    }
    return result;
  }

  function orExpression() {
    let result = andExpression();
    while (!failed && (atOperator('||') || atWord('or'))) {
      index += 1;
      const right = andExpression();
      result = result || right;
    }
    return result;
  }

  const result = orExpression();
  if (failed || index !== tokens.length) return false;
  return !!result;
}

/**
 * 0-based line indexes whose branch is inactive for `macros`.
 * A malformed/unclosed block disables dimming, matching the backend's
 * "leave the prompt as typed" behaviour.
 */
export function inactiveConditionLines(text, macros = {}) {
  const source = String(text == null ? '' : text);
  const lines = source.split('\n');
  const inactive = new Set();
  const stack = [];
  let broken = false;
  const isActive = () => stack.every((frame) => frame.active);

  lines.forEach((lineText, index) => {
    const match = DIRECTIVE_RE.exec(lineText);
    if (!match) {
      if (!isActive()) inactive.add(index);
      return;
    }

    const keyword = match[1].toLowerCase() === 'elif' ? 'elseif' : match[1].toLowerCase();
    const expression = match[2].trim();
    if (keyword === 'if') {
      const parent = isActive();
      if (!parent) inactive.add(index);
      const take = evaluateCondition(expression, macros);
      stack.push({ parent, taken: take, active: parent && take, else: false });
      return;
    }
    if (!stack.length) {
      broken = true;
      return;
    }

    const frame = stack[stack.length - 1];
    if (!frame.parent) inactive.add(index);

    if (keyword === 'elseif') {
      if (frame.else) {
        broken = true;
        return;
      }
      if (frame.taken || !frame.parent) {
        frame.active = false;
      } else {
        const take = evaluateCondition(expression, macros);
        frame.active = frame.parent && take;
        frame.taken = frame.taken || take;
      }
      return;
    }
    if (keyword === 'else') {
      if (frame.else) {
        broken = true;
        return;
      }
      frame.else = true;
      frame.active = frame.parent && !frame.taken;
      frame.taken = true;
      return;
    }
    stack.pop();
  });

  if (broken || stack.length) return new Set();
  return inactive;
}

/* --------------------------------------------------------------- @IF blocks */

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
export const CONDITION_EXAMPLE = '@IF TXT2IMG … @ENDIF';

const DIRECTIVE_RE = /^[ \t]*@(if|elif|elseif|else|endif)(?![A-Za-z0-9_])(.*)$/i;
// one token per call; the trailing "y" flag keeps the scan position explicit
const CONDITION_TOKEN_RE = /[ \t]*(?:(!=|==|&&|\|\||[!()])|([A-Za-z_][A-Za-z0-9_]*)|(-?\d+(?:\.\d+)?)|(\S))/y;

/** '@IF' / '@ELSEIF' / '@ELSE' / '@ENDIF' for an internal keyword ('if', ...). */
function directiveLabel(keyword) {
  return '@' + keyword.toUpperCase();
}

/** True when the line is a standalone `@IF` / `@ELSEIF` / `@ELSE` / `@ENDIF` directive. */
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
 * Validates an `@IF` / `@ELSEIF` condition.
 * Returns `{ ok, macros, error }`; `macros` lists the referenced macro names.
 * Any name that is not a system macro is accepted as a boolean macro, so user
 * macros do not need a definition and a typo simply evaluates to false.
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
 * Grammar-checks one line.  Returns null when the line is not an `@IF` block
 * directive, otherwise `{ ok, keyword, expression, macros, headline, details }`.
 * `keyword` is 'if' | 'elseif' | 'else' | 'endif' ('@ELIF' is accepted as well).
 */
export function analyzeConditionLine(line, definitions = {}) {
  const raw = String(line == null ? '' : line);
  const match = DIRECTIVE_RE.exec(raw);
  if (!match) return null;

  const typed = match[1].toLowerCase();
  const keyword = typed === 'elif' ? 'elseif' : typed;
  const label = directiveLabel(keyword);
  const expression = match[2].trim();
  const info = {
    ok: true,
    kind: 'condition',
    tag: label,
    keyword,
    raw: raw.trim(),
    expression,
    macros: [],
    headline: '',
    details: [],
  };

  if (keyword === 'else' || keyword === 'endif') {
    if (expression) {
      return conditionError(info, `Unexpected text after ${label}.`, `Write ${label} on its own line.`);
    }
    info.headline = keyword === 'else'
      ? 'Otherwise branch \u2014 used when no earlier branch of the @IF block matched.'
      : 'Ends the @IF block.';
    info.details = [CONDITION_EXAMPLE];
    return info;
  }

  if (!expression) {
    return conditionError(info, `Missing the condition after ${label}.`, `Example: ${CONDITION_EXAMPLE}`);
  }

  const parsed = parseCondition(expression);
  info.macros = parsed.macros;
  if (!parsed.ok) {
    return conditionError(info, parsed.error, `Known macros: ${CONDITION_MACRO_NAMES.join(', ')}`);
  }

  info.headline = `Conditional block \u2014 the text below is used only while ${expression} is true.`;
  info.details = parsed.macros.map((name) => macroDetail(name, definitions));
  return info;
}

function macroDetail(name, definitions = {}) {
  if (Object.prototype.hasOwnProperty.call(CONDITION_MACROS, name)) return `${name} is ${CONDITION_MACROS[name]}`;
  const definition = definitions[name];
  if (definition && definition.macroType === 'enum') return `${name} is a custom enum macro (${definition.values.join(', ')})`;
  if (definition) return `${name} is a custom boolean macro (off by default)`;
  return `${name} is an undeclared boolean macro (off by default; add @MACRO(${name}) to declare it)`;
}

/** Enum values of POSE_INPAINT_PART, in the order the dropdown offers them. */
export const CONDITION_PART_VALUES = ['FACE', 'FEET', 'HANDS', '0', 'NONE'];

const CONDITION_HEAD_RE = /^[ \t]*@(if|elif|elseif)(?![A-Za-z0-9_])(.*)$/i;
// the enum / boolean values only show once the space after '==' / '!=' is typed
const CONDITION_VALUE_RE = /([A-Za-z_][A-Za-z0-9_]*)[ \t]*(==|!=)[ \t]+$/;
// an operator typed without its trailing space: stay quiet until the space arrives
const CONDITION_OPERATOR_TAIL_RE = /(==|!=|&&|\|\|)$/;

/**
 * Inline completions for an `@IF` / `@ELSEIF` condition.
 *
 * `before` is the text of the current line up to the caret.  Returns null when the
 * line is not a condition, otherwise `{ from, options, macro }`:
 *   - after `POSE_INPAINT_PART == ` / `!= ` (space included): the enum values
 *     (FACE / FEET / HANDS / 0 / NONE), or `1` / `0` for the other macros;
 *   - anywhere else in the expression: the macro names.
 * The list only opens once the space after `@IF` / `@ELSEIF` is typed, and it stays
 * quiet right after an operator until that operator's space arrives.  `from` is the
 * offset of the fragment being replaced, `options` carry the `label` and the `detail`
 * the dropdown shows; the list is filtered by what is typed.
 *
 * `definitions` / `references` come from the whole prompt (`parseMacroDefinitions`
 * / `parseMacroReferences`), so user macros and their enum aliases complete live.
 */
export function conditionCompletions(before, definitions = {}, references = new Set()) {
  const text = String(before == null ? '' : before);
  const head = CONDITION_HEAD_RE.exec(text);
  if (!head) return null;

  const rest = head[2];
  // the dropdown opens on '@IF ' / '@ELSEIF ', not while the directive is still '@IF'
  if (!/^[ \t]/.test(rest)) return { from: text.length, options: [], macro: '' };

  const fragment = /[A-Za-z_][A-Za-z0-9_]*$/.exec(rest);
  const typedText = fragment ? fragment[0] : '';
  const from = text.length - typedText.length;
  const upToFragment = rest.slice(0, rest.length - typedText.length);
  const typed = typedText.toUpperCase();

  // value position: '@IF POSE_INPAINT_PART == ' / '@ELSEIF TXT2IMG != 1'
  const comparison = CONDITION_VALUE_RE.exec(upToFragment);
  if (comparison) {
    const macro = comparison[1].toUpperCase();
    const definition = definitions[macro];
    const values = definition && definition.macroType === 'enum'
      ? definition.values
      : (macro === 'POSE_INPAINT_PART' ? CONDITION_PART_VALUES : ['1', '0']);
    const options = values
      .filter((value) => !typed || value.toUpperCase().startsWith(typed))
      .map((value) => ({
        label: value,
        detail: definition && definition.macroType === 'enum'
          ? `${macro} enum value`
          : (macro === 'POSE_INPAINT_PART'
            ? (value === '0' || value === 'NONE' ? 'no pose part (every other stage)' : `${value.toLowerCase()} pose pass`)
            : (value === '1' ? 'true while the stage runs' : 'false')),
      }));
    return { from, options, macro };
  }

  // '… ==' / '… &&' typed but not the space yet: keep the dropdown closed
  if (CONDITION_OPERATOR_TAIL_RE.test(upToFragment)) return { from, options: [], macro: '' };

  const names = [...CONDITION_MACRO_NAMES, ...Object.keys(definitions)];
  for (const reference of references || []) names.push(reference);
  const unique = [...new Set(names)];
  const options = unique
    .filter((name) => !typed || name.startsWith(typed))
    .map((name) => ({ label: name, detail: macroDetail(name, definitions) }));
  return { from, options, macro: '' };
}

/**
 * Validates every `@IF` block of the prompt.
 * Returns one entry per line, `null` for ordinary lines; structural mistakes
 * (missing `@ENDIF`, stray `@ELSE`, a second `@ELSE`) mark the line that caused them.
 */
export function analyzeConditionLines(text) {
  const definitions = parseMacroDefinitions(text);
  const lines = String(text == null ? '' : text).split('\n');
  const results = lines.map((line) => analyzeConditionLine(line, definitions));
  const stack = [];

  results.forEach((info, index) => {
    if (!info) return;

    // the nesting is tracked even for a broken line, so one bad condition does not
    // cascade into "dangling @ENDIF" reports on every line after it
    if (info.keyword === 'if') {
      stack.push({ index, seenElse: false });
      return;
    }

    const frame = stack[stack.length - 1];
    const report = (message, hint) => {
      if (info.ok) results[index] = conditionError(info, message, hint);
    };

    if (info.keyword === 'elseif') {
      if (!frame) report('@ELSEIF without an @IF.', 'Add an @IF above it.');
      else if (frame.seenElse) report('This @IF already has an @ELSE branch.', 'Move this @ELSEIF above the @ELSE.');
      return;
    }
    if (info.keyword === 'else') {
      if (!frame) report('@ELSE without an @IF.', 'Add an @IF above it.');
      else if (frame.seenElse) report('This @IF already has an @ELSE branch.', 'Only one @ELSE is allowed per @IF.');
      else frame.seenElse = true;
      return;
    }
    if (info.keyword === 'endif') {
      if (!frame) report('@ENDIF without an @IF.', 'Remove it, or add the matching @IF.');
      else stack.pop();
    }
  });

  stack.forEach((frame) => {
    // a broken condition on that line is the better message - do not hide it
    if (results[frame.index].ok) {
      results[frame.index] = conditionError(results[frame.index], 'Missing @ENDIF \u2014 this @IF is never closed.', `Example: ${CONDITION_EXAMPLE}`);
    }
  });

  return results;
}
