/**
 * Native prompt editor for txt2img / img2img (and the Qwen-Image 2.1 tab).
 *
 * Replaces the pile of textarea overlays (highlight backdrop, keyboard-only
 * weight editing, suggestion dropdown) with a chip editor built for touch:
 *
 *   - text is parsed into keyword chips (top-level commas separate them);
 *   - tap a chip          -> selects it and opens the action bar
 *   - action bar          -> weight -/+ (and quick values), disable, duplicate,
 *                            delete  (no keyboard needed)
 *   - gutter button (💬)  -> comment / uncomment the whole line (the Python
 *                            pipeline strips '#' comment lines)
 *   - ⛔ on a chip        -> wraps the keyword as  #(keyword)  - a *disabled*
 *                            inline group the backend strips just like a comment
 *   - `@IF MACRO` lines   -> stage conditions (TXT2IMG / HIRES_FIX / IMG2IMG /
 *                            INPAINT / POSE_INPAINT / POSE_INPAINT_PART, custom
 *                            @MACRO names) whose text reaches the model only while
 *                            the condition holds; inactive branches are dimmed
 *   - ＋ keyword          -> inline input with suggestions from the endorsed
 *                            keyword pool and the installed extra networks
 *   - [⌨ Text] button     -> switches back to the classic textarea (the
 *                            original overlay features keep working there)
 *
 * The gradio textarea stays the single source of truth: every edit rewrites
 * `textarea.value` and dispatches input/change, so token counters, presets,
 * extra-network insertion, styles, paste and the generate payload all keep
 * working unchanged.
 */
