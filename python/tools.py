"""
Tool definitions, RAG data, and tool implementations for the Custom LLM Server.

Add your own tools by:
1. Adding a schema to TOOL_DEFINITIONS
2. Implementing a handler function with signature (app_id, user_id, channel, args) -> str
3. Registering the handler in TOOL_MAP
"""

import logging

logger = logging.getLogger(__name__)

# Sample knowledge base for RAG retrieval
RAG_DATA = {
    "agora_convoai": (
        "Agora Conversational AI enables real-time voice and video AI agents. "
        "It connects to LLM providers through a Custom LLM server, supports "
        "tool calling, and provides sub-second voice interactions. Agents join "
        "Agora RTC channels and communicate with users via voice, video, or text."
    ),
    "custom_llm": (
        "A Custom LLM server intercepts requests between Agora ConvoAI and your "
        "LLM provider. It receives OpenAI-compatible chat completion requests, "
        "can modify messages, inject RAG context, execute tools server-side, "
        "and route to different models. Responses stream back as Server-Sent Events."
    ),
    "agora_rtm": (
        "Agora Real-Time Messaging (RTM) provides low-latency text messaging "
        "between users and AI agents. RTM channels allow the Custom LLM server "
        "to receive and send text messages alongside voice/video interactions."
    ),
    "tool_calling": (
        "Tool calling lets LLMs invoke external functions during a conversation. "
        "The model returns a tool_calls response, the server executes the function, "
        "and sends the result back to the model for a final answer. This enables "
        "weather lookups, calculations, database queries, and more."
    ),
}

# OpenAI-compatible tool schemas
TOOL_DEFINITIONS = [
    {
        "type": "function",
        "function": {
            "name": "get_weather",
            "description": "Get the current weather for a given location",
            "parameters": {
                "type": "object",
                "properties": {
                    "location": {
                        "type": "string",
                        "description": "City name, e.g. 'Tokyo' or 'San Francisco'",
                    }
                },
                "required": ["location"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "calculate",
            "description": "Evaluate a mathematical expression and return the result",
            "parameters": {
                "type": "object",
                "properties": {
                    "expression": {
                        "type": "string",
                        "description": "Math expression to evaluate, e.g. '42 * 17'",
                    }
                },
                "required": ["expression"],
            },
        },
    },
]


def get_weather(app_id: str, user_id: str, channel: str, args: dict) -> str:
    """Simulated weather lookup. Replace with a real weather API call."""
    location = args.get("location", "Unknown")
    logger.info(f"get_weather called for location={location}")
    return f"Weather in {location}: 72°F (22°C), partly cloudy, humidity 45%"


def calculate(app_id: str, user_id: str, channel: str, args: dict) -> str:
    """Safe math expression evaluator."""
    expression = args.get("expression", "0")
    logger.info(f"calculate called with expression={expression}")
    try:
        result = eval(expression, {"__builtins__": {}}, {})
        return f"Result: {result}"
    except Exception as e:
        return f"Error evaluating '{expression}': {e}"


# Map tool names to handler functions
TOOL_MAP = {
    "get_weather": get_weather,
    "calculate": calculate,
}


def perform_rag_retrieval(messages) -> str:
    """
    Simple keyword-based RAG retrieval from RAG_DATA.

    Finds the last user message and matches keywords (>3 chars) against
    the knowledge base entries. Returns matching entries joined by newlines.
    """
    query = ""
    if isinstance(messages, list):
        for msg in reversed(messages):
            role = None
            content = None
            if hasattr(msg, "role"):
                role = msg.role
                content = msg.content if hasattr(msg, "content") else ""
            elif isinstance(msg, dict):
                role = msg.get("role")
                content = msg.get("content", "")
            if role == "user" and content:
                query = str(content).lower()
                break

    if not query:
        return ""

    keywords = [word for word in query.split() if len(word) > 3]
    if not keywords:
        return ""

    relevant = []
    for _key, value in RAG_DATA.items():
        value_lower = value.lower()
        if any(word in value_lower for word in keywords):
            relevant.append(value)

    return "\n\n".join(relevant) if relevant else "No relevant information found."


def refact_messages(context: str, messages):
    """
    Inject retrieved RAG context as a system message prepended to the
    message list. If context is empty or not found, returns messages unchanged.
    """
    if not context or context == "No relevant information found.":
        return messages

    context_msg = {
        "role": "system",
        "content": f"Use this knowledge to answer the user's question:\n{context}",
    }

    if isinstance(messages, list):
        return [context_msg] + list(messages)
    return messages
