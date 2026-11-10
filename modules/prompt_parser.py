from __future__ import annotations

import random
import re
from collections import namedtuple
import lark

from modules.prompt_syntax import CONDITION_DIRECTIVE_RE

# a prompt like this: "fantasy landscape with a [mountain:lake:0.25] and [an oak:a christmas tree:0.75][ in foreground::0.6][: in background:0.25] [shoddy:masterful:0.5]"
# will be represented with prompt_schedule like this (assuming steps=100):
# [25, 'fantasy landscape with a mountain and an oak in foreground shoddy']
# [50, 'fantasy landscape with a lake and an oak in foreground in background shoddy']
# [60, 'fantasy landscape with a lake and an oak in foreground in background masterful']
# [75, 'fantasy landscape with a lake and an oak in background masterful']
# [100, 'fantasy landscape with a lake and a christmas tree in background masterful']

schedule_parser = lark.Lark(r"""
!start: (prompt | /[][():]/+)*
prompt: (emphasized | scheduled | alternate | plain | WHITESPACE)*
!emphasized: "(" prompt ")"
        | "(" prompt ":" prompt ")"
        | "[" prompt "]"
scheduled: "[" [prompt ":"] prompt ":" [WHITESPACE] NUMBER [WHITESPACE] "]"
alternate: "[" prompt ("|" [prompt])+ "]"
WHITESPACE: /\s+/
plain: /([^\\\[\]():|]|\\.)+/
%import common.SIGNED_NUMBER -> NUMBER
""")

# ── random pick / sequence groups ────────────────────────────────────────────
#
# @PICK{a, b, c}       - one of the keywords, drawn at random
# @PICK(2){a, b, c}    - two of the keywords, drawn at random
# @SEQ{a, b, c}        - the keywords are used in turn: image 1 gets 'a', image 2
#                        gets 'b', … and the list starts over after the last keyword
# @SEQ(3){a, b}        - each keyword is used for 3 images in turn: image 1-3 get
#                        'a', image 4-6 get 'b', then the list starts over
# @SEQ(3, 2){a, b}     - the same, starting with the second keyword: 'b' 3 times,
#                        then 'a' 3 times, …
#
# The count must be 1 or more; the optional start is the 1-based keyword a sequence
# begins with and wraps around like the sequence itself.  A malformed group
# (unknown tag, bad count, missing brace, empty list) is left as typed, so the
# prompt editor can flag it in place.  The groups are resolved once per generated
# image (see StableDiffusionProcessing.apply_random_picks), so a batch count of 16
# spends 16 independent draws and a @SEQ group walks through 16 positions.

re_prompt_group = re.compile(
    r"@(?:"
    r"(?P<pick>pick)[ \t]*(?:\([ \t]*(?P<pick_count>0*[1-9]\d*)[ \t]*\)[ \t]*)?"
    r"|"
    r"(?P<seq>seq)[ \t]*(?:\([ \t]*(?P<seq_count>0*[1-9]\d*)[ \t]*(?:,[ \t]*(?P<seq_start>0*[1-9]\d*)[ \t]*)?\)[ \t]*)?"
    r")\{",
    re.IGNORECASE,
)

_OPENING = "([{<"
_CLOSING = ")]}>"


def split_pick_items(text: str) -> list[str]:
    """Splits the inside of an @PICK group at top level commas and drops empty keywords.

    Commas inside (), [], {} or <> stay part of the keyword, so weighted and
    nested constructs survive:

    >>> split_pick_items("a, b (x, y), c")
    ['a', 'b (x, y)', 'c']
    >>> split_pick_items(" , a, , b, ")
    ['a', 'b']
    """
    items = []
    current = []
    depth = 0

    for ch in text:
        if ch in _OPENING:
            depth += 1
        elif ch in _CLOSING:
            depth = max(0, depth - 1)

        if ch == ',' and depth == 0:
            items.append(''.join(current))
            current = []
        else:
            current.append(ch)

    items.append(''.join(current))
    return [item.strip() for item in items if item.strip()]


def pick_items(items, count, rng) -> str:
    """Returns `count` distinct keywords joined with ', ' in their original order.

    `count` is clamped to the number of keywords; a group of one keyword (or a
    count that covers them all) resolves to every keyword, without a draw.
    """
    if not items:
        return ''

    count = min(max(int(count), 1), len(items))
    if count >= len(items):
        return ', '.join(items)

    return ', '.join(items[i] for i in sorted(rng.sample(range(len(items)), count)))


def sequence_items(items, count, index, start: int = 1) -> str:
    """Returns the keyword the `index`-th image uses.

    Each keyword is used for `count` consecutive images in turn, wrapping around
    after the last one; `start` is the 1-based keyword the first image uses.

    >>> sequence_items(['a', 'b'], 3, 0)
    'a'
    >>> sequence_items(['a', 'b'], 3, 3)
    'b'
    >>> sequence_items(['a', 'b'], 3, 6)
    'a'
    >>> sequence_items(['a', 'b', 'c'], 1, 1, start=2)
    'c'
    """
    if not items:
        return ''

    count = max(int(count), 1)
    position = int(start) - 1 + int(index) // count
    return items[position % len(items)]


def find_prompt_group(text: str, start: int):
    """Locates the @PICK / @SEQ group starting at `start`.

    Returns (keywords start, keywords end, count, first, tag) - the indexes point
    into `text`, the end being exclusive; `count` is the number of keywords drawn
    per image for @PICK and the number of images a keyword is used for @SEQ,
    `first` is the 1-based keyword an @SEQ group starts with, and the tag is
    'pick' or 'seq' - or None when the tag does not open a closed group.
    """
    match = re_prompt_group.match(text, start)
    if match is None:
        return None

    if match.group('seq'):
        count = int(match.group('seq_count') or 1)
        first = int(match.group('seq_start') or 1)
        tag = 'seq'
    else:
        count = int(match.group('pick_count') or 1)
        first = 1
        tag = 'pick'

    depth = 1
    index = match.end()
    while index < len(text):
        ch = text[index]
        if ch == '{':
            depth += 1
        elif ch == '}':
            depth -= 1
            if depth == 0:
                return match.end(), index, count, first, tag
        index += 1

    return None


