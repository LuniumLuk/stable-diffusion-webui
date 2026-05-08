from __future__ import annotations

import os
import re
import time
import uuid as uuid_module
import base64
import html
from secrets import compare_digest

from modules import timer
from modules import initialize_util
from modules import initialize

startup_timer = timer.startup_timer
startup_timer.record("launcher")

_ACCESS_ALLOWLIST_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "webui-access-allowlist.txt")


def _ensure_access_allowlist_file():
    if os.path.exists(_ACCESS_ALLOWLIST_PATH):
        return

    sample = """# Manual allowlist for WebUI access gateway.
# Lines starting with # are comments.
#
# Allowed formats:
#   token:a1b2c3d4-e5f6-7890-abcd-ef1234567890   <- preferred, unique per browser
#   ip:203.0.113.25                               <- only works if NOT behind a reverse proxy
#
# To allow a device, copy the exact  token:...  line shown on the blocked page
# and paste it here, then save. Refresh the blocked page to gain access.
"""
    with open(_ACCESS_ALLOWLIST_PATH, "w", encoding="utf-8") as f:
        f.write(sample)


def _client_ip_from_request(request):
    # Prefer proxy/tunnel forwarded client IP headers when present.
    for header in ("cf-connecting-ip", "x-real-ip", "x-forwarded-for"):
        value = (request.headers.get(header, "") or "").strip()
        if not value:
            continue
        first = value.split(",", 1)[0].strip()
        if first:
            return first

    if request.client and request.client.host:
        return str(request.client.host)

    return "unknown"


def _parse_ua_short_name(ua: str) -> str:
    """Convert a raw User-Agent string into a short human-readable label."""
    if not ua or ua.strip().lower() in ("", "unknown"):
        return "Unknown Device"
    s = ua.strip()

    # --- Platform / OS ---
    platform = ""
    m = re.search(r'iPhone[^)]*CPU iPhone OS ([\d_]+)', s)
    if m:
        platform = f"iPhone / iOS {m.group(1).replace('_', '.')}"

    if not platform:
        m = re.search(r'iPad[^)]*CPU OS ([\d_]+)', s)
        if m:
            platform = f"iPad / iOS {m.group(1).replace('_', '.')}"

    if not platform:
        m = re.search(r'Android ([\d.]+)', s)
        if m:
            ver = m.group(1)
            model_m = re.search(r'Android [\d.]+;\s*([^)]+)', s)
            model = model_m.group(1).strip() if model_m else ""
            if model and len(model) > 22:
                model = model[:22].rstrip() + "\u2026"
            platform = f"{model} / Android {ver}" if model else f"Android {ver}"

    if not platform:
        m = re.search(r'Windows NT ([\d.]+)', s)
        if m:
            nt_map = {"10.0": "10/11", "6.3": "8.1", "6.2": "8", "6.1": "7", "6.0": "Vista", "5.1": "XP"}
            platform = f"Windows {nt_map.get(m.group(1), m.group(1))}"

    if not platform:
        m = re.search(r'Mac OS X ([\d_]+)', s)
        if m:
            platform = f"macOS {m.group(1).replace('_', '.')}"

    if not platform and "Linux" in s:
        platform = "Linux"

    if not platform:
        platform = "Unknown"

    # --- Browser ---
    browser = ""
    m = re.search(r'Edg(?:e|A|iOS)?/([\d.]+)', s)
    if m:
        browser = f"Edge {m.group(1).split('.')[0]}"

    if not browser:
        m = re.search(r'Firefox/([\d.]+)', s)
        if m:
            browser = f"Firefox {m.group(1).split('.')[0]}"

    if not browser:
        m = re.search(r'(?<!Edg)Chrome/([\d.]+)', s)
        if m:
            browser = f"Chrome {m.group(1).split('.')[0]}"

    if not browser:
        m = re.search(r'Version/([\d.]+).*Safari', s)
        if m:
            browser = f"Safari {m.group(1).split('.')[0]}"
        elif "Safari" in s:
            browser = "Safari"

    return f"{platform} / {browser}" if browser else platform


