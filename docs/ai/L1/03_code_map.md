# 03 Code Map

> Directory tree, module responsibilities, and core file reference.

## Directory Tree

```
server-custom-llm/
├── AGENTS.md                    # AI agent entry point
├── CLAUDE.md                    # Points to docs/ai/
├── README.md                    # Human-facing docs
├── node/                        # Node.js Express server
│   ├── custom_llm.js            # Main server: endpoints, tool execution, integration
│   ├── tools.js                 # Tool definitions (weather, calculate, Thymia)
│   ├── conversation_store.js    # Per-channel message history
│   ├── memory_store.js          # Encrypted session memory with biomarker averages
│   ├── audio_manager.js         # Go child process lifecycle + PCM routing
│   ├── thymia_client.js         # Thymia Sentinel WebSocket client
│   ├── thymia_store.js          # In-memory biomarker results store
│   ├── rtm_client.js            # Agora RTM integration (optional)
│   └── package.json             # Dependencies
├── go-audio-subscriber/         # Go audio capture binary
│   ├── main.go                  # Entry point: stdin commands, stdout frames
│   ├── subscriber.go            # Agora SDK init, channel join, audio callback
│   ├── protocol.go              # Binary framing protocol for stdout
│   ├── go.mod                   # Module with vendored Agora SDK
│   ├── Makefile                 # Build targets for darwin/linux
│   ├── agora_sdk -> symlink     # Native SDK libraries
│   └── vendor_sdk -> symlink    # Vendored Go SDK
├── go/                          # Go (Gin) implementation (alternative)
├── python/                      # Python (FastAPI) implementation (alternative)
├── test/                        # Test scripts
└── docs/ai/                     # Progressive disclosure docs
```

## Module Responsibilities

| Module | Responsibility |
|--------|---------------|
| `custom_llm.js` | HTTP endpoints, request routing, streaming SSE, tool execution loop |
| `tools.js` | Tool schemas + handler functions, RAG data, Thymia tool defs |
| `conversation_store.js` | Persist messages per `appId:userId:channel`, auto-trim at 100 |
| `memory_store.js` | Encrypted session history: load/save summaries + biomarker averages per user |
| `audio_manager.js` | Spawn/manage Go children, parse binary frames, buffer PCM, route to Thymia |
| `thymia_client.js` | WebSocket connection to Thymia, send audio/transcripts, receive PolicyResults |
| `thymia_store.js` | Store biomarker results per `appId:channel`, cleanup stale entries |
| `rtm_client.js` | Optional RTM subscription, message forwarding to LLM |
| `main.go` | Go entry point: read JSON commands from stdin, manage subscriber lifecycle |
| `subscriber.go` | Agora SDK connection, audio frame callback, pipe PCM to stdout |
| `protocol.go` | Binary frame writer: `[type][length][payload]` |

## Core Files (start here)

1. `node/custom_llm.js` — The main server, read this first
2. `node/tools.js` — Tool system pattern, add new tools here
3. `node/audio_manager.js` — Audio pipeline orchestration

## Related Deep Dives

- None