def expand_prompt_picks(prompt: str, rng=None, sequence_index: int = 0) -> str:
    """Replaces every @PICK / @SEQ group in `prompt` with the keywords it resolves to.

    @PICK draws at random (seeded by `rng`), @SEQ walks the keyword list with
    `sequence_index` - the position of the image inside the generation - uses each
    keyword for `count` consecutive images in turn and loops after the last
    keyword; the optional start picks the keyword the first image uses.  Groups
    are expanded inside out, so a group may contain another group.  Groups that are
    not properly closed, or that have no keywords, are left untouched.

    >>> import random
    >>> expand_prompt_picks("@PICK(3){a, b, c}", random.Random(0))
    'a, b, c'
    >>> expand_prompt_picks("@PICK(9){a, b}", random.Random(0))
    'a, b'
    >>> expand_prompt_picks("@PICK ( 2 ) {a, b, c}", random.Random(4)).count(', ')
    1
    >>> expand_prompt_picks("@PICK{a, b, c}", random.Random(3)) in ('a', 'b', 'c')
    True
    >>> expand_prompt_picks("@pick{a (x, y), b, c}", random.Random(3)).count(', ') >= 1
    True
    >>> expand_prompt_picks("@PICK{a, b, c}", random.Random(3)) == expand_prompt_picks("@PICK{a, b, c}", random.Random(3))
    True
    >>> expand_prompt_picks("@SEQ{a, b, c}", sequence_index=0)
    'a'
    >>> expand_prompt_picks("@SEQ{a, b, c}", sequence_index=1)
    'b'
    >>> expand_prompt_picks("@SEQ{a, b, c}", sequence_index=3)
    'a'
    >>> expand_prompt_picks("@SEQ(2){a, b, c}", sequence_index=2)
    'b'
    >>> expand_prompt_picks("@SEQ(2, 2){a, b, c}", sequence_index=0)
    'b'
    >>> expand_prompt_picks("@seq ( 1 ) {a, b, c}", sequence_index=4)
    'b'
    >>> expand_prompt_picks("no picks, here (x:1.2)", random.Random(3))
    'no picks, here (x:1.2)'
    >>> expand_prompt_picks("@PICK{a, b", random.Random(3))
    '@PICK{a, b'
    >>> expand_prompt_picks("@PICK{}", random.Random(3))
    '@PICK{}'
    """
    if not prompt or '@' not in prompt:
        return prompt

    rng = random if rng is None else rng

    parts = []
    position = 0
    while position < len(prompt):
        match = re_prompt_group.search(prompt, position)
        if match is None:
            break

        group = find_prompt_group(prompt, match.start())
        if group is None:
            parts.append(prompt[position:match.end()])
            position = match.end()
            continue

        keywords_start, keywords_end, count, first, tag = group
        keywords = expand_prompt_picks(prompt[keywords_start:keywords_end], rng, sequence_index)
        items = split_pick_items(keywords)

        parts.append(prompt[position:match.start()])
        if items:
            if tag == 'seq':
                parts.append(sequence_items(items, count, sequence_index, first))
            else:
                parts.append(pick_items(items, count, rng))
        else:
            parts.append(prompt[match.start():keywords_end + 1])
        position = keywords_end + 1

    parts.append(prompt[position:])
    return ''.join(parts)


# ── comments ─────────────────────────────────────────────────────────────────
#
# Prompt text supports two comment forms, both produced by the chip editors in
# javascript/promptEditor.js and mobile_lite/js/prompt.js and understood by hand:
#
# * whole-line comments - a line whose first non-whitespace character is '#'
#   (a line starting with '#' followed by '(', '[' or '<' is NOT a comment, it
#   starts with a disabled keyword group; an '@IF' / '@ELSEIF' / '@ELSE' / '@ENDIF'
#   line is a stage directive, not a comment either);
# * inline disabled groups - #(keyword), #[keyword], #<lora:x:1> anywhere in a
#   line; the group is dropped, the rest of the line is kept.


def strip_prompt_comments(text: str) -> str:
    """Removes prompt comments and disabled keywords from a prompt.

    Used to build the prompt lists scripts and the model work with, so
    scripts.process() and the diffusion model always receive clean prompts.  The
    originals (with comments) are preserved in all_prompts_with_comments /
    all_negative_prompts_with_comments for PNG metadata and gallery restore, and
    the source with the @PICK groups drawn and the @SEQ groups stepped is what the
    gallery stores as the compiled prompt.  The '@IF' block directives and '@MACRO'
    definitions are kept here (strip_condition_directives removes them just before
    conditioning).

    >>> strip_prompt_comments("a, b\\n# comment\\n#(off), c")
    'a, b\\nc'
    >>> strip_prompt_comments("@IF TXT2IMG")
    '@IF TXT2IMG'
    """
    if not text:
        return text

    # whole-line comments (keep disabled keyword groups; stage directives do not
    # start with '#', so they are never mistaken for a comment)
    lines = [
        line for line in text.split('\n')
        if not re.match(r'^\s*#(?![\[(<])', line)
    ]
    out = '\n'.join(lines)

    # inline disabled groups; loop because the pattern unwraps one nesting level per pass
    pattern = re.compile(r'#\((?:[^()]|\([^()]*\))*\)|#\[(?:[^\[\]]|\[[^\[\]]*\])*\]|#<[^<>]*>')
    previous = None
    while previous != out:
        previous = out
        out = pattern.sub('', out)

    # tidy the separators the removed groups left behind (generation only - the
    # metadata keeps the untouched original text)
    previous = None
    while previous != out:
        previous = out
        out = re.sub(r',[ \t]*,[ \t]*', ', ', out)
    out = re.sub(r'^[ \t]*,[ \t]*', '', out, flags=re.M)  # group was at the start of a line
    out = re.sub(r'[ \t]+$', '', out, flags=re.M)
    return out


