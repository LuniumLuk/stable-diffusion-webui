# Project Guidelines

## Downloads and network access

Apply this order to every download (model weights, VAEs, embeddings, datasets, pip/npm packages, repo tarballs):

1. **Hugging Face: always use HF-mirror.** Never hit `huggingface.co` directly, not even for a metadata call.
   - Set the endpoint before any `huggingface_hub` / `diffusers` / `hf` CLI call: `$env:HF_ENDPOINT = "https://hf-mirror.com"`
   - Direct file URL: `https://hf-mirror.com/<repo>/resolve/main/<file>?download=true`
   - CLI: `huggingface-cli download <repo> --endpoint https://hf-mirror.com ...`
2. **Anything else: use a China mirror first.**
   - PyPI: `pip install -i https://pypi.tuna.tsinghua.edu.cn/simple <pkg>`
   - Generic HTTP/files: `https://mirrors.tuna.tsinghua.edu.cn/...`, or another reachable China mirror (USTC `mirrors.ustc.edu.cn`, Aliyun `mirrors.aliyun.com`, GitHub raw/release proxies).
3. **Only when a mirror still fails, go through the local proxy** - normally `http://127.0.0.1:7890`:
   - `Invoke-WebRequest -Proxy http://127.0.0.1:7890 ...`, `curl -x http://127.0.0.1:7890 ...`
   - `$env:HTTP_PROXY = $env:HTTPS_PROXY = "http://127.0.0.1:7890"` (checked before guessing another port)
   - Keep `$env:NO_PROXY = "localhost,127.0.0.1,0.0.0.0,::1"` so local server traffic is never proxied.
4. Report which mirror/proxy a download went through, and verify the file (size, and sha256 when the source publishes one).

## UI scope: PC and Mobile

This fork ships two front-ends that must stay in parity:

- **PC / webui**: the Gradio UI - `modules/**`, `scripts/**`, `javascript/**`, `html/**`, extensions.
- **Mobile / SD Lite**: `mobile_lite/` (framework-free app served at `/mlite/`) plus its JSON API in `modules/mobile_lite.py`.

When a request does not name a UI, do not assume PC only: check both front-ends, then implement the feature in both. Skip a side only when it genuinely cannot apply, and say why in the report.

## Browser use

- Use the VS Code integrated browser tools (`openBrowserPage`, `readPage`, `screenshotPage`, `navigatePage`, `clickElement`, `typeInPage`, `runPlaywrightCode`).
- Never launch an external browser (Chrome/Edge/Firefox) and never open a URL with `Start-Process`, `start`, `explorer`, `Invoke-Item`, or Python's `webbrowser` - a stray window on the developer's desktop is disruptive.
- Server-safety rules for runtime verification live in [sd-webui-feature-dev.agent.md](agents/sd-webui-feature-dev.agent.md): never drive or restart the developer's live instance on `7860`.

## Testing UI / generation-config changes: use lightweight mode

When testing a UI or generation-config feature that does **not** actually need model inference
(layout, settings, option plumbing, prompt editors, gallery browsing, mobile/desktop parity,
parameter round-trips), you MUST enable **Lightweight mode** before verifying.

- Toggle: `Settings -> System -> Lightweight mode` (config key `lightweight_mode`).
- It unloads every model from VRAM and RAM (SD checkpoint and VAE cache, Qwen / Krea 2 / Anima
  sidecars, video pipeline, local LLM, interrogate/deepbooru models) and turns every generate
  action into a no-op with a hint, so verification costs no GPU time.
- Enable it from the toggle, via `POST /sdapi/v1/options` with `{"lightweight_mode": true}`, or
  from the Lite settings sheet at `/mlite/`. The value persists in `config.json`; set it back to
  `false` before handing the instance back to the developer.
- Do not "just run one small generation" to smoke-test layout or settings work. In lightweight
  mode a Generate click must show the hint and touch no engine at all.

Only leave lightweight mode off when the feature under test genuinely needs inference: model
output quality, sampler/scheduler behaviour, VRAM hand-over between engines, timing, or a real
sidecar job.

## Always report: server restart vs browser refresh

Every finished job - from any agent, including sub-agents and background agents - must end its
final reply with one explicit line telling the user how to pick the change up. Never leave it
implicit, even for docs-only work.

- **Server restart** when anything the running process executes changed: `modules/**`,
  `scripts/**`, `webui.py`, `launch.py`, `requirements*.txt`, HTTP routes/endpoints,
  Gradio component structure (`on_ui_tabs`, `gr.Blocks`), settings/option registration,
  Python inside extensions.
- **Browser refresh only** (Ctrl+F5 / hard reload) when only static assets changed:
  `javascript/**`, `style.css`, `html/**`, `mobile_lite/**` (served at `/mlite/`).
- **Both** changed → say restart, and note that the restart also reloads the front-end.
- Nothing runs differently (docs, tests, comments, hand-run scripts) → say so explicitly.

End the reply with a short marker line, for example
`Reload: **browser refresh** (Ctrl+F5) - JS/CSS only` or
`Reload: **server restart** - Python route changed`.

