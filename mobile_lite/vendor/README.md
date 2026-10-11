# mobile_lite/vendor — third-party bundles

## codemirror6.js

CodeMirror 6 — the editor behind the **text mode** of the prompt boxes on both frontends:
`mobile_lite/js/prompt-cm-core.js` (shared core; Mobile Lite wrapper `js/prompt-cm.js`, wired in
by `js/prompt.js`) and `javascript/promptCM.mjs` for the desktop gradio hosts. Chosen because the
prompt is plain text: the editor document *is* the value, so the chips editors, the generation
payload and every other integration keep working unchanged, while we get official autocomplete
and a decoration pipeline for comments / disabled keywords / drag and quick actions.

- **Bundle:** `codemirror6.js` (~305 KB minified ESM), built with esbuild from:
  - `@codemirror/state` 6.7.6
  - `@codemirror/view` 6.43.14
  - `@codemirror/autocomplete` 6.20.3
  - `@codemirror/commands` 6.11.1
  (plus transitive `@codemirror/language` 6.13.1, `@codemirror/streamparser` 6.0.0, `@lezer/*`)
- **License:** MIT — © Marijn Haverbeke and others, https://codemirror.net
- **Rebuild:** run `mobile_lite/vendor/cm6build/build.bat` (npm install + esbuild; add
  `--registry=https://registry.npmmirror.com` to the install if the default registry is
  unreachable). The bundle is committed so the webui needs neither node nor network at runtime.
- **Serving:** Mobile Lite reaches it via the `/mlite/{path}` static route; the desktop module
  reaches the same file through the shared core (imported as `/file=mobile_lite/js/prompt-cm-core.js`).
  The `.js` extension allowlists already cover both routes.
- Loaded lazily by `js/prompt-cm.js` on first text-mode use; if the fetch fails the plain
  textarea stays functional.