# ── custom macros ────────────────────────────────────────────────────────────
#
# @MACRO(FLAG)                 boolean macro, off by default
# @MACRO(MOOD){happy, sad}     enum macro, first alias by default
#
# A name used in a condition without a definition is an ordinary boolean macro
# that is off.  Macro values come from the UI (or defaults); definitions are
# stripped from the model-facing prompt together with the @IF lines.

# ── conditional blocks ───────────────────────────────────────────────────────
#
# @IF TXT2IMG
#   sharp focus, 8k
# @ELSEIF HIRES_FIX
#   detailed texture
# @ELSE
#   soft focus
# @ENDIF
#
# A block is resolved for the stage that is currently running, so one prompt can
# carry per-stage text: the first pass sees the TXT2IMG branch, the hires pass
# the HIRES_FIX branch.  Every macro is 1 while its stage runs and 0 otherwise;
# HIRES_FIX is an img2img pass and POSE_INPAINT an inpaint pass, so the lower
# stage is 1 as well.  POSE_INPAINT_PART is the enum of the pose inpaint pass:
# 0 (none) during every other stage, FACE, FEET or HANDS inside a pose pass.
#
# Conditions are a small boolean expression: macro names, 0/1 values, the enum
# names, ==, !=, !, && (and), || (or) and parentheses.  A block that is not
# closed, or an @ELSEIF/@ELSE/@ENDIF without its @IF, is left as typed so the
# prompt editor can flag it in place.  An undeclared name is an off boolean; a
# condition that cannot be evaluated (broken expression) counts as false.

re_condition_directive = CONDITION_DIRECTIVE_RE
re_condition_token = re.compile(r"[ \t]*(?:(?P<operator>!=|==|&&|\|\||[!()])|(?P<word>[A-Za-z_][A-Za-z0-9_]*)|(?P<number>-?\d+(?:\.\d+)?)|(?P<other>\S))")
re_macro_definition = re.compile(
    r"^[ \t]*@MACRO[ \t]*\([ \t]*(?P<name>[A-Za-z_][A-Za-z0-9_]*)[ \t]*\)"
    r"[ \t]*(?P<values>\{[^\n]*\})?[ \t]*$",
    re.IGNORECASE,
)
re_macro_directive = re.compile(r"^[ \t]*@MACRO(?![A-Za-z0-9_])", re.IGNORECASE)

PROMPT_MACROS = ("TXT2IMG", "HIRES_FIX", "IMG2IMG", "INPAINT", "POSE_INPAINT", "POSE_INPAINT_PART")
POSE_INPAINT_PARTS = ("NONE", "FACE", "FEET", "HANDS")
POSE_REGION_PARTS = {
    "face": "FACE",
    "left_hand": "HANDS",
    "right_hand": "HANDS",
    "left_foot": "FEET",
    "right_foot": "FEET",
}

# every stage and the macros that are 1 while it runs
_STAGE_MACROS = {
    "txt2img": ("TXT2IMG",),
    "hires_fix": ("HIRES_FIX", "IMG2IMG"),
    "img2img": ("IMG2IMG",),
    "inpaint": ("INPAINT", "IMG2IMG"),
    "pose_inpaint": ("POSE_INPAINT", "INPAINT", "IMG2IMG"),
}


def stage_macros(stage=None, inpaint=None, pose_part=None) -> dict:
    """Macro values of one generation stage, for expand_prompt_conditions().

    >>> stage_macros("hires_fix")["IMG2IMG"], stage_macros("hires_fix")["TXT2IMG"]
    (1, 0)
    >>> stage_macros("img2img", inpaint=True)["INPAINT"]
    1
    >>> stage_macros("pose_inpaint", pose_part="FACE")["POSE_INPAINT_PART"]
    'FACE'
    >>> stage_macros("txt2img")["POSE_INPAINT_PART"]
    0
    """
    name = str(stage or "").strip().lower()
    if name == "img2img" and inpaint:
        name = "inpaint"

    macros = dict.fromkeys(PROMPT_MACROS, 0)
    for macro in _STAGE_MACROS.get(name, ()):
        macros[macro] = 1

    macros["POSE_INPAINT_PART"] = pose_inpaint_part(pose_part)
    return macros


def parse_macro_definition(line: str):
    """Parses one `@MACRO(name)` / `@MACRO(name){a, b, c}` line.

    Returns `{key, name, type, values, default}` or None when the line is not a
    valid definition.  A definition without braces is a boolean macro defaulting
    to 0; one with braces is an enum whose first value is the default.

    >>> parse_macro_definition("@MACRO(FLAG)")
    {'key': 'FLAG', 'name': 'FLAG', 'type': 'bool', 'values': [], 'default': 0}
    >>> parse_macro_definition("@MACRO(mood){happy, sad}")['default']
    'happy'
    >>> parse_macro_definition("@MACRO()")
    """
    match = re_macro_definition.match(str(line or ""))
    if match is None:
        return None

    name = match.group("name")
    raw_values = match.group("values")
    values = []
    if raw_values is not None:
        values = split_pick_items(raw_values[1:-1])
        if not values:
            return None

    return {
        "key": name.upper(),
        "name": name,
        "type": "enum" if raw_values is not None else "bool",
        "values": values,
        "default": values[0] if values else 0,
    }


def parse_macro_definitions(text) -> dict:
    """The custom macro definitions of one prompt, keyed by upper-case name."""
    definitions = {}
    if not isinstance(text, str) or "@" not in text:
        return definitions
    for line in text.split("\n"):
        definition = parse_macro_definition(line)
        if definition is not None:
            definitions[definition["key"]] = definition
    return definitions


def _macro_bool(value) -> int:
    if isinstance(value, bool):
        return 1 if value else 0
    if isinstance(value, (int, float)):
        return 1 if value else 0
    return 1 if str(value or "").strip().lower() in ("1", "true", "on", "yes") else 0


