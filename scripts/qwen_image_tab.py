import gradio as gr

from modules import qwen_image_manager, script_callbacks


QWEN_IMAGE_TAB_HTML = """
<style>
#qwen_image_embed_root {
    display: grid;
    gap: 12px;
}

#qwen_image_embed_toolbar {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    align-items: center;
    padding: 10px 12px;
    border: 1px solid var(--block-border-color);
    border-radius: 8px;
    background: var(--block-background-fill, transparent);
}

#qwen_image_embed_status {
    font-size: 12px;
    color: var(--body-text-color-subdued, #94a3b8);
    min-width: 180px;
}

#qwen_image_embed_presets {
    font-size: 12px;
    color: var(--body-text-color-subdued, #94a3b8);
    padding: 8px 12px;
    border: 1px solid var(--block-border-color);
    border-radius: 8px;
    background: var(--block-background-fill, transparent);
}

#qwen_image_embed_url {
    min-width: 280px;
    max-width: 480px;
    width: min(100%, 480px);
    padding: 8px 10px;
    border-radius: 8px;
    border: 1px solid var(--block-border-color);
    background: var(--input-background-fill);
    color: var(--body-text-color);
}

#qwen_image_embed_reload,
#qwen_image_embed_open {
    padding: 8px 12px;
    border-radius: 8px;
    border: 1px solid var(--block-border-color);
    background: var(--button-secondary-background-fill, transparent);
    color: var(--body-text-color);
    cursor: pointer;
    text-decoration: none;
}

#qwen_image_embed_reload:hover,
#qwen_image_embed_open:hover {
    border-color: var(--color-accent);
}

#qwen_image_embed_frame_wrap {
    position: relative;
    border: 1px solid var(--block-border-color);
    border-radius: 10px;
    overflow: hidden;
    background: var(--block-background-fill, transparent);
    min-height: 70vh;
}

#qwen_image_embed_frame {
    display: block;
    width: 100%;
    height: 70vh;
    border: 0;
    background: #0b0f14;
}

#qwen_image_embed_overlay {
    position: absolute;
    inset: 0;
    display: none;
    align-items: center;
    justify-content: center;
    background: rgba(2, 6, 23, 0.72);
    backdrop-filter: blur(2px);
}

#qwen_image_embed_overlay.show {
    display: flex;
}

#qwen_image_embed_overlay_card {
    max-width: 520px;
    padding: 18px 22px;
    border-radius: 12px;
    border: 1px solid var(--block-border-color);
    background: var(--block-background-fill, #0f172a);
    color: var(--body-text-color);
    text-align: center;
}

#qwen_image_embed_overlay_card h3 {
    margin: 0 0 8px 0;
}

#qwen_image_embed_overlay_card p {
    margin: 6px 0;
    font-size: 13px;
    color: var(--body-text-color-subdued, #94a3b8);
}

#qwen_image_embed_overlay_card code {
    color: var(--color-accent);
}

@media (max-width: 768px) {
    #qwen_image_embed_url {
        min-width: 100%;
        max-width: 100%;
    }

    #qwen_image_embed_frame_wrap,
    #qwen_image_embed_frame {
        min-height: 70vh;
        height: 70vh;
    }
}
</style>

<div id="qwen_image_embed_root">
    <div id="qwen_image_embed_toolbar">
        <input id="qwen_image_embed_url" type="text" value="__QWEN_IMAGE_URL__" spellcheck="false" />
        <button id="qwen_image_embed_reload" type="button">Reload UI</button>
        <a id="qwen_image_embed_open" href="__QWEN_IMAGE_URL__" target="_blank" rel="noopener noreferrer">Open in New Tab</a>
    </div>

    <div id="qwen_image_embed_presets">
        <b>Resolution presets</b> (width x height, divisible by 32):
        1K — 1:1 <code>1024x1024</code> · 2:3 <code>1024x1536</code> · 3:2 <code>1536x1024</code>
        &nbsp;|&nbsp;
        2K — 1:1 <code>2048x2048</code> · 2:3 <code>1696x2528</code> · 3:2 <code>2528x1696</code>
        &nbsp;|&nbsp; CLI: <code>qwen_image_txt2img.bat "prompt" 1k:2:3</code>
        &nbsp;|&nbsp; Generated images auto-save to <code>outputs/qwen/&lt;date&gt;/&lt;hh-mm-ss&gt;/&lt;n&gt;.jpg</code>
    </div>

    <div id="qwen_image_embed_frame_wrap">
        <iframe id="qwen_image_embed_frame" title="Qwen-Image 2.1" src="__QWEN_IMAGE_URL__"></iframe>
        <div id="qwen_image_embed_overlay" class="show">
            <div id="qwen_image_embed_overlay_card">
                <h3>Qwen-Image 2.1 server is not reachable</h3>
                <p>Start it with <b>Start Server</b> above (or run <code>qwen_image_server.bat</code>), then click <b>Reload UI</b>.</p>
                <p>Expected address: <code>__QWEN_IMAGE_URL__</code></p>
                <p>First start loads ~10GB of weights and can take a while.</p>
                <p>20-step times on RTX 5070 Ti: 1K ~51-83s, 2K ~5.2-5.5 min.</p>
            </div>
        </div>
    </div>
</div>
"""


def _render_html():
    return QWEN_IMAGE_TAB_HTML.replace("__QWEN_IMAGE_URL__", qwen_image_manager.get_server_url())


def _status_outputs(status: dict):
    return (
        qwen_image_manager.format_status_markdown(status),
        qwen_image_manager.status_payload(status),
    )


def get_server_status():
    return _status_outputs(qwen_image_manager.get_status())


def start_qwen_server():
    return _status_outputs(qwen_image_manager.start_server())


def stop_qwen_server():
    return _status_outputs(qwen_image_manager.stop_server())


def restart_qwen_server():
    return _status_outputs(qwen_image_manager.restart_server())


def on_ui_tabs():
    with gr.Blocks(analytics_enabled=False) as qwen_ui:
        with gr.Row():
            start_btn = gr.Button("Start Server", variant="primary")
            stop_btn = gr.Button("Stop Server")
            restart_btn = gr.Button("Restart Server")
            refresh_btn = gr.Button("Refresh Status")

        status_md = gr.Markdown(qwen_image_manager.format_status_markdown(qwen_image_manager.get_status()), elem_id="qwen_image_embed_status")
        status_signal = gr.Textbox(value=qwen_image_manager.status_payload(qwen_image_manager.get_status()), visible=False, elem_id="qwen_image_embed_signal")
        gr.HTML(_render_html())

        start_btn.click(fn=start_qwen_server, inputs=[], outputs=[status_md, status_signal], show_progress=False)
        stop_btn.click(fn=stop_qwen_server, inputs=[], outputs=[status_md, status_signal], show_progress=False)
        restart_btn.click(fn=restart_qwen_server, inputs=[], outputs=[status_md, status_signal], show_progress=False)
        refresh_btn.click(fn=get_server_status, inputs=[], outputs=[status_md, status_signal], show_progress=False)

    return [(qwen_ui, "Qwen-Image 2.1", "qwen_image_embed_tab")]


script_callbacks.on_ui_tabs(on_ui_tabs)
