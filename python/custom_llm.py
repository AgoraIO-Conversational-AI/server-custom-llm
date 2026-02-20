import base64
import os
import json
import traceback
import logging
import uvicorn
import aiofiles
import uuid
from typing import List, Union, Dict, Optional
from pydantic import BaseModel, HttpUrl

from fastapi.responses import JSONResponse, StreamingResponse
from fastapi import FastAPI, HTTPException
import asyncio
import random

from openai import AsyncOpenAI

from tools import TOOL_DEFINITIONS, TOOL_MAP, perform_rag_retrieval, refact_messages
from conversation_store import save_message, get_messages

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(
    title="Chat Completion API",
    description="API for streaming chat completions with support for text, image, and audio content",
    version="1.0.0",
)

# Env var standardization with backward-compatible fallbacks
LLM_API_KEY = (
    os.getenv("LLM_API_KEY")
    or os.getenv("YOUR_LLM_API_KEY")
    or os.getenv("OPENAI_API_KEY")
    or ""
)
LLM_BASE_URL = os.getenv("LLM_BASE_URL", "https://api.openai.com/v1")
LLM_MODEL = os.getenv("LLM_MODEL", "gpt-4o-mini")


class TextContent(BaseModel):
    type: str = "text"
    text: str


class ImageContent(BaseModel):
    type: str = "image"
    image_url: HttpUrl


class AudioContent(BaseModel):
    type: str = "input_audio"
    input_audio: Dict[str, str]


class ToolFunction(BaseModel):
    name: str
    description: Optional[str] = None
    parameters: Optional[Dict] = None
    strict: bool = False


class Tool(BaseModel):
    type: str = "function"
    function: ToolFunction


class ToolChoice(BaseModel):
    type: str = "function"
    function: Optional[Dict] = None


class ResponseFormat(BaseModel):
    type: str = "json_schema"
    json_schema: Optional[Dict[str, str]] = None


class SystemMessage(BaseModel):
    role: str = "system"
    content: Union[str, List[str]]


class UserMessage(BaseModel):
    role: str = "user"
    content: Union[str, List[Union[TextContent, ImageContent, AudioContent]]]


class AssistantMessage(BaseModel):
    role: str = "assistant"
    content: Union[str, List[TextContent]] = None
    audio: Optional[Dict[str, str]] = None
    tool_calls: Optional[List[Dict]] = None


class ToolMessage(BaseModel):
    role: str = "tool"
    content: Union[str, List[str]]
    tool_call_id: str


class ChatCompletionRequest(BaseModel):
    context: Optional[Dict] = None
    model: Optional[str] = None
    messages: List[Union[SystemMessage, UserMessage, AssistantMessage, ToolMessage]]
    response_format: Optional[ResponseFormat] = None
    modalities: List[str] = ["text"]
    audio: Optional[Dict[str, str]] = None
    tools: Optional[List[Tool]] = None
    tool_choice: Optional[Union[str, ToolChoice]] = "auto"
    parallel_tool_calls: bool = True
    stream: bool = True
    stream_options: Optional[Dict] = None


def extract_context(request: ChatCompletionRequest):
    """Extract appId, userId, channel from the request context."""
    ctx = request.context or {}
    app_id = ctx.get("appId", "")
    user_id = ctx.get("userId", "")
    channel = ctx.get("channel", "default")
    return app_id, user_id, channel


def messages_to_dicts(messages) -> list:
    """Convert Pydantic message objects to plain dicts for the OpenAI API."""
    result = []
    for msg in messages:
        if isinstance(msg, dict):
            result.append(msg)
        elif hasattr(msg, "model_dump"):
            d = msg.model_dump(exclude_none=True)
            result.append(d)
        else:
            result.append({"role": str(msg.role), "content": str(msg.content)})
    return result


def build_messages_with_history(app_id, user_id, channel, request_messages):
    """
    Merge conversation history with incoming request messages.
    Returns a list of plain dicts ready for the OpenAI API.
    """
    history = get_messages(app_id, user_id, channel)
    incoming = messages_to_dicts(request_messages)

    # Save incoming user messages to the store
    for msg in incoming:
        if msg.get("role") == "user":
            save_message(app_id, user_id, channel, msg)

    # Combine: history (already dicts) + incoming
    # Skip duplicates: if incoming messages already appear at the end of history, don't double
    combined = list(history) + incoming
    return combined