def custom_macro_values(prompts, selected=None) -> dict:
    """Current values of the custom macros defined in `prompts`.

    `selected` is the UI state (`{name: value}`); a missing or invalid value falls
    back to the definition default (0 for a bool, the first alias for an enum).
    System macros are never overridden.

    >>> values = custom_macro_values("@MACRO(FLAG)\\n@MACRO(MOOD){happy, sad}", {"FLAG": True, "MOOD": "sad"})
    >>> values["FLAG"], values["MOOD"]
    (1, 'sad')
    >>> custom_macro_values("@MACRO(MOOD){happy, sad}", {"MOOD": "angry"})["MOOD"]
    'happy'
    """
    texts = prompts if isinstance(prompts, (list, tuple)) else [prompts]
    definitions = {}
    for text in texts:
        definitions.update(parse_macro_definitions(text))

    selected = selected if isinstance(selected, dict) else {}
    selected = {str(key).upper(): value for key, value in selected.items()}

    values = {}
    for key, definition in definitions.items():
        if key in PROMPT_MACROS:
            continue
        chosen = selected.get(key, definition["default"])
        if definition["type"] == "enum":
            allowed = {value.upper() for value in definition["values"]}
            values[key] = chosen if isinstance(chosen, str) and chosen.strip().upper() in allowed else definition["default"]
        else:
            values[key] = _macro_bool(chosen)

    # Undeclared names are boolean macros too; the editor sends their toggles.
    for key, chosen in selected.items():
        if key not in PROMPT_MACROS and key not in values:
            values[key] = _macro_bool(chosen)
    return values


def macros_for_prompts(stage=None, prompts=None, selected=None, **kwargs) -> dict:
    """stage_macros() plus the custom macros defined in `prompts` and `selected`."""
    macros = stage_macros(stage, **kwargs)
    macros.update(custom_macro_values(prompts, selected))
    return macros


def pose_inpaint_part(value) -> int | str:
    """Normalises a pose part to the POSE_INPAINT_PART enum: 0, 'FACE', 'FEET' or 'HANDS'.

    Accepts the enum value itself, a pose mask region code ('left_hand') or the
    part name the pose inpaint script uses ('Face').

    >>> pose_inpaint_part("left_hand")
    'HANDS'
    >>> pose_inpaint_part("Face")
    'FACE'
    >>> pose_inpaint_part(None)
    0
    """
    if value is None:
        return 0

    text = str(value).strip().upper().replace(" ", "_")
    if text in ("", "0", "NONE", "FALSE", "ALL"):
        return 0
    if text in POSE_REGION_PARTS:
        return POSE_REGION_PARTS[text]
    if text in POSE_INPAINT_PARTS:
        return text
    # 'LEFT_HAND' / 'RIGHT_FOOT' style codes, and already normalised names
    lowered = text.lower()
    if lowered in POSE_REGION_PARTS:
        return POSE_REGION_PARTS[lowered]
    if lowered in ("hand", "hands"):
        return "HANDS"
    if lowered in ("foot", "feet"):
        return "FEET"
    if lowered == "face":
        return "FACE"
    return 0


def _comparable(value):
    """Comparable form of a macro value or condition literal (NONE/0 are the same)."""
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return "num", value
    if isinstance(value, bool):
        return "num", int(value)

    text = str(value).strip().upper()
    if text in ("", "0", "NONE", "FALSE", "OFF"):
        return "num", 0
    if re.fullmatch(r"-?\d+", text):
        return "num", int(text)
    return "text", text


def _truthy(value) -> bool:
    return _comparable(value) != ("num", 0)


def _condition_tokens(expression: str) -> list:
    tokens = []
    position = 0
    while position < len(expression):
        match = re_condition_token.match(expression, position)
        if match is None:
            raise ValueError(expression)
        operator = match.group("operator")
        word = match.group("word")
        number = match.group("number")
        if operator:
            tokens.append(("op", operator))
        elif word:
            tokens.append(("word", word))
        elif number:
            tokens.append(("number", number))
        else:
            raise ValueError(expression)
        position = match.end()
    return tokens


def _condition_primary(tokens, index, macros):
    if index >= len(tokens):
        raise ValueError("missing operand")

    kind, value = tokens[index]
    if kind == "op" and value == "!":
        result, index = _condition_primary(tokens, index + 1, macros)
        return not result, index

    if kind == "op" and value == "(":
        result, index = _condition_or(tokens, index + 1, macros)
        if index >= len(tokens) or tokens[index] != ("op", ")"):
            raise ValueError("missing )")
        return result, index + 1

    if kind == "word":
        name = value.upper()
        # an undefined name is an ordinary boolean macro that is off
        left = macros.get(name, 0)
        index += 1
        if index < len(tokens) and tokens[index][0] == "op" and tokens[index][1] in ("==", "!="):
            operator = tokens[index][1]
            index += 1
            if index >= len(tokens) or tokens[index][0] not in ("word", "number"):
                raise ValueError("missing comparison value")
            right = tokens[index][1]
            index += 1
            equal = _comparable(left) == _comparable(right)
            return (not equal) if operator == "!=" else equal, index
        return _truthy(left), index

    raise ValueError(f"unexpected {value}")


def _condition_and(tokens, index, macros):
    result, index = _condition_primary(tokens, index, macros)
    while index < len(tokens):
        kind, value = tokens[index]
        if not (kind == "op" and value == "&&") and not (kind == "word" and value.lower() == "and"):
            break
        right, index = _condition_primary(tokens, index + 1, macros)
        result = result and right
    return result, index


def _condition_or(tokens, index, macros):
    result, index = _condition_and(tokens, index, macros)
    while index < len(tokens):
        kind, value = tokens[index]
        if not (kind == "op" and value == "||") and not (kind == "word" and value.lower() == "or"):
            break
        right, index = _condition_and(tokens, index + 1, macros)
        result = result or right
    return result, index


