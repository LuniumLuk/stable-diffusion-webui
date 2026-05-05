"""Flask backend for local LLM chat interface."""
import os
import re
from flask import Flask, render_template, request, jsonify
from flask_cors import CORS
from pathlib import Path

import re as _re
from models import load_model, generate_response, get_model_info, list_local_models, unload_model_from_gpu
from history import (
    create_conversation,
    add_message,
    get_conversations,
    get_conversation_messages,
    delete_conversation,
    update_conversation_title,
    get_conversation_settings,
    set_conversation_settings,
)


def _auto_title(conversation_id, first_user_message):
    """Generate a short title from the first user message using the model."""
    try:
        title_messages = [
            {
                "role": "system",
                "content": (
                    "You create very short conversation titles (5 words max). "
                    "Reply with ONLY the title, no punctuation, no explanation."
                ),
            },
            {
                "role": "user",
                "content": f"Summarize this as a chat title: {first_user_message[:200]}",
            },
        ]
        raw = generate_response(messages=title_messages, max_tokens=16)
        # Strip markdown / quotes, collapse whitespace, cap at 60 chars.
        title = _re.sub(r"[#*`>_\[\]()\"']", "", raw or "").strip()
        title = _re.sub(r"\s+", " ", title)[:60].strip() or "Chat"
        update_conversation_title(conversation_id, title)
        return title
    except Exception:
        return None

app = Flask(__name__, template_folder="static", static_folder="static")
CORS(app)

# Global state
current_conversation = None
model_loaded = False
PROMPTS_DIR = Path(__file__).parent / "prompts"


def _extract_section(text, section_name):
    """Extract markdown-like [SECTION] blocks from prompt files."""
    pattern = re.compile(
        rf"\[{re.escape(section_name)}\]\s*(.*?)(?=\n\s*\[[^\]]+\]|\Z)",
        re.IGNORECASE | re.DOTALL,
    )
    match = pattern.search(text or "")
    if not match:
        return ""
    return match.group(1).strip()


def _load_prompt_presets():
    """Load prompt presets from local-llm/prompts/*.md."""
    presets = []
    if not PROMPTS_DIR.exists():
        return presets

    for file_path in sorted(PROMPTS_DIR.glob("*.md")):
        try:
            content = file_path.read_text(encoding="utf-8")
        except Exception:
            continue

        title = _extract_section(content, "title") or file_path.stem
        prompt = _extract_section(content, "PROMPT")
        if not prompt:
            continue

        presets.append(
            {
                "key": file_path.stem,
                "title": title,
                "file": file_path.name,
                "prompt": prompt,
            }
        )

    return presets


def _get_prompt_preset(preset_key):
    """Find one preset by key."""
    if not preset_key:
        return None
    for preset in _load_prompt_presets():
        if preset["key"] == preset_key:
            return preset
    return None


def is_unreadable_text(text):
    """Heuristic filter for clearly corrupted generations."""
    if not text:
        return True

    sample = text.strip()
    if len(sample) < 24:
        return False

    weird_patterns = [r"/{3,}", r"\{\s*\}", r"multmult", r"\^\{", r"[=;:,]{4,}"]
    if any(re.search(p, sample, flags=re.IGNORECASE) for p in weird_patterns):
        return True

    # Ratio of odd symbols (excluding common punctuation) can indicate token corruption.
    allowed = set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 .,!?;:'\"()-_[]\n\t")
    odd = sum(1 for ch in sample if ch not in allowed)
    odd_ratio = odd / max(len(sample), 1)
    return odd_ratio > 0.33


