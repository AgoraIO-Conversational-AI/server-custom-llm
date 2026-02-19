# <img src="./assets/agora-logo.svg" alt="Agora" width="24" height="24" style="vertical-align: middle; margin-right: 8px;" /> Custom LLM Server

OpenAI-compatible LLM proxy for Agora Conversational AI with streaming, tools, and RAG.

- [Overview](#overview)
- [Quick Start](#quick-start)
- [Architecture](#architecture)
- [Endpoints](#endpoints)
- [Ports](#ports)
- [Expose Locally](#expose-locally)
- [Testing](#testing)
- [Integration](#integration)
- [Resources](#resources)
- [License](#license)

## Overview

The Custom LLM Server sits between the Agora Conversational AI Engine and your
LLM provider, giving you full control over the request/response pipeline. Use it
to inject RAG context, transform messages, add custom tools, or route to
different models.

All implementations provide the same three OpenAI-compatible streaming endpoints
so you can drop in any language and get the same behavior.

## Quick Start

| Language | Framework | Endpoints | Guide |
|----------|-----------|-----------|-------|
| Python | FastAPI + uvicorn | `/chat/completions`, `/rag/chat/completions`, `/audio/chat/completions` | [python/](./python/) |
| Node.js | Express | `/chat/completions`, `/rag/chat/completions`, `/audio/chat/completions` | [node/](./node/) |
| Go | Gin | `/chat/completions`, `/rag/chat/completions`, `/audio/chat/completions` | [go/](./go/) |

## Architecture

```mermaid
flowchart LR
    Engine[Agora ConvoAI Engine]-->|POST /chat/completions|Server

    subgraph Server[Custom LLM Server]
        Basic["chat/completions"]
        RAG["rag/chat/completions"]
        Audio["audio/chat/completions"]
    end

    Server-->|SSE Response|Engine

    Server-->|API call|LLM[LLM Provider]
    LLM-->|Stream Response|Server

    subgraph Knowledge
        KB[Knowledge Base]
    end

    RAG-.->|Retrieval|KB
```

The Custom LLM approach gives you a server you control that the Agora ConvoAI
Engine calls instead of calling the LLM provider directly. Your server can:

- Modify prompts and messages before forwarding to the LLM
- Inject RAG context from your own knowledge base
- Add or transform tool definitions
- Route to different models based on request context
- Return multimodal audio responses

## Endpoints

### `/chat/completions` — Basic LLM Proxy

Receives an OpenAI-compatible chat completion request, forwards it to the LLM
provider with streaming enabled, and relays the SSE chunks back to the caller.

This is the baseline endpoint — use it as-is or as a starting point for
customization.

### `/rag/chat/completions` — RAG-Enhanced

Same as the basic endpoint but with a retrieval step before the LLM call:

1. Sends a "thinking" message to keep the connection alive
2. Performs RAG retrieval against your knowledge base
3. Injects the retrieved context into the message list
4. Forwards the augmented messages to the LLM

Customize `perform_rag_retrieval()` and `refact_messages()` with your own
retrieval logic.

### `/audio/chat/completions` — Multimodal Audio

Returns audio responses with transcript. Reads a text file for the transcript
and a PCM file for the audio data, then streams them as SSE chunks. Use this as
a reference for implementing custom audio responses.

## Ports

Each language implementation uses a dedicated port so all servers can run and be
tested in parallel:

| Language | Default Port |
|----------|-------------|
| Python | 8100 |
| Node.js | 8101 |
| Go | 8102 |

## Expose Locally

When running locally, you need a tunnel to make the server reachable from Agora
ConvoAI (which runs in the cloud). Use [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/get-started/create-local-tunnel/)
to create a free tunnel — no account required:

```bash
# Install (macOS)
brew install cloudflare/cloudflare/cloudflared

# Start the tunnel pointing to your server port
cloudflared tunnel --url http://localhost:8100
```

This outputs a public URL like `https://random-words.trycloudflare.com`. Use
that URL when configuring the Agora ConvoAI agent:

```json
{
  "llm": {
    "url": "https://random-words.trycloudflare.com/chat/completions",
    "api_key": "your-llm-api-key",
    "model": "gpt-4o-mini"
  }
}
```

The tunnel stays open as long as the `cloudflared` process runs. Each restart
generates a new URL. You can run multiple tunnels for different language servers
by pointing each to its port.

## Testing

Each language has a self-test script in the `test/` folder that covers happy
paths and failure paths. Tests validate server structure and error handling
without requiring a real LLM API key.

### Run all tests

```bash
bash test/run_all.sh
```

This starts each server, runs its test suite, and reports results.

### Run a single language

```bash
bash test/run_all.sh python
bash test/run_all.sh node
bash test/run_all.sh go
```

### Run manually

```bash
cd python
YOUR_LLM_API_KEY=test-key python3 custom_llm.py &
bash ../test/test_python.sh
```

See [test/README.md](./test/README.md) for full test coverage details.

## Integration

To use a Custom LLM Server with Agora Conversational AI:

1. Start your server and expose it via a tunnel:

```bash
cd python
python3 custom_llm.py
cloudflared tunnel --url http://localhost:8100
```

2. Configure the Agora ConvoAI agent to use your custom LLM endpoint in the
   agent start API call:

```json
{
  "llm": {
    "url": "https://your-tunnel.trycloudflare.com/chat/completions",
    "api_key": "your-llm-api-key",
    "model": "gpt-4o-mini"
  }
}
```

## Resources

- [Agora Conversational AI Docs](https://docs.agora.io/en/conversational-ai/overview) — ConvoAI Engine documentation
- [Agora Console](https://console.agora.io/) — Get your App ID and credentials
- [OpenAI Chat Completions API](https://platform.openai.com/docs/api-reference/chat) — API reference for the compatible format

## License

This project is licensed under the MIT License. See [LICENSE](./LICENSE).
