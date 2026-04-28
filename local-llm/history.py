"""Chat history management with SQLite."""
import sqlite3
import json
from datetime import datetime
from pathlib import Path

HISTORY_DB = Path(__file__).parent / "history.db"


def init_db():
    """Initialize SQLite database for chat history."""
    conn = sqlite3.connect(HISTORY_DB)
    cursor = conn.cursor()
    
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS conversations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT DEFAULT 'Untitled',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    """)
    
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            conversation_id INTEGER NOT NULL,
            role TEXT NOT NULL,
            content TEXT NOT NULL,
            timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (conversation_id) REFERENCES conversations(id)
        )
    """)
    
    conn.commit()
    conn.close()


def create_conversation(title="Untitled"):
    """Create a new conversation."""
    conn = sqlite3.connect(HISTORY_DB)
    cursor = conn.cursor()
    
    cursor.execute(
        "INSERT INTO conversations (title) VALUES (?)",
        (title,)
    )
    conn.commit()
    conv_id = cursor.lastrowid
    conn.close()
    
    return conv_id


def add_message(conversation_id, role, content):
    """Add a message to a conversation."""
    conn = sqlite3.connect(HISTORY_DB)
    cursor = conn.cursor()
    
    cursor.execute(
        "INSERT INTO messages (conversation_id, role, content) VALUES (?, ?, ?)",
        (conversation_id, role, content)
    )
    cursor.execute(
        "UPDATE conversations SET updated_at = CURRENT_TIMESTAMP WHERE id = ?",
        (conversation_id,)
    )
    conn.commit()
    conn.close()


def get_conversations():
    """Get all conversations (summary only)."""
    conn = sqlite3.connect(HISTORY_DB)
    cursor = conn.cursor()
    
    cursor.execute(
        "SELECT id, title, created_at, updated_at FROM conversations ORDER BY updated_at DESC"
    )
    conversations = cursor.fetchall()
    conn.close()
    
    return [
        {
            "id": row[0],
            "title": row[1],
            "created_at": row[2],
            "updated_at": row[3]
        }
        for row in conversations
    ]


def get_conversation_messages(conversation_id):
    """Get all messages for a conversation."""
    conn = sqlite3.connect(HISTORY_DB)
    cursor = conn.cursor()
    
    cursor.execute(
        "SELECT role, content, timestamp FROM messages WHERE conversation_id = ? ORDER BY timestamp ASC",
        (conversation_id,)
    )
    messages = cursor.fetchall()
    conn.close()
    
    return [
        {
            "role": row[0],
            "content": row[1],
            "timestamp": row[2]
        }
        for row in messages
    ]


def delete_conversation(conversation_id):
    """Delete a conversation and all its messages."""
    conn = sqlite3.connect(HISTORY_DB)
    cursor = conn.cursor()
    
    cursor.execute("DELETE FROM messages WHERE conversation_id = ?", (conversation_id,))
    cursor.execute("DELETE FROM conversations WHERE id = ?", (conversation_id,))
    conn.commit()
    conn.close()


def update_conversation_title(conversation_id, title):
    """Update conversation title."""
    conn = sqlite3.connect(HISTORY_DB)
    cursor = conn.cursor()
    
    cursor.execute(
        "UPDATE conversations SET title = ? WHERE id = ?",
        (title, conversation_id)
    )
    conn.commit()
    conn.close()


# Initialize on module import
init_db()