def evaluate_condition(expression: str, macros=None) -> bool:
    """Evaluates one '@IF' / '@ELSEIF' expression; a broken one is false.

    >>> evaluate_condition("TXT2IMG", stage_macros("txt2img"))
    True
    >>> evaluate_condition("!TXT2IMG && IMG2IMG", stage_macros("hires_fix"))
    True
    >>> evaluate_condition("POSE_INPAINT_PART == FACE", stage_macros("pose_inpaint", pose_part="FACE"))
    True
    >>> evaluate_condition("POSE_INPAINT_PART == FACE", stage_macros("pose_inpaint", pose_part="HANDS"))
    False
    >>> evaluate_condition("NOPE", stage_macros("txt2img"))
    False
    """
    try:
        tokens = _condition_tokens(str(expression or ""))
        if not tokens:
            return False
        result, index = _condition_or(tokens, 0, dict(macros or {}))
    except ValueError:
        return False
    if index != len(tokens):
        return False
    return bool(result)


def condition_blocks(prompt: str) -> list:
    """Line numbers (0-based) of the conditional directives in `prompt`."""
    if not prompt or "@" not in prompt:
        return []
    return [index for index, line in enumerate(prompt.split("\n")) if re_condition_directive.match(line)]


def expand_prompt_conditions(prompt: str, macros=None) -> str:
    """Resolves every @IF / @ELSEIF / @ELSE / @ENDIF block of `prompt` for `macros`.

    Only the text of the branch that runs survives, but *every* directive line of an
    emitted block stays: the `@IF` line, each `@ELSEIF` / `@ELSE` line (with an empty
    body when that branch did not run) and the `@ENDIF` line.  The model-facing prompt
    list therefore keeps the whole macro skeleton - scripts and the editors still see
    which alternatives existed and a second resolution is stable - while the model
    never sees the directives: strip_condition_directives() removes them right before
    the conditioning is built.  The gallery's compiled prompt does not go through
    this function at all (it keeps the prompt as written with the picks drawn).

    Blocks may be nested.  A block that is not closed (or whose @ELSEIF / @ELSE /
    @ENDIF has no @IF) leaves the whole prompt as typed, so nothing is silently
    dropped while the editor flags the mistake.  A block inside a branch that did not
    run is dropped together with its own directives.  An expression that cannot be
    evaluated counts as false.

    >>> prompt = "@IF TXT2IMG\\na\\n@ELSEIF HIRES_FIX\\nb\\n@ELSE\\nc\\n@ENDIF"
    >>> expand_prompt_conditions(prompt, stage_macros("txt2img"))
    '@IF TXT2IMG\\na\\n@ELSEIF HIRES_FIX\\n@ELSE\\n@ENDIF'
    >>> expand_prompt_conditions(prompt, stage_macros("hires_fix"))
    '@IF TXT2IMG\\n@ELSEIF HIRES_FIX\\nb\\n@ELSE\\n@ENDIF'
    >>> expand_prompt_conditions(prompt, stage_macros("img2img"))
    '@IF TXT2IMG\\n@ELSEIF HIRES_FIX\\n@ELSE\\nc\\n@ENDIF'
    >>> expand_prompt_conditions("@IF TXT2IMG\\na", stage_macros("txt2img"))
    '@IF TXT2IMG\\na'
    >>> expand_prompt_conditions("no blocks, here (x:1.2)", stage_macros("txt2img"))
    'no blocks, here (x:1.2)'
    """
    if not prompt or "@" not in prompt:
        return prompt

    macros = dict(macros or {})
    frames = []
    broken = False
    lines = []

    for line in prompt.split("\n"):
        match = re_condition_directive.match(line)
        if match is None:
            if all(frame["active"] for frame in frames):
                lines.append(line)
            continue

        keyword = match.group("keyword").lower()
        expression = match.group("expression").strip()

        if keyword == "if":
            parent = all(frame["active"] for frame in frames)
            take = evaluate_condition(expression, macros)
            # a block inside a dropped branch is dropped together with its directives
            if parent:
                lines.append(line)
            frames.append({"parent": parent, "taken": take, "active": parent and take, "else": False, "emit": parent})
            continue

        if not frames:
            broken = True
            continue

        frame = frames[-1]
        if keyword in ("elif", "elseif"):
            if frame["else"]:
                broken = True
                continue
            # the line stays even when this branch does not run: only its body drops
            if frame["emit"]:
                lines.append(line)
            if frame["taken"] or not frame["parent"]:
                frame["active"] = False
                continue
            take = evaluate_condition(expression, macros)
            frame["active"] = frame["parent"] and take
            frame["taken"] = frame["taken"] or take
            continue

        if keyword == "else":
            if frame["else"]:
                broken = True
                continue
            frame["else"] = True
            frame["active"] = frame["parent"] and not frame["taken"]
            frame["taken"] = True
            if frame["emit"]:
                lines.append(line)
            continue

        if frame["emit"]:
            lines.append(line)
        frames.pop()

    if broken or frames:
        return prompt

    return "\n".join(lines)


def apply_prompt_conditions(prompts, macros) -> list[str]:
    """expand_prompt_conditions() over a prompt list; non-strings pass through.

    >>> apply_prompt_conditions(["@IF TXT2IMG\\na\\n@ENDIF", None], stage_macros("txt2img"))
    ['@IF TXT2IMG\\na\\n@ENDIF', None]
    """
    if not prompts:
        return prompts
    return [expand_prompt_conditions(pr, macros) if isinstance(pr, str) else pr for pr in prompts]


def strip_condition_directives(text: str) -> str:
    """Removes prompt directives (`@IF` blocks and `@MACRO` definitions).

    This is the text the diffusion model is conditioned on: the blocks are already
    resolved, so only the framing and definition lines are left to drop.

    >>> strip_condition_directives("@IF TXT2IMG\\na\\n@ENDIF")
    'a'
    >>> strip_condition_directives("@MACRO(FLAG)\\n@IF FLAG\\na\\n@ENDIF")
    'a'
    >>> strip_condition_directives("no blocks, here")
    'no blocks, here'
    """
    if not text or "@" not in text:
        return text

    lines = [
        line for line in text.split("\n")
        if re_condition_directive.match(line) is None and re_macro_directive.match(line) is None
    ]
    return "\n".join(lines)


