"""Flask backend for local LLM chat interface."""
import os
import re
from flask import Flask, render_template, request, jsonify
from flask_cors import CORS
from pathlib import Path

from models import load_model, generate_response, get_model_info
from history import (
    create_conversation,
    add_message,
    get_conversations,
    get_conversation_messages,
    delete_conversation,
    update_conversation_title,
)

app = Flask(__name__, template_folder="static", static_folder="static")
CORS(app)

# Global state
current_conversation = None
model_loaded = False


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


def build_chat_messages(conversation_id, user_message):
    """Build message list with recent history for chat completion."""
    # Keep context bounded to reduce drift and latency.
    history_limit = int(os.getenv("LOCAL_LLM_HISTORY_LIMIT", "12"))
    system_prompt = os.getenv(
        "LOCAL_LLM_SYSTEM_PROMPT",
        "You are a helpful assistant."
    )

    history = get_conversation_messages(conversation_id)
    recent_history = history[-history_limit:] if history_limit > 0 else history

    messages = [{"role": "system", "content": system_prompt}]
    for item in recent_history:
        role = item.get("role")
        if role in ("user", "assistant"):
            messages.append({"role": role, "content": item.get("content", "")})

    messages.append({"role": "user", "content": user_message})
    return messages


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
    
    current_conversation = create_conversation(title)
    
    return jsonify({
        "conversation_id": current_conversation,
        "title": title
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
        messages = build_chat_messages(current_conversation, user_message)
        add_message(current_conversation, "user", user_message)
        response_text = generate_response(messages=messages, max_tokens=512)
        if not response_text:
            response_text = "I could not generate a clear answer. Please try rephrasing that."
        elif is_unreadable_text(response_text):
            response_text = (
                "I generated a corrupted response with the current quantization. "
                "Please retry your prompt, or switch to a higher-quality quant like IQ3_M/Q4_K_M for cleaner chat."
            )

        add_message(current_conversation, "assistant", response_text)
        
        return jsonify({
            "user_message": user_message,
            "assistant_message": response_text,
            "success": True
        })
    
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
    
    return jsonify({
        "conversation_id": conversation_id,
        "messages": messages
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


if __name__ == "__main__":
    print("Starting Local LLM Chat Server...")
    print("Open http://localhost:5000 in your browser")
    app.run(debug=False, host="0.0.0.0", port=5000)
