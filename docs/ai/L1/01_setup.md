# 01 Setup

> Environment setup, build steps, and quick commands for local development.

## Prerequisites

- Node.js >= 18.0.0
- Go >= 1.21 (for building the audio subscriber)
- Agora Go Server SDK native libraries (symlinked from `palabra/server/`)

## Quick Commands

| Command | What it does |
|---------|-------------|
| `cd server-custom-llm/node && npm install` | Install Node.js dependencies |
| `cd server-custom-llm/go-audio-subscriber && make build` | Build Go binary for current platform |
| `cd server-custom-llm/node && npm start` | Start the server on port 8101 |
| `cd server-custom-llm/node && npm run dev` | Start with nodemon (auto-reload) |
| `curl localhost:8101/ping` | Health check |

## Build the Go Audio Subscriber

```bash
cd server-custom-llm/go-audio-subscriber
make build-darwin   # macOS (arm64)
make build-linux    # Linux (amd64)
```

The binary is output to `go-audio-subscriber/bin/audio_subscriber`.

## Environment Variables

For local `npm start`, the process loads `server-custom-llm/node/.env`.
For the live PM2 process, that same `node/.env` file is the restart source of truth because `custom_llm.js` loads dotenv from the `node/` working directory.

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `LLM_API_KEY` | Yes | - | OpenAI API key (or compatible) |
| `LLM_BASE_URL` | No | `https://api.openai.com/v1` | LLM API base URL |
| `LLM_MODEL` | No | `gpt-4o-mini` | Model to use |
| `LLM_REASONING_EFFORT` | No | unset | Default reasoning effort for GPT-5 reasoning models |
| `PORT` | No | `8101` | Server port |
| `THYMIA_ENABLED` | No | `false` | Enable Thymia voice biomarkers |
| `THYMIA_API_KEY` | If Thymia | - | Thymia Sentinel API key |
| `THYMIA_WS_URL` | No | `wss://ws.thymia.ai` | Thymia WebSocket URL |
| `THYMIA_BIOMARKERS` | No | `helios,apollo` | Biomarker models to use |
| `THYMIA_POLICIES` | No | `passthrough,safety_analysis` | Sentinel policies |
| `THYMIA_CUSTOM_POLICY_PROMPT_PATH` | No | - | Optional custom Sentinel policy prompt file |
| `THYMIA_CUSTOM_POLICY_NAME` | No | `mindfix_safety_v1` | Custom policy name |
| `THYMIA_CUSTOM_POLICY_TRIGGER_TURNS` | No | `1` | Turn cadence for the custom policy |
| `THYMIA_REPLACE_DEFAULT_POLICY` | No | `false` | If `true`, removes default Agora safety when the custom prompt loads |
| `ENABLE_MEMORY` | No | `false` | Enable encrypted AI-session continuity memory |
| `ENCRYPTION_KEY` | If memory | - | 64-hex key for local encrypted session summaries |
| `DATA_DIR` | No | `./data` | Local memory persistence directory |
| `MAX_HISTORY_SESSIONS` | No | `5` | Number of prior AI sessions loaded into context |
| `CRISIS_CALL_ENABLED` | No | `false` | Enable AI-human PSTN crisis escalation |
| `CRISIS_TRIGGER_LEVEL` | No | `3` | Safety level that triggers escalation |
| `AGORA_SIPCM_AUTH` | If PSTN | - | SIP-CM basic auth token |
| `AUDIO_SUBSCRIBER_PATH` | No | `../go-audio-subscriber/bin/audio_subscriber` | Path to Go binary |
| `AUDIO_SUBSCRIBER_BOT_UID` | No | `5000` | Agora UID for audio subscriber |
| `AUDIO_TARGET_UID` | No | `101` | Default user UID to subscribe to |
| `AGORA_APP_ID` | If RTM/Thymia/PSTN | - | Agora App ID |
| `AGENT_SERVER_SHARED_SECRET` | If protected | - | Shared secret for agent registration endpoints |

## Common Setup Failures

- **Go binary fails to build**: Ensure the `vendor_sdk` symlink resolves correctly
- **DYLD_LIBRARY_PATH not set**: On macOS, the Go binary needs `DYLD_LIBRARY_PATH` pointing to the SDK `.dylib` files
- **`ws` module not found**: Run `npm install` in the `node/` directory after adding Thymia
- **Memory says disabled**: `ENABLE_MEMORY=true` is not enough; `ENCRYPTION_KEY` must also be set
- **Only `mindfix_crisis` loads after restart**: the service-local `node/.env` is incomplete; keep Thymia/Shen/memory flags there too
- **Custom policy env is set but nothing changes**: verify the prompt path exists and is readable by the Node process
- **PSTN dial fails immediately**: verify `AGORA_SIPCM_AUTH`, `AGORA_APP_ID`, and the RTC token all belong to the same Agora app

## Live Service Usage

Current PM2 service:

- `pm2 restart server-custom-llm --update-env`
- `pm2 logs server-custom-llm --lines 200`

Expected startup signals for the recent MindFix-specific work:

- `Thymia module initialized`
- `Memory module initialized`
- `MindFix crisis module initialized enabled=true`

## Related Deep Dives

- [L2/go_audio_ipc.md](L2/go_audio_ipc.md)
- [L2/mindfix_crisis_escalation.md](L2/mindfix_crisis_escalation.md)