(function () {
    'use strict';

    const HOST_IDS = ['txt2img_prompt', 'txt2img_neg_prompt', 'img2img_prompt', 'img2img_neg_prompt', 'qwen_prompt', 'qwen_neg_prompt', 'krea2_prompt', 'krea2_neg_prompt', 'video_prompt', 'video_neg_prompt'];
    const LS_MODE = 'pedit.mode';           // 'chips' | 'text'
    const LS_STEP = 'pedit.step';           // weight step, default '0.05'
    const LS_RECENT = 'pedit.recent';       // MRU keyword list (JSON array)
    const MAX_SUGGEST = 14;
    const DEFAULT_WEIGHT = 1.0;

    // ── tiny helpers ────────────────────────────────────────────────────────

    function readLS(key, fallback) {
        try {
            const v = window.localStorage ? window.localStorage.getItem(key) : null;
            return v === null || v === undefined ? fallback : v;
        } catch (e) {
            return fallback;
        }
    }

    function writeLS(key, value) {
        try {
            window.localStorage && window.localStorage.setItem(key, String(value));
        } catch (e) {
            /* ignore */
        }
    }

    function escapeHtml(str) {
        return String(str == null ? '' : str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function clamp(v, lo, hi) {
        return Math.max(lo, Math.min(v, hi));
    }

    function formatWeight(w) {
        const rounded = Math.round(w * 1000) / 1000;
        // A1111 writes weights with a decimal part; "1" would be parsed as integer 1 fine,
        // but "1.0" is what the console/API users expect to see.
        return Number.isInteger(rounded) ? rounded + '.0' : String(rounded);
    }

    // ── token model ─────────────────────────────────────────────────────────
    //
    // A line is split into segments at *top level* commas (commas inside
    // (), [], <>, or an @PICK{...} group are not separators).  Each segment
    // keeps its raw text (lead + body + tail) so an untouched line
    // re-serialises byte-identically.

    function splitSegments(line) {
        const segs = [];
        let lead = '';
        let body = '';
        let depth = 0;
        let i = 0;

        // leading whitespace belongs to `lead`
        while (i < line.length && /\s/.test(line[i])) lead += line[i++];
        // an empty line (or only whitespace) is a single empty segment
        if (i >= line.length) return [{ lead: lead, body: '', tail: '' }];

        for (; i < line.length; i++) {
            const ch = line[i];
            if (ch === '(' || ch === '[' || ch === '<' || ch === '{') depth++;
            else if (ch === ')' || ch === ']' || ch === '>' || ch === '}') depth = Math.max(0, depth - 1);

            if (ch === ',' && depth === 0) {
                let tail = ',';
                i++;
                while (i < line.length && /\s/.test(line[i])) tail += line[i++];
                i--;
                segs.push({ lead: lead, body: body, tail: tail });
                lead = '';
                body = '';
                continue;
            }
            body += ch;
        }
        segs.push({ lead: lead, body: body, tail: '' });
        return segs;
    }

    function joinSegments(segs) {
        return segs.map((s) => s.lead + s.body + s.tail).join('');
    }

    /** Effective weight of an A1111 style chunk: (x:W) [x] ((x)) <lora:x:W>. */
    function colonWeight(inner) {
        // find the last ':' that is not inside nested parens
        let depth = 0;
        for (let i = inner.length - 1; i >= 0; i--) {
            const ch = inner[i];
            if (ch === ')' || ch === ']' || ch === '>') depth++;
            else if (ch === '(' || ch === '[' || ch === '<') depth--;
            else if (ch === ':' && depth === 0) {
                const w = parseFloat(inner.slice(i + 1));
                if (!isNaN(w) && /^\s*-?[\d.]+\s*$/.test(inner.slice(i + 1))) {
                    return { text: inner.slice(0, i), weight: w, hasColon: true };
                }
                return { text: inner, weight: null, hasColon: false };
            }
        }
        return { text: inner, weight: null, hasColon: false };
    }

    /** Number of balanced wrapper levels: '((x))' with ('(',')') -> 2. */
    function wrapperLevels(t, open, close) {
        let inner = t;
        let levels = 0;
        while (levels < 9 && inner.length >= 2 && inner[0] === open && inner[inner.length - 1] === close) {
            let depth = 0;
            let closesAtEnd = false;
            for (let i = 0; i < inner.length; i++) {
                if (inner[i] === open) depth++;
                else if (inner[i] === close) {
                    depth--;
                    if (depth === 0) {
                        closesAtEnd = i === inner.length - 1;
                        break;
                    }
                }
            }
            if (!closesAtEnd) break;
            inner = inner.slice(1, -1);
            levels++;
        }
        return { levels: levels, inner: inner };
    }

    // ── '@' prompt syntax ───────────────────────────────────────────────────
    // Mirror of mobile_lite/js/prompt-syntax.js (a classic script cannot import the
    // module).  Every keyword starting with '@' is a directive and must pass this
    // grammar; @PICK and @SEQ are the only keyword directives today.

    const PICK_EXAMPLE = '@PICK{a, b, c} or @PICK(2){a, b, c}';
    const SEQ_EXAMPLE = '@SEQ{a, b, c}, @SEQ(2){a, b, c} or @SEQ(2, 3){a, b, c}';
    const SYNTAX_EXAMPLES = PICK_EXAMPLE + ' · ' + SEQ_EXAMPLE;

    /** Splits an @PICK body at top level commas (commas inside (), [], {}, <> stay). */
    function splitSyntaxItems(text) {
        const items = [];
        let current = '';
        let depth = 0;
        for (let i = 0; i < text.length; i++) {
            const ch = text[i];
            if ('([{<'.indexOf(ch) >= 0) depth++;
            else if (')]}>'.indexOf(ch) >= 0) depth = Math.max(0, depth - 1);
            if (ch === ',' && depth === 0) {
                items.push(current);
                current = '';
            } else {
                current += ch;
            }
        }
        items.push(current);
        return items.map((s) => s.trim()).filter(Boolean);
    }

    function invalidSyntax(raw, tag, kind, error, hint) {
        return { ok: false, tag: tag, raw: raw, kind: kind, count: 1, items: [], headline: error, details: [hint || 'Example: ' + SYNTAX_EXAMPLES] };
    }

    /** Grammar-checks one prompt keyword; null when it does not start with '@'. */
    function analyzeAtSyntax(body) {
        const raw = String(body == null ? '' : body).trim();
        if (raw[0] !== '@') return null;

        const tagMatch = /^@([A-Za-z][\w-]*)/.exec(raw);
        if (!tagMatch) return invalidSyntax(raw, '', 'pick', 'A prompt directive needs a name right after @.', '');

        const tag = tagMatch[1];
        const kind = tag.toLowerCase();
        if (kind !== 'pick' && kind !== 'seq') {
            return invalidSyntax(raw, tag, 'unknown', 'Unknown prompt syntax @' + tag + '.', 'Known syntax: ' + SYNTAX_EXAMPLES);
        }

        const example = kind === 'seq' ? SEQ_EXAMPLE : PICK_EXAMPLE;
        const rest = raw.slice(tagMatch[0].length);
        let at = rest.search(/\S/);
        at = at < 0 ? rest.length : at;

        let count = 1;
        let start = 1;
        if (rest[at] === '(') {
            const close = rest.indexOf(')', at);
            if (close < 0) return invalidSyntax(raw, tag, kind, 'Missing the closing “)” of the parameters.', 'Parameter syntax: @' + kind.toUpperCase() + '(2){a, b, c}');
            const params = rest.slice(at + 1, close).split(',').map((part) => part.trim());
            if (params.length > 2) {
                return invalidSyntax(raw, tag, kind, 'Too many parameters — write a repeat count and an optional start item.', '');
            }
            for (const param of params) {
                if (!/^\d+$/.test(param)) {
                    return invalidSyntax(raw, tag, kind,
                        param ? 'The parameter “' + param + '” is not a whole number.'
                            : 'A parameter is empty — write a number, for example ' + (kind === 'seq' ? '@SEQ(2, 1)' : '@PICK(2)') + '{a, b, c}.', '');
                }
            }
            if (params.length === 2 && kind !== 'seq') {
                return invalidSyntax(raw, tag, kind, '@PICK takes a single count — only @SEQ can start at a given keyword.', '');
            }
            count = parseInt(params[0], 10);
            if (params.length === 2) start = parseInt(params[1], 10);
            if (count < 1) return invalidSyntax(raw, tag, kind, kind === 'seq' ? 'The repeat count must be 1 or more.' : 'The count must be 1 or more.', '');
            if (start < 1) return invalidSyntax(raw, tag, kind, 'The start item must be 1 or more.', '');
            at = close + 1;
            while (at < rest.length && /\s/.test(rest[at])) at++;
        }

        if (rest[at] !== '{') return invalidSyntax(raw, tag, kind, 'Missing the { … } keyword list.', 'Write ' + example + '.');

        let depth = 0;
        let close = -1;
        for (let i = at; i < rest.length; i++) {
            if (rest[i] === '{') depth++;
            else if (rest[i] === '}') {
                depth--;
                if (depth === 0) {
                    close = i;
                    break;
                }
            }
        }
        if (close < 0) return invalidSyntax(raw, tag, kind, 'Missing the closing “}” of the keyword list.', '');
        if (rest.slice(close + 1).trim()) return invalidSyntax(raw, tag, kind, 'Unexpected text after the keyword list.', '');

        const items = splitSyntaxItems(rest.slice(at + 1, close));
        if (!items.length) return invalidSyntax(raw, tag, kind, 'The keyword list is empty — separate keywords with commas.', '');

        const drawn = Math.min(Math.max(count, 1), items.length);
        const shown = items.slice(0, 8).join(' · ') + (items.length > 8 ? ' … (+' + (items.length - 8) + ')' : '');

        if (kind === 'seq') {
            const total = items.length;
            const repeat = Math.max(count, 1);
            const first = (start - 1) % total;
            const startNote = start > 1 ? ' starting at keyword ' + start + ' → ' + items[first] : '';
            let headline;
            if (total === 1) {
                headline = 'Sequence — the group holds a single keyword, so every image uses it.';
            } else if (repeat === 1) {
                headline = 'Sequence — one keyword per image, in order' + startNote + ', then back to the start.';
            } else {
                headline = 'Sequence — each keyword is used for ' + repeat + ' images in turn' + startNote + ', then the list starts over.';
            }
            return {
                ok: true, tag: 'seq', raw: raw, kind: 'seq', count: repeat, start: start, items: items, headline: headline,
                details: [
                    'Keywords: ' + shown,
                    total > 1
                        ? (repeat === 1
                            ? 'Image 1 → ' + items[first] + ', image 2 → ' + items[(first + 1) % total] + ', … and back to the first keyword after ' + total + ' images.'
                            : 'Images 1–' + repeat + ' → ' + items[first] + ', images ' + (repeat + 1) + '–' + (repeat * 2) + ' → ' + items[(first + 1) % total] + ', … repeating after ' + (repeat * total) + ' images.')
                        : 'Nothing steps: the group has a single keyword.',
                ],
            };
        }

        let headline;
        if (items.length === 1) {
            headline = 'Random pick — the group holds a single keyword, so it is used for every image (nothing is drawn).';
        } else if (drawn >= items.length) {
            headline = 'Random pick — all ' + items.length + ' keywords are used for every image (nothing is drawn).';
        } else {
            headline = 'Random pick — ' + drawn + ' of ' + items.length + ' keywords ' + (drawn === 1 ? 'is' : 'are') + ' chosen at random for every image.';
        }
        return {
            ok: true, tag: 'pick', raw: raw, kind: 'pick', count: drawn, items: items, headline: headline,
            details: ['Keywords: ' + shown, 'Each image draws again (batch count 16 → 16 draws) and the draw follows the image seed.'],
        };
    }

    /** Plain-text hover hint for a chip `title`. */
    function syntaxHint(syntax) {
        return syntax ? [syntax.headline].concat(syntax.details).filter(Boolean).join('\n') : '';
    }

    /* ------------------------------------------------------- '@MACRO' definitions
     * Mirror of the custom-macro grammar in mobile_lite/js/prompt-syntax.js.
     */

    const MACRO_HEAD_RE = /^[ \t]*@macro(?![A-Za-z0-9_])/i;
    const MACRO_DEFINITION_RE = /^[ \t]*@macro[ \t]*\([ \t]*([A-Za-z_][A-Za-z0-9_]*)[ \t]*\)[ \t]*(\{[^\n]*\})?[ \t]*$/i;

    /** True for any @MACRO line, valid or not. */
    function isMacroLine(text) {
        return MACRO_HEAD_RE.test(String(text == null ? '' : text));
    }

    /** Grammar-checks one @MACRO line; null for an ordinary line. */
    function analyzeMacroLine(line) {
        const raw = String(line == null ? '' : line);
        if (!MACRO_HEAD_RE.test(raw)) return null;
        const match = MACRO_DEFINITION_RE.exec(raw);
        if (!match) {
            return {
                ok: false, kind: 'macro', tag: '@MACRO', name: '', key: '', macroType: 'bool',
                values: [], defaultValue: 0, raw: raw.trim(),
                headline: 'Malformed custom macro definition.',
                details: ['Write @MACRO(name) for a boolean macro or @MACRO(name){a, b, c} for an enum.'],
            };
        }
        const name = match[1];
        const rawValues = match[2];
        const values = rawValues ? Array.from(new Set(splitSyntaxItems(rawValues.slice(1, -1)))) : [];
        if (rawValues && !values.length) {
            return {
                ok: false, kind: 'macro', tag: '@MACRO', name: name, key: name.toUpperCase(),
                macroType: 'enum', values: [], defaultValue: 0, raw: raw.trim(),
                headline: 'The custom macro has no enum values.',
                details: ['Write at least one value: @MACRO(name){a, b, c}.'],
            };
        }
        const macroType = rawValues ? 'enum' : 'bool';
        const defaultValue = macroType === 'enum' ? values[0] : 0;
        return {
            ok: true, kind: 'macro', tag: '@MACRO', name: name, key: name.toUpperCase(),
            macroType: macroType, values: values, defaultValue: defaultValue, raw: raw.trim(),
            headline: macroType === 'enum'
                ? 'Defines the enum macro ' + name + ' (' + values.join(', ') + '); the first value is selected by default.'
                : 'Defines the boolean macro ' + name + ' (off by default).',
            details: ['Use it in conditions: @IF ' + name + (macroType === 'enum' ? ' == ' + values[0] : '') + '.'],
        };
    }

    /* ------------------------------------------------------------- '@IF' blocks
     * Mirror of the condition grammar in mobile_lite/js/prompt-syntax.js: a line of
     * its own starting with @IF / @ELSEIF / @ELSE / @ENDIF (all optional whitespace
     * before the '@').
     */

    const CONDITION_MACROS = {
        TXT2IMG: '1 during the txt2img first pass',
        HIRES_FIX: '1 during the Hires. fix pass (an img2img pass, so IMG2IMG is 1 too)',
        IMG2IMG: '1 during img2img, Hires. fix and inpaint',
        INPAINT: '1 during inpaint and pose inpaint',
        POSE_INPAINT: '1 during a pose inpaint pass (an inpaint pass, so INPAINT is 1 too)',
        POSE_INPAINT_PART: 'the pose pass part: 0 (none), FACE, FEET, HANDS or BODY (custom nodes)',
    };
    const CONDITION_MACRO_NAMES = Object.keys(CONDITION_MACROS);
    const CONDITION_EXAMPLE = '@IF TXT2IMG … @ENDIF';
    const CONDITION_RE = /^[ \t]*@(if|elif|elseif|else|endif)(?![A-Za-z0-9_])(.*)$/i;
    // one token per call; the "y" flag keeps the scan position explicit
    const CONDITION_TOKEN_RE = /[ \t]*(?:(!=|==|&&|\|\||[!()])|([A-Za-z_][A-Za-z0-9_]*)|(-?\d+(?:\.\d+)?)|(\S))/y;

    /** True when the line is a standalone @IF / @ELSEIF / @ELSE / @ENDIF directive. */
    function isConditionLine(text) {
        return CONDITION_RE.test(String(text == null ? '' : text));
    }

    /** '@IF' / '@ELSEIF' / '@ELSE' / '@ENDIF' for an internal keyword ('if', ...). */
    function directiveLabel(keyword) {
        return '@' + String(keyword || '').toUpperCase();
    }

    /** True for a comment line; an '@IF' block directive is not a comment. */
    function isCommentedLine(text) {
        return !isConditionLine(text) && /^\s*#(?!\()/.test(String(text == null ? '' : text));
    }

    function conditionTokens(expression) {
        const tokens = [];
        let index = 0;
        while (index < expression.length) {
            CONDITION_TOKEN_RE.lastIndex = index;
            const match = CONDITION_TOKEN_RE.exec(expression);
            if (!match) return null;
            if (match[1]) tokens.push({type: 'op', value: match[1]});
            else if (match[2]) tokens.push({type: 'word', value: match[2]});
            else if (match[3]) tokens.push({type: 'number', value: match[3]});
            else return null;
            index = CONDITION_TOKEN_RE.lastIndex;
        }
        return tokens;
    }

    /** Validates a condition; returns { ok, macros, error }. */
    function parseCondition(expression) {
        const text = String(expression == null ? '' : expression).trim();
        const macros = [];
        const tokens = conditionTokens(text);
        if (!text) return {ok: false, macros: macros, error: 'The condition is empty.'};
        if (!tokens) return {ok: false, macros: macros, error: 'The condition “' + text + '” is not valid.'};

        let index = 0;
        const peek = () => tokens[index];
        const fail = (message) => {
            throw new Error(message);
        };
        const atOperator = (...values) => {
            const token = peek();
            return !!token && token.type === 'op' && values.indexOf(token.value) >= 0;
        };
        const atWord = (value) => {
            const token = peek();
            return !!token && token.type === 'word' && token.value.toLowerCase() === value;
        };
        const primary = () => {
            if (atOperator('!')) {
                index++;
                primary();
                return;
            }
            if (atOperator('(')) {
                index++;
                orExpression();
                if (!atOperator(')')) fail('Missing the closing “)” of the group.');
                index++;
                return;
            }
            const token = peek();
            if (!token) fail('The condition is incomplete.');
            if (token.type !== 'word') fail('Unexpected “' + token.value + '” in the condition.');
            const name = token.value.toUpperCase();
            if (macros.indexOf(name) < 0) macros.push(name);
            index++;
            if (atOperator('==', '!=')) {
                index++;
                const value = peek();
                if (!value || (value.type !== 'word' && value.type !== 'number')) fail('Missing the value to compare with.');
                index++;
            }
        };
        const andExpression = () => {
            primary();
            while (atOperator('&&') || atWord('and')) {
                index++;
                primary();
            }
        };
        const orExpression = () => {
            andExpression();
            while (atOperator('||') || atWord('or')) {
                index++;
                andExpression();
            }
        };

        try {
            orExpression();
            if (index !== tokens.length) fail('Unexpected “' + tokens[index].value + '” in the condition.');
        } catch (error) {
            return {ok: false, macros: macros, error: error.message};
        }
        return {ok: true, macros: macros, error: ''};
    }

    function conditionError(info, message, hint) {
        return Object.assign({}, info, {ok: false, headline: message, details: [hint].concat(info.details).filter(Boolean)});
    }

    /** Valid custom macro definitions, keyed by upper-case name. */
    function parseMacroDefinitions(text) {
        const definitions = {};
        for (const line of String(text == null ? '' : text).split('\n')) {
            const info = analyzeMacroLine(line);
            if (info && info.ok) definitions[info.key] = info;
        }
        return definitions;
    }

    function macroDetail(name, definitions) {
        if (Object.prototype.hasOwnProperty.call(CONDITION_MACROS, name)) return name + ' is ' + CONDITION_MACROS[name];
        const definition = definitions[name];
        if (definition && definition.macroType === 'enum') return name + ' is a custom enum macro (' + definition.values.join(', ') + ')';
        if (definition) return name + ' is a custom boolean macro (off by default)';
        return name + ' is an undeclared boolean macro (off by default; add @MACRO(' + name + ') to declare it)';
    }

    /** Grammar-checks one line; null when it is not an @IF block directive. */
    function analyzeConditionLine(line, definitions) {
        const raw = String(line == null ? '' : line);
        const match = CONDITION_RE.exec(raw);
        if (!match) return null;

        const typed = match[1].toLowerCase();
        const keyword = typed === 'elif' ? 'elseif' : typed;
        const label = directiveLabel(keyword);
        const expression = match[2].trim();
        const info = {
            ok: true, kind: 'condition', tag: label, keyword: keyword, raw: raw.trim(),
            expression: expression, macros: [], headline: '', details: [],
        };

        if (keyword === 'else' || keyword === 'endif') {
            if (expression) return conditionError(info, 'Unexpected text after ' + label + '.', 'Write ' + label + ' on its own line.');
            info.headline = keyword === 'else' ?
                'Otherwise branch — used when no earlier branch of the @IF block matched.' :
                'Ends the @IF block.';
            info.details = [CONDITION_EXAMPLE];
            return info;
        }

        if (!expression) return conditionError(info, 'Missing the condition after ' + label + '.', 'Example: ' + CONDITION_EXAMPLE);

        const parsed = parseCondition(expression);
        info.macros = parsed.macros;
        if (!parsed.ok) return conditionError(info, parsed.error, 'Known macros: ' + CONDITION_MACRO_NAMES.join(', '));

        info.headline = 'Conditional block — the text below is used only while ' + expression + ' is true.';
        info.details = parsed.macros.map((name) => macroDetail(name, definitions || {}));
        return info;
    }

    /** Validates every @IF block; null for ordinary lines, an error on the culprit. */
    function analyzeConditionLines(text) {
        const definitions = parseMacroDefinitions(text);
        const lines = String(text == null ? '' : text).split('\n');
        const results = lines.map((line) => analyzeConditionLine(line, definitions));
        const stack = [];

        results.forEach((info, index) => {
            if (!info) return;
            // the nesting is tracked even for a broken line, so one bad condition does not
            // cascade into "dangling @ENDIF" reports on every line after it
            if (info.keyword === 'if') {
                stack.push({index: index, seenElse: false});
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
                results[frame.index] = conditionError(results[frame.index], 'Missing @ENDIF — this @IF is never closed.', 'Example: ' + CONDITION_EXAMPLE);
            }
        });
        return results;
    }

    /* -------------------------------------------- multi-line @PICK / @SEQ groups
     * Mirror of findPickGroups in mobile_lite/js/prompt-parse.js: the token model
     * is line based, but a keyword list may span lines.  The opening line is
     * validated against the whole group so it is not flagged as missing '}'.
     */

    const GROUP_RE = /@(?:pick|seq)[ \t]*(?:\([ \t]*\d+[ \t]*(?:,[ \t]*\d+[ \t]*)?\)[ \t]*)?\{/gi;

    function lineStartOffsets(text) {
        const starts = [0];
        for (let i = 0; i < text.length; i++) {
            if (text[i] === '\n') starts.push(i + 1);
        }
        return starts;
    }

    function lineForOffset(starts, offset) {
        let low = 0;
        let high = starts.length - 1;
        while (low < high) {
            const mid = (low + high + 1) >> 1;
            if (starts[mid] <= offset) low = mid;
            else high = mid - 1;
        }
        return low;
    }

    function findPickGroups(text) {
        const source = text == null ? '' : String(text);
        if (source.indexOf('@') < 0) return [];
        const starts = lineStartOffsets(source);
        const groups = [];
        GROUP_RE.lastIndex = 0;
        let match;
        while ((match = GROUP_RE.exec(source)) !== null) {
            const start = match.index;
            const openLine = lineForOffset(starts, start);
            const lineStart = starts[openLine];
            if (/^\s*#(?!\()/.test(source.slice(lineStart, start))) continue;

            let depth = 1;
            let index = GROUP_RE.lastIndex;
            let close = -1;
            while (index < source.length) {
                const ch = source[index];
                if (ch === '{') depth++;
                else if (ch === '}') {
                    depth--;
                    if (depth === 0) {
                        close = index;
                        break;
                    }
                }
                index++;
            }
            if (close < 0) continue;

            const end = close + 1;
            const raw = source.slice(start, end);
            const closeLine = lineForOffset(starts, close);
            groups.push({
                start: start,
                end: end,
                headerEnd: match.index + match[0].length,
                openLine: openLine,
                openColumn: start - lineStart,
                closeLine: closeLine,
                multiline: openLine !== closeLine,
                raw: raw,
                syntax: analyzeAtSyntax(raw),
            });
            GROUP_RE.lastIndex = end;
        }
        return groups;
    }

    function pickGroupAt(groups, line, column) {
        for (let i = 0; i < groups.length; i++) {
            if (groups[i].openLine === line && groups[i].openColumn === column) return groups[i];
        }
        return null;
    }

    /**
     * Classify a segment body -> { kind, text, weight, disabled, syntax? }
     *   kind: 'plain' | 'paren' | 'bracket' | 'angle' | 'pick' | 'seq' | 'at'
     * The weight is the *effective* A1111 weight, so '((x))' is 1.21 and '[x]' is 0.909.
     * 'pick' is a well formed @PICK group, 'seq' a well formed @SEQ group and 'at' a
     * broken '@' directive (see analyzeAtSyntax).
     */
    function classify(body, syntaxOverride, allowCondition) {
        const t = body.trim();
        if (!t) return { kind: 'plain', text: '', weight: DEFAULT_WEIGHT, disabled: false };

        if (t === ',') return { kind: 'plain', text: ',', weight: DEFAULT_WEIGHT, disabled: false };

        // a standalone @MACRO / @IF line is a directive, not a comment (allowCondition
        // is false for the body of a commented line and for disabled '#(...)' groups)
        if (isMacroLine(t) || isConditionLine(t)) {
            if (allowCondition === false) return {kind: 'plain', text: t, weight: DEFAULT_WEIGHT, disabled: false};
            if (isMacroLine(t)) return {kind: 'macro', text: t, weight: DEFAULT_WEIGHT, disabled: false, syntax: analyzeMacroLine(t)};
            return {kind: 'cond', text: t, weight: DEFAULT_WEIGHT, disabled: false, syntax: analyzeConditionLine(t)};
        }

        // every keyword starting with '@' is a directive and must pass the grammar;
        // syntaxOverride is the validated full group for a multi-line header
        const syntax = syntaxOverride || analyzeAtSyntax(t);
        if (syntax) {
            return {
                kind: syntax.ok ? syntax.kind : 'at',
                text: t,
                weight: DEFAULT_WEIGHT,
                disabled: false,
                pickCount: syntax.ok ? syntax.count : 0,
                syntax: syntax,
            };
        }

        // #(...) / #[...] / #<...> -> disabled keyword group
        if (t[0] === '#' && t.length > 3) {
            const inner = classify(t.slice(1), null, false);
            if (inner.kind !== 'plain') {
                inner.disabled = true;
                return inner;
            }
        }

        if (t[0] === '(' && t[t.length - 1] === ')') {
            const wrap = wrapperLevels(t, '(', ')');
            if (wrap.levels > 0) {
                const colon = colonWeight(wrap.inner);
                const base = colon.hasColon ? colon.weight : 1.1;
                const weight = base * Math.pow(1.1, wrap.levels - 1);
                return { kind: 'paren', text: colon.hasColon ? colon.text : wrap.inner, weight: weight, disabled: false };
            }
        }

        if (t[0] === '[' && t[t.length - 1] === ']') {
            const wrap = wrapperLevels(t, '[', ']');
            if (wrap.levels > 0) {
                const colon = colonWeight(wrap.inner);
                const base = colon.hasColon ? colon.weight : 1 / 1.1;
                const weight = base * Math.pow(1 / 1.1, wrap.levels - 1);
                return { kind: 'bracket', text: colon.hasColon ? colon.text : wrap.inner, weight: weight, disabled: false };
            }
        }

        if (t[0] === '<' && t[t.length - 1] === '>') {
            const inner = t.slice(1, -1);
            const parts = inner.split(':');
            let weight = DEFAULT_WEIGHT;
            let text = inner;
            if (parts.length >= 3) {
                const w = parseFloat(parts[parts.length - 1]);
                if (!isNaN(w)) {
                    weight = w;
                    text = parts.slice(0, -1).join(':');
                }
            }
            return { kind: 'angle', text: text, weight: weight, disabled: false };
        }

        return { kind: 'plain', text: t, weight: DEFAULT_WEIGHT, disabled: false };
    }

    /**
     * Build the body text for a token with the given weight / disabled flag.
     * Used by every chip action (weight steppers, disable, quick weights).
     */
    function rebuild(token, weight, disabled) {
        // a random-pick / sequence group has no weight of its own and cannot be
        // disabled with '#(...)', and a broken '@' directive (and an @IF / @MACRO
        // line) must keep its text as typed
        if (token.kind === 'pick' || token.kind === 'seq' || token.kind === 'at' || token.kind === 'cond' || token.kind === 'macro') return token.text;

        const flat = Math.abs(weight - DEFAULT_WEIGHT) < 1e-9;
        let inner;
        if (token.kind === 'angle') {
            inner = flat ? '<' + token.text + '>' : '<' + token.text + ':' + formatWeight(weight) + '>';
        } else {
            inner = flat ? token.text : token.text + ':' + formatWeight(weight);
        }
        if (disabled) return '#(' + inner + ')';
        if (token.kind === 'angle' || flat) return inner; // weight 1 -> drop the brackets entirely
        return '(' + inner + ')';
    }

    // ── per-host editor ─────────────────────────────────────────────────────

    function installOn(host) {
        if (!host || host.dataset.peditReady === '1') return;
        const textarea = host.querySelector('textarea');
        if (!textarea) return;
        host.dataset.peditReady = '1';
        const macroTab = host.id.startsWith('img2img') ? 'img2img' : 'txt2img';
        // inline prompt-replacer preview: only the two generation prompt boxes
        const replacerTab = host.id.startsWith('txt2img') ? 'txt2img'
            : (host.id.startsWith('img2img') ? 'img2img' : '');

        host.classList.add('pedit-host');

        const root = document.createElement('div');
        root.className = 'pedit-root';
        host.appendChild(root);

        const state = {
            text: textarea.value || '',
            selected: null,       // { line, seg }
            input: null,          // { line, value } while the inline add-input is open
            suggestIdx: 0,
            suggestions: [],
            pool: null,
            lastCommitted: textarea.value || '',
            scroll: 0,
        };

        const step = () => {
            const v = parseFloat(readLS(LS_STEP, '0.05'));
            return isNaN(v) || v <= 0 ? 0.05 : v;
        };

        // ── text synchronisation (textarea is the source of truth) ──────────

        function commit(newText, keepSelection) {
            state.text = newText;
            state.lastCommitted = newText;
            if (textarea.value !== newText) {
                textarea.value = newText;
            }
            textarea.dispatchEvent(new Event('input', { bubbles: true }));
            textarea.dispatchEvent(new Event('change', { bubbles: true }));
            render();
        }

        function syncFromTextarea(force) {
            const v = textarea.value || '';
            if (v === state.lastCommitted && !force) return;
            // never clobber the DOM while the user is typing inside the editor
            const active = document.activeElement;
            if (!force && active && root.contains(active) && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')) return;
            state.text = v;
            state.lastCommitted = v;
            render();
        }

        // ── rendering ───────────────────────────────────────────────────────

        function tokenAt(line, seg) {
            const lines = state.text.split('\n');
            if (line < 0 || line >= lines.length) return null;
            const segs = splitSegments(lines[line]);
            if (seg < 0 || seg >= segs.length) return null;
            let column = 0;
            for (let i = 0; i < seg; i++) {
                column += segs[i].lead.length + segs[i].body.length + segs[i].tail.length;
            }
            column += segs[seg].lead.length + (segs[seg].body.length - segs[seg].body.trimStart().length);
            const group = pickGroupAt(findPickGroups(state.text), line, column);
            const info = classify(segs[seg].body, group ? group.syntax : null, !isCommentedLine(lines[line]));
            if (info.kind === 'cond') {
                // the whole-prompt pass knows about a missing @ENDIF / a stray @ELSE
                const condition = analyzeConditionLines(state.text)[line];
                if (condition) info.syntax = condition;
            }
            info.segIndex = seg;
            info.lineIndex = line;
            return info;
        }

        function chipHtml(line, seg, token) {
            const selected = state.selected && state.selected.line === line && state.selected.seg === seg;
            const cls = ['pedit-chip'];
            const syntax = token.syntax || null;
            const condition = token.kind === 'cond';
            const macro = token.kind === 'macro';
            if (token.disabled) cls.push('is-disabled');
            if (selected) cls.push('is-selected');
            if (!token.text) cls.push('is-empty');
            if (condition) cls.push('is-cond');
            if (macro) cls.push('is-macro');
            if (syntax) cls.push(syntax.ok ? 'is-syntax' : 'is-syntax-error');

            const children = [];
            if (condition) children.push(`<span class="pedit-chip-kind" title="${syntax && syntax.ok ? 'stage condition' : 'stage condition error'}">${syntax && syntax.ok ? '⑂' : '⚠️'}</span>`);
            else if (macro) children.push(`<span class="pedit-chip-kind" title="${syntax && syntax.ok ? 'custom macro' : 'custom macro error'}">${syntax && syntax.ok ? '🎛' : '⚠️'}</span>`);
            else if (token.kind === 'angle') children.push('<span class="pedit-chip-kind" title="extra network tag">◈</span>');
            else if (syntax) children.push(`<span class="pedit-chip-kind" title="${syntax.ok ? (syntax.kind === 'seq' ? 'prompt sequence' : 'random pick') : 'prompt syntax error'}">${syntax.ok ? (syntax.kind === 'seq' ? '🔁' : '🎲') : '⚠️'}</span>`);
            const chipLabel = token.text || '…';
            const chipText = replacerTab && window.promptReplacer && window.promptReplacer.decorateChipText
                ? window.promptReplacer.decorateChipText(chipLabel, replacerTab)
                : escapeHtml(chipLabel);
            children.push(`<span class="pedit-chip-text">${chipText}</span>`);
            if (syntax) {
                if (!condition && !macro && syntax.ok && syntax.items.length > 1) {
                    if (syntax.kind === 'seq') {
                        const badgeTitle = 'images per keyword / keywords in the group' + (syntax.start > 1 ? ' · starts at keyword ' + syntax.start : '');
                        children.push(`<span class="pedit-chip-w pedit-chip-seq" title="${badgeTitle}">×${syntax.count}</span>`);
                    } else {
                        children.push(`<span class="pedit-chip-w pedit-chip-pick" title="keywords drawn per image / keywords in the group">${syntax.count}/${syntax.items.length}</span>`);
                    }
                }
            } else if (Math.abs((token.weight || 1) - DEFAULT_WEIGHT) > 1e-9) {
                children.push(`<span class="pedit-chip-w" title="weight">×${escapeHtml(formatWeight(token.weight))}</span>`);
            }
            if (token.disabled) children.push('<span class="pedit-chip-off" title="disabled">⛔</span>');
            // no syntax hint in the title: the explanation opens on right-click so a
            // hover never covers the prompt (the chip text itself still shows when truncated)
            return `<span class="${cls.join(' ')}" data-line="${line}" data-seg="${seg}" title="${escapeHtml(token.text)}">`
                + children.join('')
                + '</span>';
        }

        function lineHtml(line, index, lines, groups, conditions, inactive) {
            // a standalone @IF / @MACRO line is a directive, not a comment
            const condition = isConditionLine(line);
            const macro = isMacroLine(line);
            const commented = !condition && !macro && /^\s*#(?!\()/.test(line);
            const conditionSyntax = condition && conditions ? conditions[index] : null;
            // a commented line shows its keywords without the leading '# ' - the
            // gutter button carries the state and the raw text stays untouched
            const content = commented ? line.replace(/^(\s*)#\s?/, '$1') : line;
            const segs = splitSegments(content);
            let cursor = 0;
            const chips = segs
                .map((s, i) => {
                    const bodyStart = cursor + s.lead.length;
                    const coreStart = bodyStart + (s.body.length - s.body.trimStart().length);
                    cursor = bodyStart + s.body.length + s.tail.length;
                    if (!s.body.trim()) {
                        // a bare separator (", a, b" or "a, , b") keeps its comma visible
                        return i < segs.length - 1 ? '<span class="pedit-sep">,</span>' : '';
                    }
                    const group = pickGroupAt(groups, index, coreStart);
                    const token = classify(s.body, group ? group.syntax : null, !commented);
                    if (token.kind === 'cond' && conditionSyntax) token.syntax = conditionSyntax;
                    return chipHtml(index, i, token);
                })
                .join('');
            const commentBtn = `<button type="button" class="pedit-gutter ${commented ? 'is-comment' : ''}" `
                + `data-line="${index}" title="${commented ? 'Uncomment this line' : 'Comment this line'}">${commented ? '⏸' : '💬'}</button>`;
            // '# ---' markers open a block up to the next marker: one tap toggles the whole block
            let blockBtn = '';
            const bounds = condition || macro ? null : (lines ? blockBounds(lines, index) : null);
            if (bounds) {
                const off = blockIsOff(lines, bounds.from, bounds.to);
                const count = bounds.to - bounds.from;
                const title = off
                    ? 'Turn this block back on (' + count + ' line(s))'
                    : 'Turn off this block until the next # marker (' + count + ' line(s))';
                blockBtn = `<button type="button" class="pedit-gutter pedit-block-toggle ${off ? 'is-off' : ''}" `
                    + `data-line="${index}" title="${title}">${off ? '⏸' : '▶'}</button>`;
            }
            const addBtn = condition || macro ? '' : `<button type="button" class="pedit-add" data-line="${index}" title="Add a keyword to this line">＋</button>`;
            const inactiveCls = inactive && inactive.has(index) ? ' is-inactive' : '';
            return `<div class="pedit-line ${commented ? 'is-comment' : ''} ${condition ? 'is-condition' : ''} ${macro ? 'is-macro' : ''}${inactiveCls}" data-line="${index}">`
                + commentBtn
                + blockBtn
                + `<div class="pedit-chips">${chips}${addBtn}</div>`
                + '</div>';
        }

        function actionBarHtml() {
            const sel = state.selected;
            if (!sel) return '';
            const token = tokenAt(sel.line, sel.seg);
            if (!token || !token.text) return '';
            const w = token.weight || DEFAULT_WEIGHT;
            // a random-pick group has neither a weight nor a disabled form; a broken
            // '@' directive also keeps every weight control away until it is fixed
            const isSyntax = !!token.syntax;
            const weightControls = isSyntax ? '' : ''
                + `<button type="button" class="pedit-act" data-act="w-minus" title="Lower weight">−</button>`
                + `<span class="pedit-weight" title="weight">${escapeHtml(formatWeight(w))}</span>`
                + `<button type="button" class="pedit-act" data-act="w-plus" title="Raise weight">＋</button>`
                + `<button type="button" class="pedit-act pedit-quick" data-act="w-0.8">0.8</button>`
                + `<button type="button" class="pedit-act pedit-quick" data-act="w-1.1">1.1</button>`
                + `<button type="button" class="pedit-act pedit-quick" data-act="w-1.2">1.2</button>`
                + `<button type="button" class="pedit-act" data-act="reset" title="Back to weight 1 (no brackets)">⟲1.0</button>`
                + `<span class="pedit-actions-sep"></span>`;
            const disableButton = isSyntax ? '' : `<button type="button" class="pedit-act ${token.disabled ? 'is-on' : ''}" data-act="toggle-off" title="${token.disabled ? 'Enable this keyword' : 'Disable this keyword (stripped when generating)'}">${token.disabled ? '✅' : '⛔'}</button>`;
            // the hint doubles as the error prompt: the headline says what is wrong
            const hint = isSyntax ? `<span class="pedit-syntax-hint ${token.syntax.ok ? 'is-ok' : 'is-error'}">${escapeHtml(token.syntax.headline)}</span>` : '';
            return `<div class="pedit-actions">`
                + `<span class="pedit-actions-text" title="selected keyword">${escapeHtml(token.text)}</span>`
                + hint
                + weightControls
                + disableButton
                + `<button type="button" class="pedit-act" data-act="duplicate" title="Duplicate">⎘</button>`
                + `<button type="button" class="pedit-act" data-act="delete" title="Delete">🗑</button>`
                + `<button type="button" class="pedit-act pedit-act-close" data-act="close" title="Close">✕</button>`
                + '</div>';
        }

        function inputHtml(line) {
            if (!state.input || state.input.line !== line) return '';
            const items = state.suggestions;
            const list = items.length
                ? items.map((s, i) => `<button type="button" class="pedit-suggest-item ${i === state.suggestIdx ? 'is-active' : ''}" data-suggest="${i}">${escapeHtml(s)}</button>`).join('')
                : '<span class="pedit-suggest-empty">no match — Enter adds the text as typed</span>';
            return `<div class="pedit-insert" data-line="${line}">`
                + `<input type="text" class="pedit-input" value="${escapeHtml(state.input.value || '')}" placeholder="keyword…" autocomplete="off" enterkeyhint="done" />`
                + '<button type="button" class="pedit-insert-ok" title="Add">✓</button>'
                + '<button type="button" class="pedit-insert-cancel" title="Cancel">✕</button>'
                + `<div class="pedit-suggest">${list}</div>`
                + '</div>';
        }

        function render() {
            closeSyntaxPop();
            const lines = state.text.split('\n');
            const groups = findPickGroups(state.text);
            const conditions = analyzeConditionLines(state.text);
            const macros = window.promptMacros
                ? (window.promptMacros.macrosForText
                    ? window.promptMacros.macrosForText(state.text, macroTab)
                    : window.promptMacros.macrosFor(macroTab))
                : null;
            const inactive = window.promptMacros && macros
                ? window.promptMacros.inactiveLines(state.text, macros)
                : new Set();
            const body = lines.map((l, i) => lineHtml(l, i, lines, groups, conditions, inactive) + inputHtml(i)).join('');
            const disabledCount = countDisabled();
            const syntaxErrors = countSyntaxErrors();
            const previous = root.querySelector('.pedit-body');
            const scrollTop = previous ? previous.scrollTop : state.scroll;
            root.innerHTML = `<div class="pedit-head">`
                + `<span class="pedit-title">chips</span>`
                + `<button type="button" class="pedit-head-btn" data-act="to-text" title="Switch to the plain textarea (highlight, Ctrl+/, block comments)">⌨ Text</button>`
                + `<button type="button" class="pedit-head-btn" data-act="add-line" title="Add a line">＋ line</button>`
                + `<button type="button" class="pedit-head-btn" data-act="uncomment-all" title="Uncomment every line">▶ all</button>`
                + (disabledCount ? `<span class="pedit-badge" title="keywords disabled with #( ) are stripped when generating">${disabledCount} off</span>` : '')
                + (syntaxErrors ? `<span class="pedit-badge is-error" title="keywords starting with @ and @IF blocks must follow the prompt syntax - right-click a red keyword to see what is wrong">⚠ ${syntaxErrors} syntax</span>` : '')
                + '</div>'
                + `<div class="pedit-body">${body}</div>`
                + actionBarHtml();
            const scroller = root.querySelector('.pedit-body');
            if (scroller) {
                scroller.scrollTop = scrollTop;
                state.scroll = scroller.scrollTop;
            }
        }

        function countDisabled() {
            let n = 0;
            state.text.split('\n').forEach((line) => {
                splitSegments(line).forEach((s) => {
                    if (classify(s.body).disabled) n++;
                });
            });
            return n;
        }

        /** Broken '@' directives and @IF blocks (drives the ⚠ badge in the header). */
        function countSyntaxErrors() {
            const groups = findPickGroups(state.text);
            let n = 0;
            state.text.split('\n').forEach((line, lineIndex) => {
                const commented = isCommentedLine(line);
                let cursor = 0;
                splitSegments(line).forEach((s) => {
                    const bodyStart = cursor + s.lead.length;
                    const coreStart = bodyStart + (s.body.length - s.body.trimStart().length);
                    cursor = bodyStart + s.body.length + s.tail.length;
                    const group = pickGroupAt(groups, lineIndex, coreStart);
                    const token = classify(s.body, group ? group.syntax : null, !commented);
                    // @IF lines are counted with their whole block (missing @ENDIF, stray @ELSE)
                    if (token.kind !== 'cond' && token.syntax && !token.syntax.ok) n++;
                });
            });
            return n + analyzeConditionLines(state.text).filter((info) => info && !info.ok).length;
        }

        // ── '@' directive hint (right-click only) ───────────────────────────
        // Hovering must not cover the prompt, so the explanation of a directive (what
        // it does, the N-of-M preview, or the grammar error) opens on right-click.

        let syntaxPop = null;

        function closeSyntaxPop() {
            if (!syntaxPop) return;
            syntaxPop.remove();
            syntaxPop = null;
            document.removeEventListener('pointerdown', onSyntaxPopOutside, true);
            document.removeEventListener('keydown', onSyntaxPopKey, true);
            window.removeEventListener('scroll', closeSyntaxPop, true);
        }

        function onSyntaxPopOutside(event) {
            if (syntaxPop && syntaxPop.contains(event.target)) return;
            closeSyntaxPop();
        }

        function onSyntaxPopKey(event) {
            if (event.key === 'Escape') closeSyntaxPop();
        }

        function openSyntaxPop(token, x, y) {
            closeSyntaxPop();
            const syntax = token.syntax;
            syntaxPop = document.createElement('div');
            syntaxPop.className = 'pedit-syntax-pop' + (syntax.ok ? '' : ' is-error');
            syntaxPop.innerHTML = `<div class="pedit-syntax-pop-raw">${escapeHtml(token.text)}</div>`
                + `<div class="pedit-syntax-pop-head">${escapeHtml(syntax.headline)}</div>`
                + syntax.details.map((line) => `<div class="pedit-syntax-pop-line">${escapeHtml(line)}</div>`).join('');
            const close = document.createElement('button');
            close.type = 'button';
            close.className = 'pedit-syntax-pop-close';
            close.textContent = '✕';
            close.title = 'Close';
            close.addEventListener('click', closeSyntaxPop);
            syntaxPop.appendChild(close);
            document.body.appendChild(syntaxPop);
            const rect = syntaxPop.getBoundingClientRect();
            const left = Math.min(Math.max(8, x - 12), Math.max(8, window.innerWidth - rect.width - 8));
            const top = Math.min(Math.max(8, y + 12), Math.max(8, window.innerHeight - rect.height - 8));
            syntaxPop.style.left = `${Math.round(left)}px`;
            syntaxPop.style.top = `${Math.round(top)}px`;
            document.addEventListener('pointerdown', onSyntaxPopOutside, true);
            document.addEventListener('keydown', onSyntaxPopKey, true);
            window.addEventListener('scroll', closeSyntaxPop, true);
        }

        // right-click (or long-press) on a directive chip opens its hint; every other
        // right-click keeps the browser menu (paste, spellcheck, …)
        root.addEventListener('contextmenu', (event) => {
            const chip = event.target.closest ? event.target.closest('.pedit-chip') : null;
            if (!chip || !root.contains(chip)) return;
            const token = tokenAt(Number(chip.dataset.line), Number(chip.dataset.seg));
            if (!token || !token.syntax) return;
            event.preventDefault();
            openSyntaxPop(token, event.clientX, event.clientY);
        });

        // ── editing operations ──────────────────────────────────────────────

        function setLineBody(lineIndex, segIndex, newBody) {
            const lines = state.text.split('\n');
            if (lineIndex < 0 || lineIndex >= lines.length) return;
            const segs = splitSegments(lines[lineIndex]);
            if (segIndex < 0 || segIndex >= segs.length) return;
            segs[segIndex].body = newBody;
            lines[lineIndex] = joinSegments(segs);
            commit(lines.join('\n'));
        }

        function mapLine(lineIndex, fn) {
            const lines = state.text.split('\n');
            if (lineIndex < 0 || lineIndex >= lines.length) return;
            lines[lineIndex] = fn(lines[lineIndex]);
            commit(lines.join('\n'));
        }

        function rawBody(lineIndex, segIndex) {
            const lines = state.text.split('\n');
            if (lineIndex < 0 || lineIndex >= lines.length) return null;
            const segs = splitSegments(lines[lineIndex]);
            if (segIndex < 0 || segIndex >= segs.length) return null;
            return segs[segIndex];
        }

        function applyChipAction(action) {
            const sel = state.selected;
            if (!sel) return;
            const token = tokenAt(sel.line, sel.seg);
            if (!token) return;
            const seg = rawBody(sel.line, sel.seg);
            if (!seg) return;
            const cur = token.weight || DEFAULT_WEIGHT;

            const write = (body) => {
                const lines = state.text.split('\n');
                const segs = splitSegments(lines[sel.line]);
                segs[sel.seg].body = body;
                lines[sel.line] = joinSegments(segs);
                commit(lines.join('\n'));
            };

            switch (action) {
                case 'w-plus':
                    write(rebuild(token, Math.round((cur + step()) * 1000) / 1000, token.disabled));
                    break;
                case 'w-minus':
                    write(rebuild(token, Math.max(0, Math.round((cur - step()) * 1000) / 1000), token.disabled));
                    break;
                case 'reset':
                    write(rebuild(token, DEFAULT_WEIGHT, token.disabled));
                    break;
                case 'toggle-off':
                    write(rebuild(token, cur, !token.disabled));
                    break;
                case 'duplicate': {
                    const lines = state.text.split('\n');
                    const segs = splitSegments(lines[sel.line]);
                    const orig = segs[sel.seg];
                    // make sure the clone is a separate keyword, not glued to the original
                    if (!/,\s*$/.test(orig.tail || '')) orig.tail = (orig.tail || '') + ', ';
                    segs.splice(sel.seg + 1, 0, { lead: '', body: seg.body, tail: '' });
                    lines[sel.line] = joinSegments(segs);
                    state.selected = { line: sel.line, seg: sel.seg + 1 };
                    commit(lines.join('\n'));
                    break;
                }
                case 'delete': {
                    const lines = state.text.split('\n');
                    const segs = splitSegments(lines[sel.line]);
                    segs.splice(sel.seg, 1);
                    if (!segs.length) segs.push({ lead: '', body: '', tail: '' });
                    lines[sel.line] = joinSegments(segs);
                    state.selected = null;
                    // drop the line entirely when it ended up empty as the last line
                    if (sel.line === lines.length - 1 && !lines[sel.line].trim() && lines.length > 1) lines.pop();
                    commit(lines.join('\n'));
                    break;
                }
                case 'close':
                    state.selected = null;
                    render();
                    break;
                default:
                    if (action.indexOf('w-') === 0) {
                        const w = parseFloat(action.slice(2));
                        if (!isNaN(w)) write(rebuild(token, w, token.disabled));
                    }
                    break;
            }
        }

        function toggleLineComment(lineIndex) {
            mapLine(lineIndex, (line) => {
                const trimmed = line.replace(/^\s+/, '');
                const indent = line.slice(0, line.length - trimmed.length);
                // an '@IF' / '@MACRO' line is a directive: commenting it out adds the
                // marker instead of stripping it ('# @IF …' is the comment form)
                if (/^#(?!\()/.test(trimmed) && !isConditionLine(trimmed) && !isMacroLine(trimmed)) {
                    const body = trimmed.slice(1).replace(/^ /, '');
                    return indent + body;
                }
                if (trimmed === '') return line;
                return indent + '# ' + trimmed;
            });
        }

        function uncommentAll() {
            const lines = state.text.split('\n').map((line) => {
                const trimmed = line.replace(/^\s+/, '');
                const indent = line.slice(0, line.length - trimmed.length);
                return /^#(?!\()/.test(trimmed) ? indent + trimmed.slice(1).replace(/^ /, '') : line;
            });
            commit(lines.join('\n'));
        }

        // ── '# ---' block comments (same contract as javascript/promptComment.js) ──

        function isBlockMarker(line) {
            return /^\s*#\s*-{3,}/.test(line);
        }

        /** {"from", "to"} line indexes covered by the block opened at `index`, or null. */
        function blockBounds(lines, index) {
            if (index < 0 || index >= lines.length || !isBlockMarker(lines[index])) return null;
            for (let i = index + 1; i < lines.length; i += 1) {
                if (isBlockMarker(lines[i])) return { from: index + 1, to: i };
            }
            return null;
        }

        function startsWithLineHash(line) {
            if (isConditionLine(line) || isMacroLine(line)) return false; // a directive, not a comment
            const trimmed = line.replace(/^\s+/, '');
            if (trimmed.charAt(0) !== '#') return false;
            return '([<'.indexOf(trimmed.charAt(1)) < 0;
        }

        function blockIsOff(lines, from, to) {
            let any = false;
            for (let i = from; i < to; i += 1) {
                if (!lines[i].trim()) continue;
                any = true;
                if (!startsWithLineHash(lines[i])) return false;
            }
            return any;
        }

        /** Comment / uncomment every line between the marker at `index` and the next one. */
        function toggleBlockComment(index) {
            const lines = state.text.split('\n');
            const bounds = blockBounds(lines, index);
            if (!bounds) return;
            const off = blockIsOff(lines, bounds.from, bounds.to);
            const next = lines.slice();
            for (let i = bounds.from; i < bounds.to; i += 1) {
                const line = next[i];
                if (!line.trim()) continue;
                const trimmed = line.replace(/^\s+/, '');
                const indent = line.slice(0, line.length - trimmed.length);
                if (off) {
                    if (trimmed.slice(0, 2) === '# ') next[i] = indent + trimmed.slice(2);
                    else if (trimmed.charAt(0) === '#') next[i] = indent + trimmed.slice(1);
                } else if (!startsWithLineHash(line)) {
                    next[i] = indent + '# ' + trimmed;
                }
            }
            commit(next.join('\n'));
        }

        function addLine() {
            const base = state.text.replace(/\n*$/, '');
            const next = base + '\n';
            commit(next);
            const newLineIndex = next.split('\n').length - 1; // the trailing empty line
            openInput(newLineIndex);
        }

        // ── inline keyword input + suggestions ──────────────────────────────

        function openInput(lineIndex) {
            state.input = { line: lineIndex, value: '' };
            state.selected = null;
            refreshSuggestions('');
            render();
            const el = root.querySelector('.pedit-input');
            if (el) {
                el.focus();
                el.setSelectionRange(el.value.length, el.value.length);
            }
            const scroller = root.querySelector('.pedit-body');
            if (scroller) scroller.scrollTop = scroller.scrollHeight;
        }

        function closeInput() {
            state.input = null;
            state.suggestions = [];
            state.suggestIdx = 0;
            render();
        }

        function commitInput(value) {
            const text = String(value || '').trim();
            if (!text) {
                closeInput();
                return;
            }
            const lineIndex = state.input ? state.input.line : 0;
            const lines = state.text.split('\n');
            const segs = splitSegments(lines[lineIndex] || '');
            const body = text;
            const emptyOnly = segs.length === 1 && !segs[0].body.trim();
            if (emptyOnly) {
                segs[0] = { lead: '', body: body, tail: '' };
            } else {
                const last = segs[segs.length - 1];
                if (!last.tail) last.tail = ', ';
                segs.push({ lead: '', body: body, tail: '' });
            }
            lines[lineIndex] = joinSegments(segs);
            pushRecent(text);
            state.input = null;
            state.suggestions = [];
            state.selected = { line: lineIndex, seg: emptyOnly ? 0 : segs.length - 1 };
            commit(lines.join('\n'));
        }

        function pushRecent(text) {
            try {
                let list = JSON.parse(readLS(LS_RECENT, '[]'));
                if (!Array.isArray(list)) list = [];
                list = [text].concat(list.filter((x) => x !== text)).slice(0, 40);
                writeLS(LS_RECENT, JSON.stringify(list));
                state.pool = null; // rebuild with the new MRU entry
            } catch (e) {
                /* ignore */
            }
        }

        function pool() {
            const base = [];
            // recently used keywords first
            try {
                JSON.parse(readLS(LS_RECENT, '[]')).forEach((k) => base.push(k));
            } catch (e) { /* ignore */ }

            // endorsed keyword pool (gallery suggestions JSON, already in the DOM)
            try {
                const box = gradioApp().querySelector('#endgal_fire_value_suggestions_json textarea');
                if (box && box.value) {
                    const data = JSON.parse(box.value);
                    ['Prompt', 'Negative prompt'].forEach((key) => {
                        (data[key] || []).forEach((k) => base.push(String(k)));
                    });
                }
            } catch (e) { /* ignore */ }

            // extra networks (LoRA / embeddings / hypernetworks) from the cards
            try {
                gradioApp().querySelectorAll('.card[data-name]').forEach((card) => {
                    const onclick = String(card.getAttribute('onclick') || '');
                    const name = card.getAttribute('data-name') || '';
                    if (!name) return;
                    if (onclick.indexOf('selectLora') >= 0 || onclick.indexOf('selectLyco') >= 0) base.push('<lora:' + name + ':1>');
                    else if (onclick.indexOf('selectHypernetwork') >= 0 || onclick.indexOf('addHypernetworkToPrompt') >= 0) base.push('<hypernet:' + name + ':1>');
                    else if (onclick.indexOf('addEmbeddingToPrompt') >= 0) base.push(name);
                });
            } catch (e) { /* ignore */ }

            const seen = new Set();
            return base.filter((k) => {
                const key = String(k).toLowerCase();
                if (seen.has(key)) return false;
                seen.add(key);
                return true;
            });
        }

        function refreshSuggestions(value) {
            const needle = String(value || '').trim().toLowerCase();
            if (!state.pool) state.pool = pool();
            const list = state.pool;
            if (!needle) {
                state.suggestions = list.slice(0, MAX_SUGGEST);
            } else {
                const starts = [];
                const contains = [];
                for (let i = 0; i < list.length; i++) {
                    const k = list[i];
                    const lk = k.toLowerCase();
                    if (lk.startsWith(needle)) starts.push(k);
                    else if (lk.indexOf(needle) >= 0) contains.push(k);
                    if (starts.length >= MAX_SUGGEST * 2) break;
                }
                state.suggestions = starts.concat(contains).slice(0, MAX_SUGGEST);
            }
            state.suggestIdx = 0;
        }

        // ── events ──────────────────────────────────────────────────────────

        root.addEventListener('pointerdown', (e) => {
            const target = e.target;
            if (!target || !target.closest) return;
            const chip = target.closest('.pedit-chip');
            if (chip && chip.dataset.seg !== undefined) {
                const line = parseInt(chip.dataset.line, 10);
                const seg = parseInt(chip.dataset.seg, 10);
                const same = state.selected && state.selected.line === line && state.selected.seg === seg;
                state.selected = same ? null : { line: line, seg: seg };
                render();
                e.preventDefault();
                return;
            }
            const blockToggle = target.closest('.pedit-block-toggle');
            if (blockToggle) {
                toggleBlockComment(parseInt(blockToggle.dataset.line, 10));
                e.preventDefault();
                return;
            }
            const gutter = target.closest('.pedit-gutter');
            if (gutter) {
                toggleLineComment(parseInt(gutter.dataset.line, 10));
                e.preventDefault();
                return;
            }
            const add = target.closest('.pedit-add');
            if (add) {
                openInput(parseInt(add.dataset.line, 10));
                e.preventDefault();
                return;
            }
            const act = target.closest('.pedit-act');
            if (act) {
                applyChipAction(act.dataset.act);
                e.preventDefault();
                return;
            }
            const head = target.closest('.pedit-head-btn');
            if (head) {
                const a = head.dataset.act;
                if (a === 'to-text') setMode('text');
                else if (a === 'add-line') addLine();
                else if (a === 'uncomment-all') uncommentAll();
                e.preventDefault();
                return;
            }
            const sug = target.closest('.pedit-suggest-item');
            if (sug) {
                const item = state.suggestions[parseInt(sug.dataset.suggest, 10)];
                if (item) commitInput(item);
                e.preventDefault();
                return;
            }
            if (target.closest('.pedit-insert-ok')) {
                const el = root.querySelector('.pedit-input');
                if (el) commitInput(el.value);
                e.preventDefault();
                return;
            }
            if (target.closest('.pedit-insert-cancel')) {
                closeInput();
                e.preventDefault();
                return;
            }
        });

        root.addEventListener('input', (e) => {
            if (e.target && e.target.classList && e.target.classList.contains('pedit-input')) {
                state.input.value = e.target.value;
                refreshSuggestions(e.target.value);
                renderSuggestOnly();
            }
        });

        root.addEventListener('keydown', (e) => {
            if (!e.target || !e.target.classList || !e.target.classList.contains('pedit-input')) return;
            if (e.key === 'Enter') {
                e.preventDefault();
                const pick = state.suggestions[state.suggestIdx];
                commitInput(e.target.value.trim() ? e.target.value : (pick || ''));
            } else if (e.key === 'Tab' && state.suggestions.length) {
                e.preventDefault();
                e.target.value = state.suggestions[state.suggestIdx];
                state.input.value = e.target.value;
                refreshSuggestions(e.target.value);
                renderSuggestOnly();
            } else if (e.key === 'ArrowDown') {
                e.preventDefault();
                state.suggestIdx = Math.min(state.suggestions.length - 1, state.suggestIdx + 1);
                renderSuggestOnly();
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                state.suggestIdx = Math.max(0, state.suggestIdx - 1);
                renderSuggestOnly();
            } else if (e.key === 'Escape') {
                e.preventDefault();
                closeInput();
            }
        });

        // only re-render the suggestion list while typing so the caret never jumps
        function renderSuggestOnly() {
            const box = root.querySelector('.pedit-suggest');
            if (!box) return;
            const items = state.suggestions;
            box.innerHTML = items.length
                ? items.map((s, i) => `<button type="button" class="pedit-suggest-item ${i === state.suggestIdx ? 'is-active' : ''}" data-suggest="${i}">${escapeHtml(s)}</button>`).join('')
                : '<span class="pedit-suggest-empty">no match — Enter adds the text as typed</span>';
        }

        // keep the textarea in sync when anything else rewrites the value
        (function hookValueSetter(el) {
            const desc = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value');
            if (!desc || !desc.set) return;
            Object.defineProperty(el, 'value', {
                get: function () { return desc.get.call(this); },
                set: function (v) {
                    desc.set.call(this, v);
                    if (mode() === 'chips') syncFromTextarea(true);
                },
                configurable: true,
            });
        })(textarea);

        textarea.addEventListener('input', () => { if (mode() === 'text') return; syncFromTextarea(false); });

        window.addEventListener('pedit-macros-changed', (event) => {
            if (mode() !== 'chips') return;
            if (!event.detail || !event.detail.tab || event.detail.tab === macroTab) render();
        });

        // the replacer rules changed: redraw the inline replace marks
        window.addEventListener('pedit-replacer-changed', (event) => {
            if (!replacerTab || mode() !== 'chips') return;
            if (!event.detail || !event.detail.tab || event.detail.tab === replacerTab) render();
        });

        setInterval(() => {
            if (mode() !== 'chips') return;
            syncFromTextarea(false);
        }, 400);

        // ── mode switch ─────────────────────────────────────────────────────

        function setMode(next) {
            writeLS(LS_MODE, next);
            applyMode();
        }

        function applyMode() {
            const chips = mode() === 'chips';
            host.classList.toggle('pedit-chips-mode', chips);
            root.style.display = chips ? '' : 'none';
            if (chips) {
                state.text = textarea.value || '';
                state.lastCommitted = state.text;
                render();
            }
            // the CodeMirror text-mode editor (javascript/promptCM.mjs) watches this
            host.dispatchEvent(new CustomEvent('pedit-mode', { detail: chips ? 'chips' : 'text' }));
        }

        function mode() {
            const saved = readLS(LS_MODE, '');
            if (saved === 'chips' || saved === 'text') return saved;
            // default: chips on touch devices, classic textarea with a mouse
            const coarse = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
            return coarse ? 'chips' : 'text';
        }

        // floating toggle, visible in text mode (chips mode has its own header)
        const fab = document.createElement('button');
        fab.type = 'button';
        fab.className = 'pedit-fab';
        fab.textContent = '🧩 Chips';
        fab.title = 'Switch to the chip editor (touch friendly: tap keywords to toggle / adjust weight)';
        fab.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            setMode('chips');
        });
        host.appendChild(fab);

        host.addEventListener('pedit-set-mode', (e) => setMode(e.detail));

        applyMode();
        if (mode() === 'chips') render();

        // expose the mode switch to the rest of the UI (all hosts share one mode)
        window.promptEditorSetMode = (m) => {
            writeLS(LS_MODE, m);
            HOST_IDS.forEach((id) => {
                const h = gradioApp().querySelector('#' + id);
                if (h) h.dispatchEvent(new CustomEvent('pedit-set-mode', { detail: m }));
            });
        };

        // shared with the CodeMirror text-mode editor (javascript/promptCM.mjs): the
        // same MRU + endorsed + extra-network pool, and the same MRU writer
        window.promptEditorMode = mode;
        window.promptEditorPool = pool;
        window.promptEditorPushRecent = pushRecent;
    }

    function installAll() {
        const app = gradioApp();
        HOST_IDS.forEach((id) => {
            const host = app.querySelector('#' + id);
            if (host) installOn(host);
        });
    }

    onUiLoaded(installAll);
    onAfterUiUpdate(installAll);

    // exposed for the node test in tmp/pedit_test.js (prompt text must never be
    // corrupted, so the parser/serialiser pair is unit tested)
    window.promptEditorDebug = {
        splitSegments: splitSegments,
        joinSegments: joinSegments,
        classify: classify,
        rebuild: rebuild,
        formatWeight: formatWeight,
        analyzeAtSyntax: analyzeAtSyntax,
        findPickGroups: findPickGroups,
        syntaxHint: syntaxHint,
        isConditionLine: isConditionLine,
        isMacroLine: isMacroLine,
        analyzeMacroLine: analyzeMacroLine,
        parseCondition: parseCondition,
        analyzeConditionLine: analyzeConditionLine,
        analyzeConditionLines: analyzeConditionLines,
    };
})();
