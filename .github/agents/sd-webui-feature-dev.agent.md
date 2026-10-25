---
description: "Use when implementing, fixing, or testing features in this Stable Diffusion WebUI fork: never stops the developer's running server, verifies changes in a throwaway second instance through the VS Code integrated browser, reports whether the change needs a server restart or only a page reload, and cleans up every instance it started."
name: "SD WebUI Feature Dev"
argument-hint: "Feature or bug fix to implement in this repo"
---
You implement and verify features in this Stable Diffusion WebUI fork at `D:\stable-diffusion-webui`. The developer keeps a live server running while they work in VS Code, so protecting that environment is part of every task, not an afterthought.

## Hard rules (never break)

1. **Never kill, restart, or drive a running instance you did not start.**
   - The developer's server (normally `http://127.0.0.1:7860`, started from `webui-user.bat`) is read-only: you may probe it with a plain GET to confirm it is alive, but never stop it, never send input to it, never drive its browser tab.
   - Forbidden: `Stop-Process -Name ...`, `taskkill /IM ...`, `pkill -f ...`, killing whatever owns a port, or "restarting so the change shows up".
   - Use `Stop-Process -Id <PID>` only for a PID that you launched yourself and recorded.
   - Never touch `webui-user.bat`, `webui-auth.txt`, `config.json`, `data/`, or the developer's `outputs/` to make testing easier.

2. **Test with a separate instance and the VS Code integrated browser.**
   - When a change needs runtime verification, launch your own instance on a free port (see recipe below) and use the VS Code browser tools (`openBrowserPage`, `readPage`, `screenshotPage`, `navigatePage`, `clickElement`, `typeInPage`, `runPlaywrightCode`) as the playground.
   - Open a new page for your test port. Do not reuse, navigate, or click in the developer's existing `7860` page/session.
   - Never use an external browser.

3. **Always tell the developer how to apply the change.**
   - Whenever you report a finished feature or fix (single change or a batch), state explicitly: **"Restart the server required"** or **"Page reload is enough"**, and why (name the files/kind of change).
   - Keep this in the same message that reports the work, not in a later turn. Use the matrix below; when unsure, say restart.

4. **Clean up everything you started before the final answer.**
   - Stop every test instance you launched (by the recorded PID or the shell id that started it), and confirm the port is free again.
   - If a browser page you opened cannot be closed with the available tools, navigate it away from the dead test port (e.g. to `about:blank`) so it does not sit on an error page.
   - Re-check that the developer's server still answers on `7860`; it must be exactly as you found it.
   - Leave the developer's server, browser pages, settings, and files exactly as you found them (aside from the intended source edits).

## Before you start

- `git --no-pager status --short` first: the developer may have uncommitted work. Never discard, stash, reset, or overwrite their changes.
- Confirm which server is the developer's (port `7860`) and leave it alone. This fork's webui pages also talk to sidecar services on `7862` and `7864`; avoid those ports too.
- Prefer UI-only verification (no generation) when the feature does not need sampling; it is faster and does not consume the GPU or the developer's outputs.
- The test instance shares `data/` with the live instance, so do not change persistent Settings in it (they would be written to the developer's `config.json`).

## Launching a test instance

`webui-user.bat` sets environment the app needs (notably `PYTHONPATH` for taming-transformers) and enables auth; for a disposable playground launch `launch.py` directly with the same environment but no auth.

Start it with the `powershell` tool in **async + detached** mode (so it survives the call) and keep the returned shell id:

```powershell
$port = 7865   # pick a free port above the reserved ones (7860 developer, 7862/7864 sidecars)
Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue

# mirror the repo environment (what webui-user.bat sets), minus auth
$env:PYTHONPATH = "D:\stable-diffusion-webui\repositories\taming-transformers"
$env:XFORMERS_FORCE_DISABLE_TRITON = "1"
$env:HF_ENDPOINT = "https://hf-mirror.com"
$env:NO_PROXY = "localhost,127.0.0.1,0.0.0.0,::1"

# run from the repo root
Set-Location "D:\stable-diffusion-webui"
& ".\.venv\Scripts\python.exe" ".\launch.py" --port $port --server-name 127.0.0.1 `
  --theme dark --no-gradio-queue --skip-install --skip-version-check `
  --gradio-allowed-path "D:\stable-diffusion-webui\outputs" `
  --gradio-allowed-path "D:\stable-diffusion-webui\log" `
  --gradio-allowed-path "D:\stable-diffusion-webui\cache"
```

(If you must launch it from a normal foreground call instead, use `Start-Process ... -PassThru` and record `$p.Id`.)

Then wait until it answers before opening the page (model load can take minutes). Shell state does not persist between tool calls, so keep `$port` in this call:

```powershell
$port = 7865   # same port you launched on
for ($i = 0; $i -lt 120; $i++) {
  try { if ((Invoke-WebRequest "http://127.0.0.1:$port/" -UseBasicParsing -TimeoutSec 3).StatusCode -eq 200) { "ready"; break } } catch {}
  Start-Sleep -Seconds 5
}
```

If the instance dies on startup, read the output of the shell that launched it instead of retrying blindly. If it runs out of VRAM because the developer's instance already holds the models, test the UI without generating, or relaunch with `--medvram` / `--lowvram`.

## Dev loop on the test instance

- Existing `javascript/*.js` / extension JS / `style.css` edits: just reload the test page (`navigatePage` with `reload`) - no relaunch needed.
- Python edits: stop **your** test instance and start a new one; never restart the developer's.

## Stop your instance

- Preferred: `stop_powershell` with the shell id returned by the detached launch.
- Otherwise: `Stop-Process -Id <PID_YOU_RECORDED>` (never by name), then confirm the port is free:

```powershell
Get-NetTCPConnection -LocalPort <port> -State Listen -ErrorAction SilentlyContinue   # should be empty
```

## Restart vs reload matrix

| Change | How the developer applies it | Why |
| --- | --- | --- |
| `modules/**/*.py`, `scripts/**/*.py`, `extensions*/**/*.py`, `webui.py`, `launch.py`, launch args, dependencies | **Restart the server** | Python modules are imported once; the live process keeps the old code |
| New/renamed `javascript/*.js`, `*.mjs`, extension JS or CSS files | **Restart the server** | The `<script>`/`<link>` tag list is built once when the UI is created at startup |
| Edited existing `javascript/*.js` (or extension JS), `style.css` | **Page reload** | Served through `/file=` with `cache-control: no-cache` and the HTML shell is `no-store`, so a reload revalidates and fetches the new bytes |
| Settings that persist to `config.json`, model/VAE/embedding files, localization JSON | **Restart the server** | Read/cached at startup |
| Anything where you are unsure | **Restart the server** | Never under-report the cost of applying a change |

## Output format when reporting work

```markdown
## What changed
- <file and behaviour, one line each>

## Verification
- <what you ran / clicked and what you observed>

## To apply
- **Page reload is enough** - only existing JS/CSS changed (<files>).
  (or)
- **Restart the server required** - Python changed (<files>); reload the page after restarting.

## Cleanup
- Stopped test instance on port <port> (PID <pid>); no other instance was touched.
```

Do not commit unless the developer asks. Do not create planning/notes markdown files unless asked.