def build_chat_messages(conversation_id, user_message, history_limit_override=None):
    """Build message list with recent history for chat completion."""
    # Keep context bounded to reduce drift and latency.
    history_limit = int(os.getenv("LOCAL_LLM_HISTORY_LIMIT", "12"))
    default_system_prompt = os.getenv(
        "LOCAL_LLM_SYSTEM_PROMPT",
        "You are a helpful assistant."
    )
    settings = get_conversation_settings(conversation_id)
    system_prompt = settings.get("system_prompt") or default_system_prompt

    history = get_conversation_messages(conversation_id)
    if history_limit_override is None:
        recent_history = history[-history_limit:] if history_limit > 0 else history
    else:
        recent_history = history[-history_limit_override:] if history_limit_override > 0 else []

    messages = [{"role": "system", "content": system_prompt}]
    for item in recent_history:
        role = item.get("role")
        if role in ("user", "assistant"):
            messages.append({"role": role, "content": item.get("content", "")})

    messages.append({"role": "user", "content": user_message})
    return messages


def _is_context_window_error(error):
    """Return True if error looks like a context-window/token-limit failure."""
    text = str(error or "").lower()
    if not text:
        return False

    context_signals = (
        "context",
        "n_ctx",
        "ctx",
        "token",
        "prompt",
        "kv cache",
    )
    overflow_signals = (
        "too long",
        "too many",
        "exceed",
        "overflow",
        "out of",
    )

    has_context = any(sig in text for sig in context_signals)
    has_overflow = any(sig in text for sig in overflow_signals)
    return has_context and has_overflow