def get_tools_for_request(request: ChatCompletionRequest):
    """Return tool definitions — use request tools if provided, else built-in."""
    if request.tools:
        return [t.model_dump() for t in request.tools]
    return TOOL_DEFINITIONS


# ─── Streaming tool call accumulation helpers ───


def accumulate_tool_calls(accumulated, delta_tool_calls):
    """
    Accumulate streaming tool call fragments into complete tool calls.
    Returns the updated accumulated list.
    """
    for tc in delta_tool_calls:
        idx = tc.get("index", 0)

        # Extend list if needed
        while len(accumulated) <= idx:
            accumulated.append({})

        entry = accumulated[idx]

        if tc.get("id"):
            entry["id"] = tc["id"]
        if tc.get("type"):
            entry["type"] = tc["type"]

        if "function" not in entry:
            entry["function"] = {}

        fn = tc.get("function", {})
        if fn.get("name"):
            entry["function"]["name"] = fn["name"]
        if fn.get("arguments") is not None:
            entry["function"]["arguments"] = entry["function"].get(
                "arguments", ""
            ) + fn["arguments"]

    return accumulated


async def execute_tools(tool_calls, app_id, user_id, channel):
    """Execute tool calls and return list of tool result messages."""
    results = []
    for tc in tool_calls:
        name = tc.get("function", {}).get("name", "")
        args_str = tc.get("function", {}).get("arguments", "{}")
        tc_id = tc.get("id", "")

        fn = TOOL_MAP.get(name)
        if not fn:
            logger.error(f"Unknown tool: {name}")
            result = f"Error: unknown tool '{name}'"
        else:
            try:
                args = json.loads(args_str)
            except json.JSONDecodeError:
                args = {}
            try:
                result = fn(app_id, user_id, channel, args)
            except Exception as e:
                logger.error(f"Tool execution error ({name}): {e}")
                result = f"Error executing {name}: {e}"

        results.append(
            {
                "role": "tool",
                "tool_call_id": tc_id,
                "name": name,
                "content": result,
            }
        )
    return results


# ─── Endpoints ───


