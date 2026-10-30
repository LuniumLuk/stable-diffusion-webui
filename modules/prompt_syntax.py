"""Conditional prompt directive syntax shared by the pipeline and the gallery stores.

Directives live on their own line and start with '@' so '#' stays reserved for
comments and disabled keyword groups:

    @IF TXT2IMG
    ...
    @ELSEIF HIRES_FIX
    ...
    @ELSE
    ...
    @ENDIF

Macro names are case-insensitive, but the editors write them upper case to match
@PICK.  Prompts written before the switch used '#' for the same directives
('#if', '#elseif', '#else', '#endif'); upgrade_legacy_directives() rewrites those
lines when an old prompt is imported or stored.
"""

import re

DIRECTIVE_NAMES = {"if": "IF", "elif": "ELIF", "elseif": "ELSEIF", "else": "ELSE", "endif": "ENDIF"}

CONDITION_DIRECTIVE_RE = re.compile(
    r"^[ \t]*@(?P<keyword>if|elif|elseif|else|endif)(?![A-Za-z0-9_])(?P<expression>[^\n]*)$",
    re.IGNORECASE,
)
LEGACY_DIRECTIVE_RE = re.compile(
    r"^([ \t]*)#(?P<keyword>if|elif|elseif|else|endif)(?![A-Za-z0-9_])(?P<expression>[^\n]*)$",
    re.IGNORECASE,
)


def directive_name(keyword: str) -> str:
    """Canonical upper-case directive name ('if' -> 'IF', 'elif' -> 'ELIF')."""
    return DIRECTIVE_NAMES.get(str(keyword or "").lower(), str(keyword or "").upper())


def upgrade_legacy_directives(text):
    """Rewrites legacy '#if' / '#elseif' / '#else' / '#endif' lines to '@IF' style.

    Only whole directive lines change; a comment that merely starts with the same
    letters ('#iffy', '# #if …') is left alone.  Non-string values pass through.

    >>> upgrade_legacy_directives("#if TXT2IMG\\na\\n#endif")
    '@IF TXT2IMG\\na\\n@ENDIF'
    >>> upgrade_legacy_directives("# #if TXT2IMG")
    '# #if TXT2IMG'
    >>> upgrade_legacy_directives("#iffy TXT2IMG")
    '#iffy TXT2IMG'
    """
    if not isinstance(text, str) or "#" not in text:
        return text

    def upgrade(line):
        match = LEGACY_DIRECTIVE_RE.match(line)
        if match is None:
            return line
        return f"{match.group(1)}@{directive_name(match.group('keyword'))}{match.group('expression')}"

    return "\n".join(upgrade(line) for line in text.split("\n"))