def without_condition_directives(prompts) -> list[str]:
    """strip_condition_directives() over a prompt list; non-strings pass through.

    Despite the historical name this also drops @MACRO definitions.

    >>> without_condition_directives(["@IF TXT2IMG\\na\\n@ENDIF", None])
    ['a', None]
    """
    if not prompts:
        return prompts
    return [strip_condition_directives(pr) if isinstance(pr, str) else pr for pr in prompts]


def compile_prompt(text: str, macros=None) -> str:
    """The text a model is conditioned on: resolved blocks, no comments, no directives.

    `@MACRO` definitions and `@IF` framing are removed; custom values are taken
    from `macros` (build it with macros_for_prompts() when the prompt declares
    its own macros).

    The *compiled prompt* the gallery stores is something else: it is the prompt as
    written with the @PICK groups drawn and the @SEQ groups stepped (see
    StableDiffusionProcessing.compiled_prompts_for_image).  This function is the
    last step before the conditioning is built.

    >>> compile_prompt("@IF TXT2IMG\\n# note\\na\\n@ENDIF", stage_macros("txt2img"))
    'a'
    >>> compile_prompt("@IF TXT2IMG\\na\\n@ELSE\\nb\\n@ENDIF", stage_macros("img2img"))
    'b'
    >>> compile_prompt("@MACRO(MOOD){happy, sad}\\n@IF MOOD == happy\\na\\n@ENDIF")
    'a'
    """
    macros = dict(macros or {})
    for key, value in custom_macro_values([text]).items():
        macros.setdefault(key, value)
    return strip_condition_directives(strip_prompt_comments(expand_prompt_conditions(text, macros)))


def get_pick_rng(seed, index=0, kind="prompt"):
    """Random generator for the picks of a single batch item.

    Seeding from the item seed keeps a generation reproducible, while the index
    keeps every batch item independent from the others - including batches where
    all items share one seed (variation seed strength > 0).
    """
    try:
        seed = int(seed)
    except (TypeError, ValueError):
        seed = None

    if seed is None or seed == -1:
        return random.Random()

    return random.Random(f"{kind}:{seed}:{index}")


def get_learned_conditioning_prompt_schedules(prompts, base_steps, hires_steps=None, use_old_scheduling=False):
    """
    >>> g = lambda p: get_learned_conditioning_prompt_schedules([p], 10)[0]
    >>> g("test")
    [[10, 'test']]
    >>> g("a [b:3]")
    [[3, 'a '], [10, 'a b']]
    >>> g("a [b: 3]")
    [[3, 'a '], [10, 'a b']]
    >>> g("a [[[b]]:2]")
    [[2, 'a '], [10, 'a [[b]]']]
    >>> g("[(a:2):3]")
    [[3, ''], [10, '(a:2)']]
    >>> g("a [b : c : 1] d")
    [[1, 'a b  d'], [10, 'a  c  d']]
    >>> g("a[b:[c:d:2]:1]e")
    [[1, 'abe'], [2, 'ace'], [10, 'ade']]
    >>> g("a [unbalanced")
    [[10, 'a [unbalanced']]
    >>> g("a [b:.5] c")
    [[5, 'a  c'], [10, 'a b c']]
    >>> g("a [{b|d{:.5] c")  # not handling this right now
    [[5, 'a  c'], [10, 'a {b|d{ c']]
    >>> g("((a][:b:c [d:3]")
    [[3, '((a][:b:c '], [10, '((a][:b:c d']]
    >>> g("[a|(b:1.1)]")
    [[1, 'a'], [2, '(b:1.1)'], [3, 'a'], [4, '(b:1.1)'], [5, 'a'], [6, '(b:1.1)'], [7, 'a'], [8, '(b:1.1)'], [9, 'a'], [10, '(b:1.1)']]
    >>> g("[fe|]male")
    [[1, 'female'], [2, 'male'], [3, 'female'], [4, 'male'], [5, 'female'], [6, 'male'], [7, 'female'], [8, 'male'], [9, 'female'], [10, 'male']]
    >>> g("[fe|||]male")
    [[1, 'female'], [2, 'male'], [3, 'male'], [4, 'male'], [5, 'female'], [6, 'male'], [7, 'male'], [8, 'male'], [9, 'female'], [10, 'male']]
    >>> g = lambda p: get_learned_conditioning_prompt_schedules([p], 10, 10)[0]
    >>> g("a [b:.5] c")
    [[10, 'a b c']]
    >>> g("a [b:1.5] c")
    [[5, 'a  c'], [10, 'a b c']]
    """

    if hires_steps is None or use_old_scheduling:
        int_offset = 0
        flt_offset = 0
        steps = base_steps
    else:
        int_offset = base_steps
        flt_offset = 1.0
        steps = hires_steps

    def collect_steps(steps, tree):
        res = [steps]

        class CollectSteps(lark.Visitor):
            def scheduled(self, tree):
                s = tree.children[-2]
                v = float(s)
                if use_old_scheduling:
                    v = v*steps if v<1 else v
                else:
                    if "." in s:
                        v = (v - flt_offset) * steps
                    else:
                        v = (v - int_offset)
                tree.children[-2] = min(steps, int(v))
                if tree.children[-2] >= 1:
                    res.append(tree.children[-2])

            def alternate(self, tree):
                res.extend(range(1, steps+1))

        CollectSteps().visit(tree)
        return sorted(set(res))

    def at_step(step, tree):
        class AtStep(lark.Transformer):
            def scheduled(self, args):
                before, after, _, when, _ = args
                yield before or () if step <= when else after
            def alternate(self, args):
                args = ["" if not arg else arg for arg in args]
                yield args[(step - 1) % len(args)]
            def start(self, args):
                def flatten(x):
                    if isinstance(x, str):
                        yield x
                    else:
                        for gen in x:
                            yield from flatten(gen)
                return ''.join(flatten(args))
            def plain(self, args):
                yield args[0].value
            def __default__(self, data, children, meta):
                for child in children:
                    yield child
        return AtStep().transform(tree)

    def get_schedule(prompt):
        try:
            tree = schedule_parser.parse(prompt)
        except lark.exceptions.LarkError:
            if 0:
                import traceback
                traceback.print_exc()
            return [[steps, prompt]]
        return [[t, at_step(t, tree)] for t in collect_steps(steps, tree)]

    promptdict = {prompt: get_schedule(prompt) for prompt in set(prompts)}
    return [promptdict[prompt] for prompt in prompts]


