# Custom LLM Server — Node.js

Node.js implementation using Express. Default port: **8101**.

## Quick Start

### Environment Preparation

- Node.js 18+

### Install Dependencies

```bash
npm install
```

### Configuration

Set your OpenAI API key:

```bash
export OPENAI_API_KEY=sk-...
```

### Run

```bash
npm start
```

For development with auto-restart:

```bash
npm run dev
```

The server starts on `http://localhost:8101`.

### Test

```bash
curl -X POST http://localhost:8101/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"messages": [{"role": "user", "content": "Hello, how are you?"}], "stream": true, "model": "gpt-4o-mini"}'
```

Run the automated tests:

```bash
bash ../test/test_node.sh
```

## Architecture

```mermaid
flowchart LR
    Client-->|POST Request|Server

    subgraph Server[Custom LLM Server]
        Basic["chat/completions"]
        RAG["rag/chat/completions"]
        Audio["audio/chat/completions"]
    end

    Server-->|SSE Response|Client

    Server-->|API call|OpenAI[OpenAI API]
    OpenAI-->|Stream Response|Server

    subgraph Knowledge
        KB[Knowledge Base]
    end

    RAG-.->|Retrieval|KB
```

## Endpoints

### `/chat/completions` — Basic LLM Proxy

Forwards chat completion requests to OpenAI with streaming and relays SSE chunks
back.

### `/rag/chat/completions` — RAG-Enhanced

1. Sends a "thinking" message
2. Calls `performRagRetrieval()` to get context
3. Calls `refactMessages()` to inject the context
4. Forwards augmented messages to OpenAI

Customize `performRagRetrieval()` and `refactMessages()` with your retrieval
logic.

### `/audio/chat/completions` — Multimodal Audio

Reads `file.txt` for transcript and `file.pcm` for audio data. Falls back to
simulated audio if files are not found.

## Expose to the Internet

```bash
cloudflared tunnel --url http://localhost:8101
```

## License

This project is licensed under the MIT License.
