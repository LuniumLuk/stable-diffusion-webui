/**
 * Pure text operations for the Mobile Lite CodeMirror prompt editor (`prompt-cm.js`).
 *
 * Everything here works on plain document strings and character offsets, so it can be
 * unit-tested in node without a DOM (see `tmp/lite_cm_test.mjs`). The grammar is the same
 * as the chips editor (`prompt-parse.js`): top-level commas separate keywords, `#(...)`
 * groups are disabled keywords, `# ...` lines are comments and `# ---` lines open
 * toggleable blocks. Line indexes are 0-based (array indexes), positions are absolute
 * character offsets into the whole document.
 *
 * Every operation returns `{ changes, caret }` where `changes` is a list of minimal
 * `{ from, to, insert }` edits in *original* coordinates (ascending, non-overlapping)
 * and `caret` is where the selection should land afterwards (null = leave it alone).
 */

import { blockBounds, classify, findPickGroups, isBlockMarker, joinSegments, splitSegments, toggleBlockLines } from './prompt-parse.js';

/* ------------------------------------------------------------------ line helpers */

export function lineStarts(text) {
  const starts = [0];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === '\n') starts.push(index + 1);
  }
  return starts;
}

export function lineIndexAt(text, pos) {
  const limit = Math.max(0, Math.min(pos, text.length));
  let line = 0;
  for (let at = text.indexOf('\n'); at !== -1 && at < limit; at = text.indexOf('\n', at + 1)) line += 1;
  return line;
}

/** `{ start, end }` char offsets of a 0-based line index (end excludes the newline). */
export function lineBounds(text, line) {
  const starts = lineStarts(text);
  const clamped = Math.max(0, Math.min(line, starts.length - 1));
  const start = starts[clamped];
  const end = clamped + 1 < starts.length ? starts[clamped + 1] - 1 : text.length;
  return { start, end };
}

/** Apply a change list to a string (used for caret math and tests). */
export function applyChanges(text, changes) {
  const sorted = changes.slice().sort((a, b) => a.from - b.from);
  let out = '';
  let pos = 0;
  for (const change of sorted) {
    out += text.slice(pos, change.from) + change.insert;
    pos = change.to;
  }
  return out + text.slice(pos);
}

function sortChanges(changes) {
  return changes.slice().sort((a, b) => a.from - b.from || a.to - b.to);
}

/** Offset where the body of segment `index` starts within `joinSegments(segments)`. */
function segmentOffset(segments, index) {
  let offset = 0;
  for (let at = 0; at < index && at < segments.length; at += 1) {
    const segment = segments[at];
    offset += segment.lead.length + segment.body.length + segment.tail.length;
  }
  if (index < segments.length) offset += segments[index].lead.length;
  return offset;
}

/** Drop trailing empty segments (they only carry dangling separators of the old text). */
function trimTrailingEmpties(segments) {
  while (segments.length > 1 && !segments[segments.length - 1].body.trim()) segments.pop();
}

/** Make sure separators of a spliced line still read as `a, b, c`. */
function fixTails(segments) {
  trimTrailingEmpties(segments);
  segments.forEach((segment, index) => {
    const last = index === segments.length - 1;
    const tail = segment.tail || '';
    if (last) {
      if (/^\s*,*\s*$/.test(tail)) segment.tail = '';
    } else if (!/,\s*$/.test(tail)) {
      segment.tail = `${tail.replace(/[,\s]+$/, '') || ''}, `;
    }
  });
}

/* ------------------------------------------------------------------ token lookup */

/**
 * Token under a character position:
 * `{ line, seg, from, to, text, token }` (from/to span the trimmed keyword core),
 * or null when the position is not on a keyword.
 */
