import gradio as gr

from modules import local_llm_manager, script_callbacks


LOCAL_LLM_TAB_HTML = """
<style>
#local_llm_embed_root {
    display: grid;
    gap: 12px;
}

#local_llm_embed_toolbar {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    align-items: center;
    padding: 10px 12px;
    border: 1px solid var(--block-border-color);
    border-radius: 8px;
    background: var(--block-background-fill, transparent);
}

#local_llm_embed_status {
    font-size: 12px;
    color: var(--body-text-color-subdued, #94a3b8);
    min-width: 180px;
}

#local_llm_embed_url {
    min-width: 280px;
    max-width: 480px;
    width: min(100%, 480px);
    padding: 8px 10px;
    border-radius: 8px;
    border: 1px solid var(--block-border-color);
    background: var(--input-background-fill);
    color: var(--body-text-color);
}

#local_llm_embed_reload,
#local_llm_embed_open {
    border: 1px solid var(--block-border-color);
    border-radius: 8px;
    padding: 8px 12px;
    background: var(--button-secondary-background-fill, transparent);
    color: var(--button-secondary-text-color, var(--body-text-color));
    cursor: pointer;
    text-decoration: none;
    font-size: 13px;
}

#local_llm_embed_reload:hover,
#local_llm_embed_open:hover {
    background: var(--button-secondary-background-fill-hover, rgba(255,255,255,0.06));
}

#local_llm_embed_frame_wrap {
    position: relative;
    border: 1px solid var(--block-border-color);
    border-radius: 10px;
    overflow: hidden;
    min-height: 78vh;
    background: #0b0f17;
}

#local_llm_embed_frame {
    width: 100%;
    height: 78vh;
    border: 0;
    display: block;
    background: #0b0f17;
}

#local_llm_embed_overlay {
    position: absolute;
    inset: 0;
    display: none;
    place-items: center;
    padding: 24px;
    background: rgba(11, 15, 23, 0.94);
    color: #dbe4f0;
    text-align: center;
}

#local_llm_embed_overlay.show {
    display: grid;
}

#local_llm_embed_overlay_card {
    max-width: 720px;
    padding: 20px 22px;
    border-radius: 12px;
    border: 1px solid rgba(148, 163, 184, 0.25);
    background: rgba(15, 23, 42, 0.96);
    box-shadow: 0 18px 60px rgba(0, 0, 0, 0.35);
}

#local_llm_embed_overlay_card h3 {
    margin: 0 0 10px;
    font-size: 20px;
}

#local_llm_embed_overlay_card p {
    margin: 0 0 10px;
    line-height: 1.5;
    color: #cbd5e1;
}

#local_llm_embed_overlay_card code {
    background: rgba(148, 163, 184, 0.15);
    border-radius: 6px;
    padding: 1px 6px;
}

@media (max-width: 900px) {
    #local_llm_embed_toolbar {
        flex-direction: column;
        align-items: stretch;
    }

    #local_llm_embed_url {
        min-width: 0;
        max-width: 100%;
        width: 100%;
    }

    #local_llm_embed_frame_wrap,
    #local_llm_embed_frame {
        min-height: 70vh;
        height: 70vh;
    }
}
</style>

<div id="local_llm_embed_root">
    <div id="local_llm_embed_toolbar">
        <input id="local_llm_embed_url" type="text" value="__LOCAL_LLM_URL__" spellcheck="false" />
        <button id="local_llm_embed_reload" type="button">Reload Chat</button>
        <a id="local_llm_embed_open" href="__LOCAL_LLM_URL__" target="_blank" rel="noopener noreferrer">Open in New Tab</a>
    </div>

    <div id="local_llm_embed_frame_wrap">
        <iframe id="local_llm_embed_frame" title="Local LLM Chat" src="__LOCAL_LLM_URL__"></iframe>
        <div id="local_llm_embed_overlay" class="show">
            <div id="local_llm_embed_overlay_card">
                <h3>Local LLM Chat is not reachable</h3>
                <p>Start the local-llm server from this tab, then click <b>Reload Chat</b>.</p>
                <p>Expected address: <code>__LOCAL_LLM_URL__</code></p>
                <p>Typical command: <code>cd local-llm &amp;&amp; python app.py</code></p>
            </div>
        </div>
    </div>
</div>
"""


def _render_html():
    return LOCAL_LLM_TAB_HTML.replace("__LOCAL_LLM_URL__", local_llm_manager.get_local_llm_url())


def _status_outputs(status: dict):
    return (
        local_llm_manager.format_status_markdown(status),
        local_llm_manager.status_payload(status),
    )


def get_chat_status():
    return _status_outputs(local_llm_manager.get_status())


def start_chat_server():
    return _status_outputs(local_llm_manager.start_server())


def stop_chat_server():
    return _status_outputs(local_llm_manager.stop_server())


def restart_chat_server():
    return _status_outputs(local_llm_manager.restart_server())


def on_ui_tabs():
    with gr.Blocks(analytics_enabled=False) as chat_ui:
        with gr.Row():
            start_btn = gr.Button("Start Server", variant="primary")
            stop_btn = gr.Button("Stop Server")
            restart_btn = gr.Button("Restart Server")
            refresh_btn = gr.Button("Refresh Status")

        status_md = gr.Markdown(local_llm_manager.format_status_markdown(local_llm_manager.get_status()), elem_id="local_llm_embed_status")
        status_signal = gr.Textbox(value=local_llm_manager.status_payload(local_llm_manager.get_status()), visible=False, elem_id="local_llm_embed_signal")
        gr.HTML(_render_html())

        start_btn.click(fn=start_chat_server, inputs=[], outputs=[status_md, status_signal], show_progress=False)
        stop_btn.click(fn=stop_chat_server, inputs=[], outputs=[status_md, status_signal], show_progress=False)
        restart_btn.click(fn=restart_chat_server, inputs=[], outputs=[status_md, status_signal], show_progress=False)
        refresh_btn.click(fn=get_chat_status, inputs=[], outputs=[status_md, status_signal], show_progress=False)

    return [(chat_ui, "Chat", "local_llm_embed_tab")]


script_callbacks.on_ui_tabs(on_ui_tabs)