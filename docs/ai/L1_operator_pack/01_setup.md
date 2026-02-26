# 01 Setup

> Environment setup, build steps, and quick commands for local development.

## Prerequisites

- Node.js >= 18.0.0
- Go >= 1.21 (for building the audio subscriber)
- Agora Go Server SDK native libraries (symlinked from `palabra/server/`)

## Quick Commands

| Command | What it does |
|---------|-------------|
| `cd node && npm install` | Install Node.js dependencies |
| `cd go-audio-subscriber && make build` | Build Go binary for current platform |
| `cd node && npm start` | Start the server on port 8101 |
| `cd node && npm run dev` | Start with nodemon (auto-reload) |
| `curl localhost:8101/ping` | Health check |

## Build the Go Audio Subscriber

```bash
cd go-audio-subscriber
make build-darwin   # macOS (arm64)
make build-linux    # Linux (amd64)
```

The binary is output to `go-audio-subscriber/bin/audio_subscriber`.

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `LLM_API_KEY` | Yes | - | OpenAI API key (or compatible) |
| `LLM_BASE_URL` | No | `https://api.openai.com/v1` | LLM API base URL |
| `LLM_MODEL` | No | `gpt-4o-mini` | Model to use |
| `PORT` | No | `8101` | Server port |
| `THYMIA_ENABLED` | No | `false` | Enable Thymia voice biomarkers |
| `THYMIA_API_KEY` | If Thymia | - | Thymia Sentinel API key |
| `THYMIA_WS_URL` | No | `wss://ws.thymia.ai` | Thymia WebSocket URL |
| `THYMIA_BIOMARKERS` | No | `helios,apollo` | Biomarker models to use |
| `THYMIA_POLICIES` | No | `passthrough,safety_analysis` | Sentinel policies |
| `AUDIO_SUBSCRIBER_PATH` | No | `../go-audio-subscriber/bin/audio_subscriber` | Path to Go binary |
| `AUDIO_SUBSCRIBER_BOT_UID` | No | `5000` | Agora UID for audio subscriber |
| `AUDIO_TARGET_UID` | No | `101` | Default user UID to subscribe to |
| `AGORA_APP_ID` | If RTM/Thymia | - | Agora App ID |

## Common Setup Failures

- **Go binary fails to build**: Ensure the `vendor_sdk` symlink resolves correctly
- **DYLD_LIBRARY_PATH not set**: On macOS, the Go binary needs `DYLD_LIBRARY_PATH` pointing to the SDK `.dylib` files
- **`ws` module not found**: Run `npm install` in the `node/` directory after adding Thymia

## Related Deep Dives

- None