export function tokenAt(text, pos) {
  if (pos == null || pos < 0 || pos > text.length || !text) return null;
  const line = lineIndexAt(text, pos);
  const { start, end } = lineBounds(text, line);
  const lineText = text.slice(start, end);
  const offset = pos - start;
  const segments = splitSegments(lineText);
  const groups = findPickGroups(text);
  let cursor = 0;
  for (let seg = 0; seg < segments.length; seg += 1) {
    const { lead, body, tail } = segments[seg];
    const bodyStart = cursor + lead.length;
    const coreLead = body.length - body.trimStart().length;
    const core = body.trim();
    const coreFrom = bodyStart + coreLead;
    const coreTo = coreFrom + core.length;
    if (core && offset >= coreFrom && offset <= coreTo) {
      const absoluteFrom = start + coreFrom;
      const group = groups.find((candidate) => candidate.start === absoluteFrom) || null;
      return {
        line,
        seg,
        from: start + coreFrom,
        to: start + coreTo,
        text: core,
        token: classify(body, group ? group.syntax : null),
      };
    }
    cursor = bodyStart + body.length + tail.length;
  }
  return null;
}

/** Nearest top-level slot for a drop position: `{ line, slot, at }` (at = boundary char pos). */
export function snapSlot(text, pos) {
  const clamped = Math.max(0, Math.min(pos, text.length));
  const line = lineIndexAt(text, clamped);
  const { start, end } = lineBounds(text, line);
  const segments = splitSegments(text.slice(start, end));
  let cursor = 0;
  let best = { slot: 0, at: start, distance: Math.abs(clamped - start) };
  for (let slot = 0; slot <= segments.length; slot += 1) {
    const boundary = start + cursor;
    const distance = Math.abs(clamped - boundary);
    if (distance < best.distance) best = { slot, at: boundary, distance };
    if (slot < segments.length) cursor += segments[slot].lead.length + segments[slot].body.length + segments[slot].tail.length;
  }
  return { line, slot: best.slot, at: best.at };
}

/* ------------------------------------------------------------------ edits */

/** Replace a token's core text; `{ changes, caret, from, to }` (new token range). */
export function replaceToken(text, tok, insertText) {
  const changes = [{ from: tok.from, to: tok.to, insert: insertText }];
  return { changes, caret: tok.from + insertText.length, from: tok.from, to: tok.from + insertText.length };
}

/** Remove a token together with one adjacent separator; whole line goes when emptied. */
export function removeToken(text, tok) {
  const { start, end } = lineBounds(text, tok.line);
  const lineText = text.slice(start, end);
  let from = tok.from - start;
  let to = tok.to - start;
  const after = lineText.slice(to);
  const separator = /^\s*,\s*/.exec(after);
  if (separator) {
    to += separator[0].length;
  } else {
    const before = /,\s*$/.exec(lineText.slice(0, from));
    if (before) from -= before[0].length;
  }
  const newLine = lineText.slice(0, from) + lineText.slice(to);
  if (!newLine.trim() || /^[,\s]+$/.test(newLine)) {
    // nothing but separators left -> drop the whole line
    if (end < text.length) {
      const change = { from: start, to: end + 1, insert: '' };
      return { changes: [change], caret: Math.max(0, change.from - 1) };
    }
    if (start > 0) {
      const change = { from: start - 1, to: end, insert: '' };
      return { changes: [change], caret: Math.max(0, change.from) };
    }
    return { changes: [{ from: 0, to: end, insert: '' }], caret: 0 };
  }
  return { changes: [{ from: start + from, to: start + to, insert: '' }], caret: start + from };
}

/**
 * Move a token to `slot` of `targetLine` (slot = boundary index of the ORIGINAL target
 * line, 0..segments.length). Same-line moves splice, cross-line moves rebuild the two
 * touched lines; separators are repaired with `fixTails`.
 */