def _get_or_create_device_token(request) -> tuple:
    """Return (token_str, is_new). is_new=True means the cookie must be set on the response."""
    _COOKIE = "sd-device-token"
    _UUID_RE = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$', re.I)
    existing = (request.cookies.get(_COOKIE) or "").strip()
    if existing and _UUID_RE.match(existing):
        return existing.lower(), False
    return str(uuid_module.uuid4()), True


def _is_client_allowlisted(client_ip: str, device_token: str, raw_ua: str = "") -> bool:
    if not os.path.exists(_ACCESS_ALLOWLIST_PATH):
        return False

    ip = (client_ip or "").strip().lower()
    tok = (device_token or "").strip().lower()

    try:
        with open(_ACCESS_ALLOWLIST_PATH, "r", encoding="utf-8") as f:
            for raw in f.readlines():
                line = raw.strip()
                if not line or line.startswith("#"):
                    continue

                low = line.lower()
                if low.startswith("token:"):
                    if tok and tok == low.split(":", 1)[1].strip():
                        return True
                    continue

                if low.startswith("ip:"):
                    if ip == low.split(":", 1)[1].strip():
                        return True
                    continue

                # Backward-compatible bare IP line.
                if ip and ip == low:
                    return True
    except Exception:
        return False

    return False


def _has_valid_basic_auth_header(request, gradio_auth_creds) -> bool:
    auth = request.headers.get("authorization", "") or ""
    if not auth.startswith("Basic "):
        return False

    payload = auth[6:].strip()
    if not payload:
        return False

    try:
        decoded = base64.b64decode(payload).decode("utf-8", errors="ignore")
    except Exception:
        return False

    if ":" not in decoded:
        return False

    username, password = decoded.split(":", 1)
    for allowed_user, allowed_pass in gradio_auth_creds:
        if compare_digest(username, allowed_user) and compare_digest(password, allowed_pass):
            return True

    return False


def _has_gradio_auth_cookie(request) -> bool:
    token = (request.cookies.get("access-token") or request.cookies.get("access-token-unsecure") or "").strip()
    return bool(token)


def _build_access_gateway_html(client_ip: str, device_token: str, short_device: str = "", raw_ua: str = "") -> str:
    ip_esc = html.escape(client_ip or "unknown")
    token_esc = html.escape(device_token or "unknown")
    short_esc = html.escape(short_device or "Unknown Device")
    raw_ua_esc = html.escape(raw_ua or "(not available)")
    path_esc = html.escape(_ACCESS_ALLOWLIST_PATH)
    token_line = html.escape(f"token:{device_token}")

    ip_note = ""
    if not client_ip or client_ip in ("127.0.0.1", "::1", "unknown"):
        ip_note = "<p class='warn'>&#9888; IP shows as 127.0.0.1 because your tunnel/proxy doesn&rsquo;t forward the real client IP &mdash; use the <strong>token</strong> line instead.</p>"

    return f"""
<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Access Requires Manual Approval</title>
  <style>
    body {{ font-family: Segoe UI, Arial, sans-serif; background: #0f172a; color: #e2e8f0; margin: 0; padding: 20px; }}
    .card {{ max-width: 820px; margin: 16px auto; background: #111827; border: 1px solid #334155; border-radius: 10px; padding: 20px 24px; }}
    h1 {{ margin-top: 0; font-size: 20px; color: #93c5fd; }}
    .section {{ margin: 14px 0; }}
    .label {{ color: #94a3b8; font-size: 12px; text-transform: uppercase; letter-spacing: .05em; margin-bottom: 4px; }}
    .value {{ color: #f8fafc; font-weight: 700; font-size: 17px; }}
    .value-mono {{ color: #7dd3fc; font-family: monospace; font-size: 14px; letter-spacing: .04em; }}
    .hint {{ color: #64748b; font-size: 12px; margin-top: 2px; }}
    pre {{ background: #020617; border: 1px solid #1e293b; border-radius: 8px; padding: 12px 14px; color: #7dd3fc; overflow: auto; font-size: 14px; user-select: all; cursor: text; }}
    .warn {{ color: #fbbf24; font-size: 13px; }}
    details {{ margin-top: 6px; }}
    summary {{ cursor: pointer; color: #475569; font-size: 11px; }}
    summary:hover {{ color: #94a3b8; }}
    code {{ color: #64748b; font-size: 11px; word-break: break-all; }}
    hr {{ border: none; border-top: 1px solid #1e293b; margin: 16px 0; }}
  </style>
</head>
<body>
  <div class="card">
    <h1>&#128274; Access Requires Manual Approval</h1>
    <p>This browser is authenticated but not yet in the trusted allowlist.<br>
       Copy the token line below into the allowlist file, then refresh.</p>
    <hr>

    <div class="section">
      <div class="label">Device Token <span style="color:#475569;font-size:11px">(unique to this browser)</span></div>
      <div class="value-mono">{token_esc}</div>
      <div class="hint">This token is stored as a browser cookie. It never changes for this device unless you clear cookies.</div>
    </div>

    <div class="section">
      <div class="label">Device</div>
      <div class="value">{short_esc}</div>
      <details><summary>Show raw User-Agent</summary><code>{raw_ua_esc}</code></details>
    </div>

    <div class="section">
      <div class="label">Client IP</div>
      <div class="value">{ip_esc}</div>
      {ip_note}
    </div>

    <hr>
    <p style="margin-bottom:6px">Allowlist file &mdash; add this line, then save:</p>
    <pre style="color:#94a3b8">{path_esc}</pre>
    <pre>{token_line}</pre>
    <p style="color:#475569;font-size:12px">After saving, refresh this page to continue.</p>
  </div>
</body>
</html>
"""