@app.post("/chat/completions")
async def create_chat_completion(request: ChatCompletionRequest):
    try:
        logger.info(f"Received request: {request.model_dump_json()}")
        model = request.model or LLM_MODEL
        app_id, user_id, channel = extract_context(request)
        client = AsyncOpenAI(api_key=LLM_API_KEY, base_url=LLM_BASE_URL)
        tools = get_tools_for_request(request)

        # Build messages with conversation history
        messages = build_messages_with_history(
            app_id, user_id, channel, request.messages
        )

        if not request.stream:
            # ── Non-streaming with multi-pass tool execution ──
            for _pass in range(5):
                response = await client.chat.completions.create(
                    model=model,
                    messages=messages,
                    tools=tools if tools else None,
                    tool_choice=(
                        request.tool_choice if tools else None
                    ),
                )

                choice = response.choices[0]
                if not choice.message.tool_calls:
                    # No tool calls — save and return
                    content = choice.message.content or ""
                    if content:
                        save_message(
                            app_id,
                            user_id,
                            channel,
                            {"role": "assistant", "content": content},
                        )
                    return JSONResponse(response.model_dump())

                # Execute tools
                assistant_msg = {
                    "role": "assistant",
                    "content": choice.message.content or "",
                    "tool_calls": [
                        tc.model_dump() for tc in choice.message.tool_calls
                    ],
                }
                messages.append(assistant_msg)
                save_message(app_id, user_id, channel, assistant_msg)

                tool_results = await execute_tools(
                    [tc.model_dump() for tc in choice.message.tool_calls],
                    app_id,
                    user_id,
                    channel,
                )
                for tr in tool_results:
                    messages.append(tr)
                    save_message(app_id, user_id, channel, tr)

            # Max passes reached — return last response
            return JSONResponse(response.model_dump())

        # ── Streaming with tool execution ──
        async def generate():
            nonlocal messages
            current_messages = list(messages)

            for _pass in range(5):
                stream = await client.chat.completions.create(
                    model=model,
                    messages=current_messages,
                    tools=tools if tools else None,
                    tool_choice=(
                        request.tool_choice if tools else None
                    ),
                    modalities=request.modalities,
                    audio=request.audio,
                    response_format=request.response_format,
                    stream=True,
                    stream_options=request.stream_options,
                )

                accumulated_tool_calls = []
                accumulated_content = ""
                finish_reason = None

                try:
                    async for chunk in stream:
                        delta = (
                            chunk.choices[0].delta if chunk.choices else None
                        )
                        finish_reason = (
                            chunk.choices[0].finish_reason
                            if chunk.choices
                            else None
                        )

                        if delta and hasattr(delta, "tool_calls") and delta.tool_calls:
                            # Accumulate tool call fragments
                            raw_tcs = [tc.model_dump() for tc in delta.tool_calls]
                            accumulated_tool_calls = accumulate_tool_calls(
                                accumulated_tool_calls, raw_tcs
                            )
                            # Don't yield tool call chunks to client
                            continue

                        if delta and delta.content:
                            accumulated_content += delta.content

                        # Yield non-tool chunks to client
                        yield f"data: {json.dumps(chunk.model_dump())}\n\n"

                except asyncio.CancelledError:
                    logger.info("Stream cancelled")
                    raise

                if finish_reason == "tool_calls" and accumulated_tool_calls:
                    # Execute tools and loop back
                    assistant_msg = {
                        "role": "assistant",
                        "content": accumulated_content or "",
                        "tool_calls": accumulated_tool_calls,
                    }
                    current_messages.append(assistant_msg)
                    save_message(app_id, user_id, channel, assistant_msg)

                    tool_results = await execute_tools(
                        accumulated_tool_calls, app_id, user_id, channel
                    )
                    for tr in tool_results:
                        current_messages.append(tr)
                        save_message(app_id, user_id, channel, tr)

                    # Continue the loop — will make a new LLM call
                    continue

                # No tool calls — save assistant response and finish
                if accumulated_content:
                    save_message(
                        app_id,
                        user_id,
                        channel,
                        {"role": "assistant", "content": accumulated_content},
                    )

                yield "data: [DONE]\n\n"
                return

            # Max passes — end stream
            yield "data: [DONE]\n\n"

        return StreamingResponse(generate(), media_type="text/event-stream")

    except asyncio.CancelledError:
        logger.info("Request was cancelled")
        raise HTTPException(status_code=499, detail="Request was cancelled")
    except HTTPException:
        raise
    except Exception as e:
        traceback_str = "".join(traceback.format_tb(e.__traceback__))
        error_message = f"{str(e)}\n{traceback_str}"
        logger.error(error_message)
        raise HTTPException(status_code=500, detail=error_message)


waiting_messages = [
    "Just a moment, I'm thinking...",
    "Let me think about that for a second...",
    "Good question, let me find out...",
]