export function moveToken(text, tok, targetLine, slot) {
  const lines = text.split('\n');
  const srcIdx = Math.max(0, Math.min(tok.line, lines.length - 1));
  const dstIdx = Math.max(0, Math.min(targetLine, lines.length - 1));
  const movedBody = tok.text;

  if (srcIdx === dstIdx) {
    const bounds = lineBounds(text, srcIdx);
    const segments = splitSegments(lines[srcIdx]);
    trimTrailingEmpties(segments);
    const segIndex = Math.max(0, Math.min(tok.seg, segments.length - 1));
    const [moved] = segments.splice(segIndex, 1);
    if (!moved) return null;
    const indent = moved.lead; // the line's leading whitespace travelled in the first segment
    moved.lead = '';
    let insertAt = slot > segIndex ? slot - 1 : slot;
    insertAt = Math.max(0, Math.min(insertAt, segments.length));
    segments.splice(insertAt, 0, moved);
    if (segments.length && segments[0].lead === '') segments[0].lead = indent;
    fixTails(segments);
    const newLine = joinSegments(segments);
    return {
      changes: [{ from: bounds.start, to: bounds.end, insert: newLine }],
      caret: bounds.start + segmentOffset(segments, Math.min(insertAt, segments.length - 1)) + moved.body.length,
    };
  }

  const srcSegments = splitSegments(lines[srcIdx]);
  const srcIndent = srcSegments.length ? srcSegments[0].lead : '';
  trimTrailingEmpties(srcSegments);
  const [moved] = srcSegments.splice(tok.seg, 1);
  if (!moved) return null;
  moved.lead = '';
  const srcRest = joinSegments(srcSegments);
  const srcEmpty = !srcRest.trim() || /^[,\s]+$/.test(srcRest);
  if (!srcEmpty) {
    if (srcSegments.length && srcSegments[0].lead === '') srcSegments[0].lead = srcIndent;
    fixTails(srcSegments);
  }

  const dstSegments = splitSegments(lines[dstIdx]);
  trimTrailingEmpties(dstSegments);
  const insertAt = Math.max(0, Math.min(slot, dstSegments.length));
  dstSegments.splice(insertAt, 0, moved);
  fixTails(dstSegments);

  const changes = [];
  const srcBounds = lineBounds(text, srcIdx);
  const dstBounds = lineBounds(text, dstIdx);
  if (srcEmpty) {
    if (srcBounds.end < text.length) changes.push({ from: srcBounds.start, to: srcBounds.end + 1, insert: '' });
    else if (srcBounds.start > 0) changes.push({ from: srcBounds.start - 1, to: srcBounds.end, insert: '' });
    else return null; // the only line cannot lose its only token
  } else {
    changes.push({ from: srcBounds.start, to: srcBounds.end, insert: joinSegments(srcSegments) });
  }
  changes.push({ from: dstBounds.start, to: dstBounds.end, insert: joinSegments(dstSegments) });

  const updated = applyChanges(text, changes);
  const dstIndexNow = srcEmpty && srcIdx < dstIdx ? dstIdx - 1 : dstIdx;
  const starts = lineStarts(updated);
  const lineStart = starts[Math.max(0, Math.min(dstIndexNow, starts.length - 1))];
  const lineEnd = dstIndexNow + 1 < starts.length ? starts[dstIndexNow + 1] - 1 : updated.length;
  const segmentsNow = splitSegments(updated.slice(lineStart, lineEnd));
  const indexNow = Math.max(0, Math.min(insertAt, segmentsNow.length - 1));
  return {
    changes: sortChanges(changes),
    caret: lineStart + segmentOffset(segmentsNow, indexNow) + (segmentsNow[indexNow] ? segmentsNow[indexNow].body.length : 0),
  };
}

/** Comment / uncomment a line; on a `# ---` marker line toggles the whole block. */
export function toggleCommentAt(text, line) {
  const bounds = lineBounds(text, line);
  const lineText = text.slice(bounds.start, bounds.end);
  if (isBlockMarker(lineText)) {
    const lines = text.split('\n');
    const next = toggleBlockLines(lines, line);
    if (next === lines) return null;
    const block = blockBounds(lines, line);
    if (!block) return null;
    const from = lineBounds(text, block.from).start;
    const to = lineBounds(text, block.to - 1).end;
    return { changes: [{ from, to, insert: next.slice(block.from, block.to).join('\n') }], caret: null, kind: 'block' };
  }
  const indent = /^\s*/.exec(lineText)[0];
  const trimmed = lineText.slice(indent.length);
  if (!trimmed) return null;
  const insert = lineIsComment(trimmed)
    ? indent + trimmed.slice(1).replace(/^ /, '')
    : `${indent}# ${trimmed}`;
  return { changes: [{ from: bounds.start, to: bounds.end, insert }], caret: null, kind: 'line' };
}

