// Entry point for the vendored CodeMirror 6 bundle used by mobile_lite/js/prompt-cm.js.
// Everything else (theme, decorations, completion source, drag, popup) is implemented
// against the mobile prompt model in mobile_lite/js/prompt-cm.js itself.
export { EditorState, StateEffect, StateField, RangeSetBuilder } from '@codemirror/state';
export { EditorView, Decoration, keymap, placeholder, dropCursor, WidgetType, gutter, GutterMarker, drawSelection } from '@codemirror/view';
export { autocompletion, completionKeymap, closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
export { history, historyKeymap, defaultKeymap } from '@codemirror/commands';
export {
  search, searchKeymap, openSearchPanel, closeSearchPanel,
  selectNextOccurrence, highlightSelectionMatches,
} from '@codemirror/search';