def _build_access_gateway_middleware(gradio_auth_creds):
    if not gradio_auth_creds:
        return []

    creds = [tuple(x) for x in gradio_auth_creds]
    if not creds:
        return []

    _ensure_access_allowlist_file()

    from fastapi.responses import HTMLResponse
    from starlette.middleware import Middleware
    from starlette.middleware.base import BaseHTTPMiddleware

    class ManualAccessGatewayMiddleware(BaseHTTPMiddleware):
        def __init__(self, app, creds):
            super().__init__(app)
            self.creds = creds

        async def dispatch(self, request, call_next):
            client_ip = _client_ip_from_request(request)
            raw_ua = (request.headers.get("user-agent", "") or "").strip()
            device_token, is_new_token = _get_or_create_device_token(request)

            if _is_client_allowlisted(client_ip, device_token, raw_ua):
                return await call_next(request)

            # Show manual approval prompt only after correct credentials are entered.
            # Gradio auth can be conveyed via Basic auth header or access-token cookie.
            has_authenticated_session = _has_valid_basic_auth_header(request, self.creds) or _has_gradio_auth_cookie(request)
            if has_authenticated_session:
                short_device = _parse_ua_short_name(raw_ua) if raw_ua else "Unknown Device"
                html_page = _build_access_gateway_html(client_ip, device_token, short_device, raw_ua)
                response = HTMLResponse(content=html_page, status_code=403)
                if is_new_token:
                    # Persist the token in the browser so the same device always gets the same ID.
                    response.set_cookie(
                        "sd-device-token", device_token,
                        max_age=365 * 24 * 3600,
                        httponly=False,
                        samesite="lax",
                    )
                return response

            return await call_next(request)

    return [Middleware(ManualAccessGatewayMiddleware, creds=creds)]

initialize.imports()

initialize.check_versions()


def create_api(app):
    from modules.api.api import Api
    from modules.call_queue import queue_lock

    api = Api(app, queue_lock)
    return api


def api_only():
    from fastapi import FastAPI
    from modules.shared_cmd_options import cmd_opts

    initialize.initialize()

    app = FastAPI()
    initialize_util.setup_middleware(app)
    api = create_api(app)

    from modules import script_callbacks
    script_callbacks.before_ui_callback()
    script_callbacks.app_started_callback(None, app)

    print(f"Startup time: {startup_timer.summary()}.")
    api.launch(
        server_name=initialize_util.gradio_server_name(),
        port=cmd_opts.port if cmd_opts.port else 7861,
        root_path=f"/{cmd_opts.subpath}" if cmd_opts.subpath else ""
    )