/**
 * Comment / uncomment every content line of the inclusive line range `[fromLine, toLine]`
 * (desktop Ctrl+/ over a multi-line selection).
 *
 * Same converging contract as the block toggle: when every non-empty content line
 * already is a comment, all of them are uncommented; otherwise every line that is not
 * commented yet gets a `# ` prefix.  `# ---` marker lines are structure and stay
 * untouched, indentation is preserved, disabled `#(...)` groups comment out like any
 * other line (`# #(...)`), and the range is clamped to the document.  Returns null when
 * the range holds nothing to toggle.
 */
export function toggleCommentLines(text, fromLine, toLine) {
  const lines = text.split('\n');
  const first = Math.max(0, Math.min(fromLine, lines.length - 1));
  const last = Math.max(first, Math.min(toLine, lines.length - 1));
  const togglable = [];
  let off = true;
  for (let index = first; index <= last; index += 1) {
    const lineText = lines[index];
    if (!lineText.trim() || isBlockMarker(lineText)) continue;
    togglable.push(index);
    if (!lineIsComment(lineText)) off = false;
  }
  if (!togglable.length) return null;
  const changes = [];
  for (const index of togglable) {
    const bounds = lineBounds(text, index);
    const lineText = lines[index];
    const indent = /^\s*/.exec(lineText)[0];
    const trimmed = lineText.slice(indent.length);
    if (off) {
      changes.push({ from: bounds.start, to: bounds.end, insert: indent + trimmed.slice(1).replace(/^ /, '') });
    } else if (!lineIsComment(lineText)) {
      changes.push({ from: bounds.start, to: bounds.end, insert: `${indent}# ${trimmed}` });
    }
  }
  if (!changes.length) return null;
  return { changes, caret: null, kind: 'lines' };
}

/** True when a line's first non-whitespace char is '#' (not a disabled `#(` group). */
function lineIsComment(lineText) {
  return /^\s*#(?!\()/.test(lineText);
}

/** True when the line reads as a comment (not a disabled `#(` group). */
export function lineCommentState(text, line) {
  const { start, end } = lineBounds(text, line);
  return lineIsComment(text.slice(start, end));
}

/** All keyword tokens intersecting `[from, to)`, in document order (empty when none). */
export function tokensInRange(text, from, to) {
  const tokens = [];
  const clampedFrom = Math.max(0, Math.min(from, text.length));
  const clampedTo = Math.max(0, Math.min(to, text.length));
  const startLine = lineIndexAt(text, clampedFrom);
  const endLine = lineIndexAt(text, clampedTo);
  const groups = findPickGroups(text);
  for (let line = startLine; line <= endLine; line += 1) {
    const bounds = lineBounds(text, line);
    const lineText = text.slice(bounds.start, bounds.end);
    const segments = splitSegments(lineText);
    let cursor = 0;
    for (let seg = 0; seg < segments.length; seg += 1) {
      const { lead, body, tail } = segments[seg];
      const bodyStart = cursor + lead.length;
      const coreLead = body.length - body.trimStart().length;
      const core = body.trim();
      const coreFrom = bounds.start + bodyStart + coreLead;
      const coreTo = coreFrom + core.length;
      if (core && coreTo > clampedFrom && coreFrom < clampedTo) {
        const group = groups.find((candidate) => candidate.start === coreFrom) || null;
        tokens.push({
          line,
          seg,
          from: coreFrom,
          to: coreTo,
          text: core,
          token: classify(body, group ? group.syntax : null),
        });
      }
      cursor = bodyStart + body.length + tail.length;
    }
  }
  return tokens;
}
