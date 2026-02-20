"""
In-memory conversation store for the Custom LLM Server.

Stores conversations keyed by appId:userId:channel. Includes automatic
trimming when conversations exceed MAX_MESSAGES and periodic cleanup
of stale conversations.
"""

import time
import threading
import logging
from typing import Dict, List, Optional

logger = logging.getLogger(__name__)

# Limits
MAX_MESSAGES = 100
TARGET_MESSAGES = 75
CLEANUP_INTERVAL = 3600  # 1 hour
MAX_AGE = 86400  # 24 hours

# In-memory store: key -> {"messages": [...], "last_updated": float}
_conversations: Dict[str, dict] = {}
_lock = threading.Lock()


def get_conversation_key(app_id: str, user_id: str, channel: str) -> str:
    return f"{app_id}:{user_id}:{channel}"


def get_or_create_conversation(app_id: str, user_id: str, channel: str) -> dict:
    key = get_conversation_key(app_id, user_id, channel)
    with _lock:
        if key not in _conversations:
            logger.info(f"Creating new conversation: {key}")
            _conversations[key] = {
                "messages": [],
                "last_updated": time.time(),
            }
        return _conversations[key]


def save_message(
    app_id: str, user_id: str, channel: str, message: dict
) -> None:
    """
    Append a message to the conversation and trim if necessary.

    message should be a dict with at least 'role' and 'content'.
    Tool messages should also have 'tool_call_id' and 'name'.
    Assistant tool_call messages should have 'tool_calls'.
    """
    conv = get_or_create_conversation(app_id, user_id, channel)
    msg = {**message, "timestamp": time.time()}
    with _lock:
        conv["messages"].append(msg)
        conv["last_updated"] = time.time()
        if len(conv["messages"]) > MAX_MESSAGES:
            _trim_conversation(conv)

    logger.debug(
        f"Saved {message.get('role')} message, "
        f"total={len(conv['messages'])} [{app_id}:{user_id}:{channel}]"
    )


def get_messages(app_id: str, user_id: str, channel: str) -> List[dict]:
    """Return a copy of the conversation messages."""
    conv = get_or_create_conversation(app_id, user_id, channel)
    with _lock:
        return list(conv["messages"])


def _trim_conversation(conv: dict) -> None:
    """
    Trim a conversation to TARGET_MESSAGES, preserving:
    1. All system messages
    2. Tool call pairs (assistant with tool_calls + tool response)
    3. Most recent non-system messages
    """
    messages = conv["messages"]
    system_msgs = [m for m in messages if m.get("role") == "system"]
    non_system = [m for m in messages if m.get("role") != "system"]

    # Keep the most recent TARGET_MESSAGES non-system messages
    kept = non_system[-TARGET_MESSAGES:]

    # Ensure tool message pairs are intact
    tool_call_ids_in_kept = set()
    for m in kept:
        if m.get("role") == "tool" and m.get("tool_call_id"):
            tool_call_ids_in_kept.add(m["tool_call_id"])
        if m.get("role") == "assistant" and m.get("tool_calls"):
            for tc in m["tool_calls"]:
                tc_id = tc.get("id") if isinstance(tc, dict) else None
                if tc_id:
                    tool_call_ids_in_kept.add(tc_id)

    # Check for orphaned tool messages and add their pairs
    for m in non_system:
        if m in kept:
            continue
        if m.get("role") == "assistant" and m.get("tool_calls"):
            for tc in m["tool_calls"]:
                tc_id = tc.get("id") if isinstance(tc, dict) else None
                if tc_id and tc_id in tool_call_ids_in_kept:
                    kept.insert(0, m)
                    break
        elif m.get("role") == "tool" and m.get("tool_call_id") in tool_call_ids_in_kept:
            kept.insert(0, m)

    # Sort by timestamp
    kept.sort(key=lambda m: m.get("timestamp", 0))

    conv["messages"] = system_msgs + kept
    logger.debug(
        f"Trimmed conversation: {len(messages)} -> {len(conv['messages'])}"
    )


def cleanup_old_conversations() -> None:
    """Remove conversations older than MAX_AGE."""
    now = time.time()
    removed = 0
    with _lock:
        keys_to_remove = [
            key
            for key, conv in _conversations.items()
            if now - conv["last_updated"] > MAX_AGE
        ]
        for key in keys_to_remove:
            del _conversations[key]
            removed += 1

    if removed:
        logger.info(f"Cleaned up {removed} old conversation(s)")


def _cleanup_loop() -> None:
    """Background thread that runs cleanup periodically."""
    while True:
        time.sleep(CLEANUP_INTERVAL)
        try:
            cleanup_old_conversations()
        except Exception as e:
            logger.error(f"Cleanup error: {e}")


# Start the background cleanup thread
_cleanup_thread = threading.Thread(target=_cleanup_loop, daemon=True)
_cleanup_thread.start()
logger.info(
    f"Conversation store initialized (max={MAX_MESSAGES}, "
    f"target={TARGET_MESSAGES}, cleanup every {CLEANUP_INTERVAL}s)"
)
