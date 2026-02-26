# 02 Architecture

> System design: Node.js LLM proxy with Go audio child process and Thymia WebSocket integration.

## System Diagram

```
Agora ConvoAI Engine
        │
        ▼ POST /chat/completions (OpenAI-compatible)
┌───────────────────────────────────────────────────────────┐
│  Node.js Custom LLM Server (Express :8101)                │
│                                                           │
│  custom_llm.js ── tools.js ── conversation_store.js       │
│       │                                                   │
│       ├── audio_manager.js ── thymia_client.js            │
│       │        │                    │                     │
│       │        │ spawn              │ WebSocket           │
│       │        ▼                    ▼                     │
│       │   Go Audio Sub        wss://ws.thymia.ai          │
│       │   (child proc)         Sentinel API               │
│       │        │                    │                     │
│       │        │ stdout(PCM)        │ PolicyResult        │
│       │        ▼                    ▼                     │
│       │   PCM frames ──────► thymia_store.js              │
│       │                                                   │
│       └── rtm_client.js (optional)                        │
└───────────────────────────────────────────────────────────┘
```

## Data Flow

1. Agora ConvoAI sends `/chat/completions` requests with user speech transcripts
2. Node.js proxies to upstream LLM with server-side tool execution (up to 5 passes)
3. When `THYMIA_ENABLED=true`: audio_manager spawns a Go child process per channel
4. Go child joins the Agora RTC channel, subscribes to user audio, pipes raw PCM via stdout
5. Node.js routes PCM to ThymiaClient WebSocket for real-time voice biomarker analysis
6. Thymia returns PolicyResult with biomarker scores, stored in thymia_store
7. LLM can call `get_wellness_metrics` tool to access biomarker data

## Key Abstractions

- **Tool system**: OpenAI-compatible tool definitions + handler map, extensible
- **Conversation store**: In-memory per-channel message history with auto-trim
- **Audio session**: One Go child process + one Thymia WebSocket per channel
- **Frame protocol**: Binary IPC between Go and Node.js (type + length + payload)

## Tech Stack

| Component | Technology | Purpose |
|-----------|-----------|---------|
| HTTP server | Express 4 | OpenAI-compatible LLM proxy |
| LLM client | OpenAI Node SDK | Upstream model calls |
| Audio subscriber | Go + CGO | Agora RTC SDK audio capture |
| Voice biomarkers | WebSocket (`ws`) | Thymia Sentinel streaming |
| Messaging | RTM (optional) | Text channel integration |

## Related Deep Dives

- [go_audio_ipc](deep_dives/go_audio_ipc.md) — Go-Node.js IPC binary framing protocol
- [thymia_sentinel](deep_dives/thymia_sentinel.md) — Thymia Sentinel WebSocket protocol