def webui():
    from modules.shared_cmd_options import cmd_opts

    launch_api = cmd_opts.api
    initialize.initialize()

    from modules import shared, ui_tempdir, script_callbacks, ui, progress, ui_extra_networks

    while 1:
        if shared.opts.clean_temp_dir_at_start:
            ui_tempdir.cleanup_tmpdr()
            startup_timer.record("cleanup temp dir")

        script_callbacks.before_ui_callback()
        startup_timer.record("scripts before_ui_callback")

        shared.demo = ui.create_ui()
        startup_timer.record("create ui")

        if not cmd_opts.no_gradio_queue:
            shared.demo.queue(64)

        gradio_auth_creds = list(initialize_util.get_gradio_auth_creds()) or None

        auto_launch_browser = False
        if os.getenv('SD_WEBUI_RESTARTING') != '1':
            if shared.opts.auto_launch_browser == "Remote" or cmd_opts.autolaunch:
                auto_launch_browser = True
            elif shared.opts.auto_launch_browser == "Local":
                auto_launch_browser = not cmd_opts.webui_is_non_local

        app_kwargs = {
            "docs_url": "/docs",
            "redoc_url": "/redoc",
        }
        gateway_middleware = _build_access_gateway_middleware(gradio_auth_creds)
        if gateway_middleware:
            app_kwargs["middleware"] = gateway_middleware

        app, local_url, share_url = shared.demo.launch(
            share=cmd_opts.share,
            server_name=initialize_util.gradio_server_name(),
            server_port=cmd_opts.port,
            ssl_keyfile=cmd_opts.tls_keyfile,
            ssl_certfile=cmd_opts.tls_certfile,
            ssl_verify=cmd_opts.disable_tls_verify,
            debug=cmd_opts.gradio_debug,
            auth=gradio_auth_creds,
            inbrowser=auto_launch_browser,
            prevent_thread_lock=True,
            allowed_paths=cmd_opts.gradio_allowed_path,
            app_kwargs=app_kwargs,
            root_path=f"/{cmd_opts.subpath}" if cmd_opts.subpath else "",
        )

        startup_timer.record("gradio launch")

        # gradio uses a very open CORS policy via app.user_middleware, which makes it possible for
        # an attacker to trick the user into opening a malicious HTML page, which makes a request to the
        # running web ui and do whatever the attacker wants, including installing an extension and
        # running its code. We disable this here. Suggested by RyotaK.
        app.user_middleware = [x for x in app.user_middleware if x.cls.__name__ != 'CORSMiddleware']

        initialize_util.setup_middleware(app)

        progress.setup_progress_api(app)
        ui.setup_ui_api(app)

        if launch_api:
            create_api(app)

        ui_extra_networks.add_pages_to_demo(app)

        startup_timer.record("add APIs")

        with startup_timer.subcategory("app_started_callback"):
            script_callbacks.app_started_callback(shared.demo, app)

        timer.startup_record = startup_timer.dump()
        print(f"Startup time: {startup_timer.summary()}.")

        try:
            while True:
                server_command = shared.state.wait_for_server_command(timeout=5)
                if server_command:
                    if server_command in ("stop", "restart"):
                        break
                    else:
                        print(f"Unknown server command: {server_command}")
        except KeyboardInterrupt:
            print('Caught KeyboardInterrupt, stopping...')
            server_command = "stop"

        if server_command == "stop":
            print("Stopping server...")
            # If we catch a keyboard interrupt, we want to stop the server and exit.
            shared.demo.close()
            break

        # disable auto launch webui in browser for subsequent UI Reload
        os.environ.setdefault('SD_WEBUI_RESTARTING', '1')

        print('Restarting UI...')
        shared.demo.close()
        time.sleep(0.5)
        startup_timer.reset()
        script_callbacks.app_reload_callback()
        startup_timer.record("app reload callback")
        script_callbacks.script_unloaded_callback()
        startup_timer.record("scripts unloaded callback")
        initialize.initialize_rest(reload_script_modules=True)


if __name__ == "__main__":
    from modules.shared_cmd_options import cmd_opts

    if cmd_opts.nowebui:
        api_only()
    else:
        webui()