ScheduledPromptConditioning = namedtuple("ScheduledPromptConditioning", ["end_at_step", "cond"])


class SdConditioning(list):
    """
    A list with prompts for stable diffusion's conditioner model.
    Can also specify width and height of created image - SDXL needs it.
    """
    def __init__(self, prompts, is_negative_prompt=False, width=None, height=None, copy_from=None):
        super().__init__()
        self.extend(prompts)

        if copy_from is None:
            copy_from = prompts

        self.is_negative_prompt = is_negative_prompt or getattr(copy_from, 'is_negative_prompt', False)
        self.width = width or getattr(copy_from, 'width', None)
        self.height = height or getattr(copy_from, 'height', None)



def get_learned_conditioning(model, prompts: SdConditioning | list[str], steps, hires_steps=None, use_old_scheduling=False):
    """converts a list of prompts into a list of prompt schedules - each schedule is a list of ScheduledPromptConditioning, specifying the comdition (cond),
    and the sampling step at which this condition is to be replaced by the next one.

    Input:
    (model, ['a red crown', 'a [blue:green:5] jeweled crown'], 20)

    Output:
    [
        [
            ScheduledPromptConditioning(end_at_step=20, cond=tensor([[-0.3886,  0.0229, -0.0523,  ..., -0.4901, -0.3066,  0.0674], ..., [ 0.3317, -0.5102, -0.4066,  ...,  0.4119, -0.7647, -1.0160]], device='cuda:0'))
        ],
        [
            ScheduledPromptConditioning(end_at_step=5, cond=tensor([[-0.3886,  0.0229, -0.0522,  ..., -0.4901, -0.3067,  0.0673], ..., [-0.0192,  0.3867, -0.4644,  ...,  0.1135, -0.3696, -0.4625]], device='cuda:0')),
            ScheduledPromptConditioning(end_at_step=20, cond=tensor([[-0.3886,  0.0229, -0.0522,  ..., -0.4901, -0.3067,  0.0673], ..., [-0.7352, -0.4356, -0.7888,  ...,  0.6994, -0.4312, -1.2593]], device='cuda:0'))
        ]
    ]
    """
    res = []

    prompt_schedules = get_learned_conditioning_prompt_schedules(prompts, steps, hires_steps, use_old_scheduling)
    cache = {}

    for prompt, prompt_schedule in zip(prompts, prompt_schedules):

        cached = cache.get(prompt, None)
        if cached is not None:
            res.append(cached)
            continue

        texts = SdConditioning([x[1] for x in prompt_schedule], copy_from=prompts)
        conds = model.get_learned_conditioning(texts)

        cond_schedule = []
        for i, (end_at_step, _) in enumerate(prompt_schedule):
            if isinstance(conds, dict):
                cond = {k: v[i] for k, v in conds.items()}
            else:
                cond = conds[i]

            cond_schedule.append(ScheduledPromptConditioning(end_at_step, cond))

        cache[prompt] = cond_schedule
        res.append(cond_schedule)

    return res


re_AND = re.compile(r"\bAND\b")
re_weight = re.compile(r"^((?:\s|.)*?)(?:\s*:\s*([-+]?(?:\d+\.?|\d*\.\d+)))?\s*$")


def get_multicond_prompt_list(prompts: SdConditioning | list[str]):
    res_indexes = []

    prompt_indexes = {}
    prompt_flat_list = SdConditioning(prompts)
    prompt_flat_list.clear()

    for prompt in prompts:
        subprompts = re_AND.split(prompt)

        indexes = []
        for subprompt in subprompts:
            match = re_weight.search(subprompt)

            text, weight = match.groups() if match is not None else (subprompt, 1.0)

            weight = float(weight) if weight is not None else 1.0

            index = prompt_indexes.get(text, None)
            if index is None:
                index = len(prompt_flat_list)
                prompt_flat_list.append(text)
                prompt_indexes[text] = index

            indexes.append((index, weight))

        res_indexes.append(indexes)

    return res_indexes, prompt_flat_list, prompt_indexes


class ComposableScheduledPromptConditioning:
    def __init__(self, schedules, weight=1.0):
        self.schedules: list[ScheduledPromptConditioning] = schedules
        self.weight: float = weight


class MulticondLearnedConditioning:
    def __init__(self, shape, batch):
        self.shape: tuple = shape  # the shape field is needed to send this object to DDIM/PLMS
        self.batch: list[list[ComposableScheduledPromptConditioning]] = batch


def get_multicond_learned_conditioning(model, prompts, steps, hires_steps=None, use_old_scheduling=False) -> MulticondLearnedConditioning:
    """same as get_learned_conditioning, but returns a list of ScheduledPromptConditioning along with the weight objects for each prompt.
    For each prompt, the list is obtained by splitting the prompt using the AND separator.

    https://energy-based-model.github.io/Compositional-Visual-Generation-with-Composable-Diffusion-Models/
    """

    res_indexes, prompt_flat_list, prompt_indexes = get_multicond_prompt_list(prompts)

    learned_conditioning = get_learned_conditioning(model, prompt_flat_list, steps, hires_steps, use_old_scheduling)

    res = []
    for indexes in res_indexes:
        res.append([ComposableScheduledPromptConditioning(learned_conditioning[i], weight) for i, weight in indexes])

    return MulticondLearnedConditioning(shape=(len(prompts),), batch=res)