@app.post("/rag/chat/completions")
async def create_rag_chat_completion(request: ChatCompletionRequest):
    try:
        logger.info(f"Received RAG request: {request.model_dump_json()}")
        model = request.model or LLM_MODEL
        app_id, user_id, channel = extract_context(request)

        if not request.stream:
            raise HTTPException(
                status_code=400, detail="chat completions require streaming"
            )

        async def generate():
            # Send a "please wait" prompt
            waiting_message = {
                "id": "waiting_msg",
                "choices": [
                    {
                        "index": 0,
                        "delta": {
                            "role": "assistant",
                            "content": random.choice(waiting_messages),
                        },
                        "finish_reason": None,
                    }
                ],
            }
            yield f"data: {json.dumps(waiting_message)}\n\n"

            # Build messages with conversation history
            messages = build_messages_with_history(
                app_id, user_id, channel, request.messages
            )

            # Perform RAG retrieval
            retrieved_context = perform_rag_retrieval(messages)

            # Adjust messages with retrieved context
            refacted_messages = refact_messages(retrieved_context, messages)

            # Request LLM completion
            client = AsyncOpenAI(api_key=LLM_API_KEY, base_url=LLM_BASE_URL)
            response = await client.chat.completions.create(
                model=model,
                messages=refacted_messages,
                tool_choice=(
                    request.tool_choice
                    if request.tools and request.tool_choice
                    else None
                ),
                tools=(
                    [t.model_dump() for t in request.tools]
                    if request.tools
                    else None
                ),
                modalities=request.modalities,
                audio=request.audio,
                response_format=request.response_format,
                stream=True,
                stream_options=request.stream_options,
            )

            accumulated_content = ""
            try:
                async for chunk in response:
                    delta = chunk.choices[0].delta if chunk.choices else None
                    if delta and delta.content:
                        accumulated_content += delta.content
                    yield f"data: {json.dumps(chunk.model_dump())}\n\n"

                # Save assistant response
                if accumulated_content:
                    save_message(
                        app_id,
                        user_id,
                        channel,
                        {"role": "assistant", "content": accumulated_content},
                    )

                yield "data: [DONE]\n\n"
            except asyncio.CancelledError:
                logger.info("RAG stream was cancelled")
                raise

        return StreamingResponse(generate(), media_type="text/event-stream")

    except asyncio.CancelledError:
        logger.info("RAG request was cancelled")
        raise HTTPException(status_code=499, detail="Request was cancelled")
    except HTTPException:
        raise
    except Exception as e:
        traceback_str = "".join(traceback.format_tb(e.__traceback__))
        error_message = f"{str(e)}\n{traceback_str}"
        logger.error(error_message)
        raise HTTPException(status_code=500, detail=error_message)


async def read_text_file(file_path: str) -> str:
    async with aiofiles.open(file_path, "r") as file:
        content = await file.read()
    return content


async def read_pcm_file(
    file_path: str, sample_rate: int, duration_ms: int
) -> list:
    async with aiofiles.open(file_path, "rb") as file:
        content = await file.read()

    chunk_size = int(sample_rate * 2 * (duration_ms / 1000))
    return [content[i : i + chunk_size] for i in range(0, len(content), chunk_size)]


@app.post("/audio/chat/completions")
async def create_audio_chat_completion(request: ChatCompletionRequest):
    try:
        logger.info(f"Received audio request: {request.model_dump_json()}")

        if not request.stream:
            raise HTTPException(
                status_code=400, detail="chat completions require streaming"
            )

        text_file_path = "./file.txt"
        pcm_file_path = "./file.pcm"
        sample_rate = 16000
        duration_ms = 40

        text_content = await read_text_file(text_file_path)
        audio_chunks = await read_pcm_file(pcm_file_path, sample_rate, duration_ms)

        async def generate():
            try:
                audio_id = uuid.uuid4().hex
                text_message = {
                    "id": uuid.uuid4().hex,
                    "choices": [
                        {
                            "index": 0,
                            "delta": {
                                "audio": {
                                    "id": audio_id,
                                    "transcript": text_content,
                                },
                            },
                            "finish_reason": None,
                        }
                    ],
                }
                yield f"data: {json.dumps(text_message)}\n\n"

                for chunk in audio_chunks:
                    audio_message = {
                        "id": uuid.uuid4().hex,
                        "choices": [
                            {
                                "index": 0,
                                "delta": {
                                    "audio": {
                                        "id": audio_id,
                                        "data": base64.b64encode(chunk).decode(
                                            "utf-8"
                                        ),
                                    },
                                },
                                "finish_reason": None,
                            }
                        ],
                    }
                    yield f"data: {json.dumps(audio_message)}\n\n"

                yield "data: [DONE]\n\n"

            except asyncio.CancelledError:
                logger.info("Audio stream was cancelled")
                raise

        return StreamingResponse(generate(), media_type="text/event-stream")

    except asyncio.CancelledError:
        logger.info("Audio request was cancelled")
        raise HTTPException(status_code=499, detail="Request was cancelled")
    except HTTPException:
        raise
    except Exception as e:
        traceback_str = "".join(traceback.format_tb(e.__traceback__))
        error_message = f"{str(e)}\n{traceback_str}"
        logger.error(error_message)
        raise HTTPException(status_code=500, detail=error_message)


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8100)