def _generate_response_with_trimmed_history(conversation_id, user_message, max_tokens=512):
    """Generate response with progressive history trimming on context overflow."""
    configured_limit = int(os.getenv("LOCAL_LLM_HISTORY_LIMIT", "12"))
    if configured_limit > 0:
        start_limit = configured_limit
    else:
        start_limit = len(get_conversation_messages(conversation_id))

    limits = []
    if start_limit > 0:
        current = start_limit
        while current > 0:
            if current not in limits:
                limits.append(current)
            if current == 1:
                break
            current = max(current // 2, 1)
    if 0 not in limits:
        limits.append(0)

    last_error = None
    for limit in limits:
        try:
            messages = build_chat_messages(
                conversation_id,
                user_message,
                history_limit_override=limit,
            )
            return generate_response(messages=messages, max_tokens=max_tokens)
        except Exception as e:
            last_error = e
            if _is_context_window_error(e):
                continue
            raise

    if last_error is not None:
        raise last_error
    raise RuntimeError("Failed to generate response")


@app.before_request
def startup():
    """Load model on first request."""
    global model_loaded
    
    if not model_loaded:
        try:
            load_model()
            model_loaded = True
            print("✓ Model loaded successfully")
        except FileNotFoundError as e:
            print(f"✗ {e}")
            model_loaded = False


# ============= Chat Routes =============

@app.route("/")
def index():
    """Serve the chat UI."""
    return render_template("index.html")


@app.route("/api/chat/new", methods=["POST"])
def new_conversation():
    """Create a new conversation."""
    global current_conversation
    
    data = request.json or {}
    title = data.get("title", "New Chat")
    preset_key = (data.get("preset_key") or "").strip()
    
    current_conversation = create_conversation(title)

    # Persist selected preset prompt for this conversation.
    if preset_key:
        preset = _get_prompt_preset(preset_key)
        if preset:
            set_conversation_settings(
                current_conversation,
                system_prompt=preset["prompt"],
                preset_key=preset["key"],
            )
    
    settings = get_conversation_settings(current_conversation)
    return jsonify({
        "conversation_id": current_conversation,
        "title": title,
        "preset_key": preset_key or None,
        "system_prompt": settings.get("system_prompt"),
    })


@app.route("/api/chat/send", methods=["POST"])
def send_message():
    """Send a message and get a response."""
    global current_conversation
    
    if current_conversation is None:
        return jsonify({"error": "No active conversation"}), 400
    
    data = request.json
    user_message = data.get("message", "").strip()
    
    if not user_message:
        return jsonify({"error": "Empty message"}), 400
    
    if not model_loaded:
        return jsonify({"error": "Model not loaded"}), 503
    
    # Build the prompt from prior history before persisting the new user turn.
    # The previous flow saved the message first, then appended it again here,
    # so the current user prompt was sent to the model twice.
    try:
        response_text = _generate_response_with_trimmed_history(
            current_conversation,
            user_message,
            max_tokens=512,
        )
        if not response_text:
            response_text = "I could not generate a clear answer. Please try rephrasing that."
        elif is_unreadable_text(response_text):
            response_text = (
                "I generated a corrupted response with the current quantization. "
                "Please retry your prompt, or switch to a higher-quality quant like IQ3_M/Q4_K_M for cleaner chat."
            )

        add_message(current_conversation, "user", user_message)
        add_message(current_conversation, "assistant", response_text)

        # Auto-title on the very first exchange (title is still "New Chat").
        auto_title = None
        conversations = get_conversations()
        for c in conversations:
            if c["id"] == current_conversation and c["title"] == "New Chat":
                auto_title = _auto_title(current_conversation, user_message)
                break

        payload = {
            "user_message": user_message,
            "assistant_message": response_text,
            "success": True,
        }
        if auto_title:
            payload["auto_title"] = auto_title
        return jsonify(payload)
    
    except Exception as e:
        return jsonify({"error": str(e)}), 500


# ============= History Routes =============

@app.route("/api/history/list", methods=["GET"])
def list_conversations():
    """Get all conversations."""
    conversations = get_conversations()
    return jsonify(conversations)


@app.route("/api/history/load/<int:conversation_id>", methods=["GET"])
def load_conversation(conversation_id):
    """Load a conversation."""
    global current_conversation
    
    current_conversation = conversation_id
    messages = get_conversation_messages(conversation_id)
    settings = get_conversation_settings(conversation_id)
    
    return jsonify({
        "conversation_id": conversation_id,
        "messages": messages,
        "preset_key": settings.get("preset_key"),
        "system_prompt": settings.get("system_prompt"),
    })


@app.route("/api/history/delete/<int:conversation_id>", methods=["DELETE"])
def delete_conv(conversation_id):
    """Delete a conversation."""
    global current_conversation
    
    delete_conversation(conversation_id)
    
    if current_conversation == conversation_id:
        current_conversation = None
    
    return jsonify({"success": True})


@app.route("/api/history/rename/<int:conversation_id>", methods=["POST"])
def rename_conversation(conversation_id):
    """Rename a conversation."""
    data = request.json
    new_title = data.get("title", "Untitled")
    
    update_conversation_title(conversation_id, new_title)
    
    return jsonify({"success": True})


# ============= Status Routes =============

@app.route("/api/status", methods=["GET"])
def status():
    """Get server and model status."""
    return jsonify({
        "server_running": True,
        "model_loaded": model_loaded,
        "model_info": get_model_info(),
        "current_conversation": current_conversation
    })


# ============= Model Routes =============

@app.route("/api/prompts/list", methods=["GET"])
def list_prompt_presets():
    """List available startup prompt presets from prompts folder."""
    presets = _load_prompt_presets()
    # Do not return full prompt body in listing response.
    compact = [
        {
            "key": p["key"],
            "title": p["title"],
            "file": p["file"],
        }
        for p in presets
    ]
    return jsonify({"presets": compact})

@app.route("/api/models/list", methods=["GET"])
def list_models():
    """List local GGUF models."""
    models = list_local_models()
    return jsonify({
        "models": models,
        "current_model": get_model_info().get("model_name"),
    })


@app.route("/api/models/select", methods=["POST"])
def select_model_route():
    """Switch active model by filename or stem."""
    global model_loaded

    data = request.json or {}
    model_name = (data.get("model") or "").strip()
    if not model_name:
        return jsonify({"error": "Missing model name"}), 400

    try:
        load_model(model_name=model_name)
        model_loaded = True
        return jsonify({
            "success": True,
            "model_info": get_model_info(),
        })
    except FileNotFoundError:
        return jsonify({"error": f"Model not found: {model_name}"}), 404
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/models/unload-gpu", methods=["POST"])
def unload_gpu_route():
    """Unload model from GPU and release VRAM."""
    result = unload_model_from_gpu()
    return jsonify(result)


if __name__ == "__main__":
    print("Starting Local LLM Chat Server...")
    print("Open http://localhost:7820 in your browser")
    app.run(debug=False, host="0.0.0.0", port=7820)