class DictWithShape(dict):
    def __init__(self, x, shape=None):
        super().__init__()
        self.update(x)

    @property
    def shape(self):
        return self["crossattn"].shape


def reconstruct_cond_batch(c: list[list[ScheduledPromptConditioning]], current_step):
    param = c[0][0].cond
    is_dict = isinstance(param, dict)

    if is_dict:
        dict_cond = param
        res = {k: torch.zeros((len(c),) + param.shape, device=param.device, dtype=param.dtype) for k, param in dict_cond.items()}
        res = DictWithShape(res, (len(c),) + dict_cond['crossattn'].shape)
    else:
        res = torch.zeros((len(c),) + param.shape, device=param.device, dtype=param.dtype)

    for i, cond_schedule in enumerate(c):
        target_index = 0
        for current, entry in enumerate(cond_schedule):
            if current_step <= entry.end_at_step:
                target_index = current
                break

        if is_dict:
            for k, param in cond_schedule[target_index].cond.items():
                res[k][i] = param
        else:
            res[i] = cond_schedule[target_index].cond

    return res


def stack_conds(tensors):
    # if prompts have wildly different lengths above the limit we'll get tensors of different shapes
    # and won't be able to torch.stack them. So this fixes that.
    token_count = max([x.shape[0] for x in tensors])
    for i in range(len(tensors)):
        if tensors[i].shape[0] != token_count:
            last_vector = tensors[i][-1:]
            last_vector_repeated = last_vector.repeat([token_count - tensors[i].shape[0], 1])
            tensors[i] = torch.vstack([tensors[i], last_vector_repeated])

    return torch.stack(tensors)



def reconstruct_multicond_batch(c: MulticondLearnedConditioning, current_step):
    param = c.batch[0][0].schedules[0].cond

    tensors = []
    conds_list = []

    for composable_prompts in c.batch:
        conds_for_batch = []

        for composable_prompt in composable_prompts:
            target_index = 0
            for current, entry in enumerate(composable_prompt.schedules):
                if current_step <= entry.end_at_step:
                    target_index = current
                    break

            conds_for_batch.append((len(tensors), composable_prompt.weight))
            tensors.append(composable_prompt.schedules[target_index].cond)

        conds_list.append(conds_for_batch)

    if isinstance(tensors[0], dict):
        keys = list(tensors[0].keys())
        stacked = {k: stack_conds([x[k] for x in tensors]) for k in keys}
        stacked = DictWithShape(stacked, stacked['crossattn'].shape)
    else:
        stacked = stack_conds(tensors).to(device=param.device, dtype=param.dtype)

    return conds_list, stacked


re_attention = re.compile(r"""
\\\(|
\\\)|
\\\[|
\\]|
\\\\|
\\|
\(|
\[|
:\s*([+-]?[.\d]+)\s*\)|
\)|
]|
[^\\()\[\]:]+|
:
""", re.X)

re_break = re.compile(r"\s*\bBREAK\b\s*", re.S)

def parse_prompt_attention(text):
    """
    Parses a string with attention tokens and returns a list of pairs: text and its associated weight.
    Accepted tokens are:
      (abc) - increases attention to abc by a multiplier of 1.1
      (abc:3.12) - increases attention to abc by a multiplier of 3.12
      [abc] - decreases attention to abc by a multiplier of 1.1
      \( - literal character '('
      \[ - literal character '['
      \) - literal character ')'
      \] - literal character ']'
      \\ - literal character '\'
      anything else - just text

    >>> parse_prompt_attention('normal text')
    [['normal text', 1.0]]
    >>> parse_prompt_attention('an (important) word')
    [['an ', 1.0], ['important', 1.1], [' word', 1.0]]
    >>> parse_prompt_attention('(unbalanced')
    [['unbalanced', 1.1]]
    >>> parse_prompt_attention('\(literal\]')
    [['(literal]', 1.0]]
    >>> parse_prompt_attention('(unnecessary)(parens)')
    [['unnecessaryparens', 1.1]]
    >>> parse_prompt_attention('a (((house:1.3)) [on] a (hill:0.5), sun, (((sky))).')
    [['a ', 1.0],
     ['house', 1.5730000000000004],
     [' ', 1.1],
     ['on', 1.0],
     [' a ', 1.1],
     ['hill', 0.55],
     [', sun, ', 1.1],
     ['sky', 1.4641000000000006],
     ['.', 1.1]]
    """

    res = []
    round_brackets = []
    square_brackets = []

    round_bracket_multiplier = 1.1
    square_bracket_multiplier = 1 / 1.1

    def multiply_range(start_position, multiplier):
        for p in range(start_position, len(res)):
            res[p][1] *= multiplier

    for m in re_attention.finditer(text):
        text = m.group(0)
        weight = m.group(1)

        if text.startswith('\\'):
            res.append([text[1:], 1.0])
        elif text == '(':
            round_brackets.append(len(res))
        elif text == '[':
            square_brackets.append(len(res))
        elif weight is not None and round_brackets:
            multiply_range(round_brackets.pop(), float(weight))
        elif text == ')' and round_brackets:
            multiply_range(round_brackets.pop(), round_bracket_multiplier)
        elif text == ']' and square_brackets:
            multiply_range(square_brackets.pop(), square_bracket_multiplier)
        else:
            parts = re.split(re_break, text)
            for i, part in enumerate(parts):
                if i > 0:
                    res.append(["BREAK", -1])
                res.append([part, 1.0])

    for pos in round_brackets:
        multiply_range(pos, round_bracket_multiplier)

    for pos in square_brackets:
        multiply_range(pos, square_bracket_multiplier)

    if len(res) == 0:
        res = [["", 1.0]]

    # merge runs of identical weights
    i = 0
    while i + 1 < len(res):
        if res[i][1] == res[i + 1][1]:
            res[i][0] += res[i + 1][0]
            res.pop(i + 1)
        else:
            i += 1

    return res

if __name__ == "__main__":
    import doctest
    doctest.testmod(optionflags=doctest.NORMALIZE_WHITESPACE)
else:
    import torch  # doctest faster
