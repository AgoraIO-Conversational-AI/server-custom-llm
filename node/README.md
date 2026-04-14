# Custom LLM Server — Node.js

Node.js implementation using Express. Default port: **8101**.

This is the only implementation with RTM text messaging, audio subscriber (RTC audio capture), and Thymia voice biomarker support.

## Quick Start

### Environment Preparation

- Node.js 18+

### Install Dependencies

```bash
npm install
```

### Configuration

Set your LLM API key:

```bash
export LLM_API_KEY=sk-...
```

| Variable       | Description              | Default                     |
| -------------- | ------------------------ | --------------------------- |
| `LLM_API_KEY`  | API key for LLM provider | _(required)_                |
| `LLM_BASE_URL` | LLM API base URL         | `https://api.openai.com/v1` |
| `LLM_MODEL`    | Default model name       | `gpt-4o-mini`               |

Legacy env vars `YOUR_LLM_API_KEY` and `OPENAI_API_KEY` are also accepted.

**RTM (optional):**

| Variable            | Description                      |
| ------------------- | -------------------------------- |
| `AGORA_APP_ID`      | Agora App ID                     |
| `AGORA_RTM_TOKEN`   | RTM token (optional for testing) |
| `AGORA_RTM_USER_ID` | Agent's RTM user ID              |
| `AGORA_RTM_CHANNEL` | RTM channel to subscribe to      |

RTM can also initialize dynamically from request parameters — see [RTM Integration](#rtm-integration).

**Thymia (optional):**

| Variable         | Description                          | Default                   |
| ---------------- | ------------------------------------ | ------------------------- |
| `THYMIA_ENABLED` | Enable Thymia voice biomarker module | `false`                   |
| `THYMIA_API_KEY` | Thymia Sentinel API key              | _(required when enabled)_ |
| `THYMIA_WS_URL`  | Sentinel WebSocket endpoint          | `wss://ws.thymia.ai`      |

See [integrations/thymia/README.md](integrations/thymia/README.md) for full Thymia details.

**Shen (optional):**

| Variable       | Description                          | Default |
| -------------- | ------------------------------------ | ------- |
| `SHEN_ENABLED` | Enable Shen camera vitals module     | `false` |

Shen runs client-side (browser WASM SDK). The server receives vitals via RTM — no Shen API key needed server-side. See `recipes/shen.md` in agent-samples for full setup.

**Memory (optional):**

| Variable               | Description                              | Default  |
| ---------------------- | ---------------------------------------- | -------- |
| `ENCRYPTION_KEY`       | AES-256 master key (64 hex chars)        | _(none — memory disabled)_ |
| `DATA_DIR`             | Directory for encrypted session files    | `./data` |
| `MAX_HISTORY_SESSIONS` | Max previous sessions to load on connect | `5`      |

Requires auth on the backend (provides `user_id` via JWT). See [Session Memory](#session-memory) below.
When consultant-dashboard integration is enabled, call end produces both a private continuity-memory summary and a separate generalized consultant-facing summary payload.

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

## File Structure

```
node/
  custom_llm.js           # Main server: endpoints, streaming, tool execution, module system
  tools.js                # Tool definitions, RAG data, tool implementations
  conversation_store.js   # In-memory conversation store with trimming
  memory_store.js         # Encrypted session memory with private continuity summaries + biomarker averages
  rtm_client.js           # RTM integration (optional, requires rtm-nodejs)
  audio_subscriber.js     # RTC audio capture wrapper (Go child process)
  integrations/
    thymia/               # Thymia voice biomarker module
      thymia.js           # Module plugin (hooks into custom_llm.js)
      thymia_client.js    # Thymia Sentinel WebSocket client
      thymia_store.js     # In-memory biomarker results store
      README.md           # Setup and configuration guide
    shen/
      shen.js             # Module plugin (RTM listener + Agent Update API)
      shen_store.js       # In-memory camera vitals store
  data/                   # Encrypted session files (created at runtime, gitignored)
    users/{hash}/sessions/*.enc
  package.json
```

## Endpoints

See the [top-level README](../README.md#endpoints) for endpoint details. All three language implementations share the same core endpoints.

| Method | Path                      | Description                                     |
| ------ | ------------------------- | ----------------------------------------------- |
| `POST` | `/chat/completions`       | Streaming LLM with tool execution               |
| `POST` | `/rag/chat/completions`   | RAG-enhanced with context injection             |
| `POST` | `/audio/chat/completions` | Multimodal audio responses                      |
| `POST` | `/register-agent`         | Register agent for a channel (Thymia lifecycle) |
| `POST` | `/unregister-agent`       | Unregister agent and clean up resources         |
| `GET`  | `/ping`                   | Health check — returns `{"message": "pong"}`    |
| `GET`  | `/`                       | Lists available endpoints                       |

### Agent Registration

`/register-agent` and `/unregister-agent` manage agent lifecycle for integrations like Thymia. See [integrations/thymia/README.md](integrations/thymia/README.md) for request examples.

## Adding Custom Tools

Edit `tools.js`:

1. Add a schema to `TOOL_DEFINITIONS`:

```javascript
{
  type: 'function',
  function: {
    name: 'my_tool',
    description: 'What it does',
    parameters: {
      type: 'object',
      properties: { param1: { type: 'string' } },
      required: ['param1'],
    },
  },
}
```

2. Implement the handler:

```javascript
function myTool(appId, userId, channel, args) {
  return `Result for ${args.param1}`;
}
```

3. Register in `TOOL_MAP`:

```javascript
const TOOL_MAP = {
  my_tool: myTool,
};
```

## RTM Integration

The Node.js server uses Agora RTM for two purposes:

1. **Text messaging** — receive user text messages and send LLM responses back via RTM channel
2. **Biomarker push** — when Thymia is enabled, push real-time biomarker results to the client via RTM

### Static Configuration

Set the `AGORA_*` env vars for RTM to connect on startup:

```bash
export AGORA_APP_ID=your_app_id
export AGORA_RTM_USER_ID=agent_uid
export AGORA_RTM_CHANNEL=channel_name
```

### Dynamic Initialization

RTM can also initialize from request parameters on the first `/chat/completions` call. The Agora ConvoAI Engine passes these headers automatically:

- `X-Agora-Customllm-Appid` — App ID
- `X-Agora-Customllm-Channel` — Channel name
- `X-Agora-Customllm-Uid` — Agent's RTM user ID
- `X-Agora-Customllm-Rtmtoken` — RTM token
- `X-Agora-Customllm-Subscribertoken` — RTC subscriber token (for audio capture)

On the first request with these headers, the server initializes RTM and subscribes to the channel. Subsequent requests reuse the existing connection.

### RTM Message Format

Messages sent via RTM (both text responses and biomarker data) are JSON strings:

```json
{"object": "thymia.biomarkers", "biomarkers": {...}, "wellness": {...}, "clinical": {...}, "safety": {...}}
{"object": "thymia.progress", "progress": {"helios": {"speech_seconds": 12.5, "trigger_seconds": 30, "processing": true}}}
```

The client uses `useRTMSubscription` from `@agora/agent-ui-kit` to filter messages by `object` type.

Auto-reconnect with exponential backoff (2s–60s, up to 10 attempts).

Python and Go do not include RTM because the native Agora RTM SDKs require CGO/native library compilation.

## Audio Subscriber

Captures RTC audio from a specific user in the Agora channel via a Go child process. The `audio_subscriber.js` wrapper spawns the Go binary, manages its lifecycle, and emits PCM audio events for consumers like the Thymia integration.

Requires building the Go binary first:

```bash
cd ../go-audio-subscriber && make build
```

Full details: **[go-audio-subscriber/README.md](../go-audio-subscriber/README.md)**.

## Thymia Integration

Real-time voice biomarker analysis — emotions, wellness (stress, burnout, fatigue), and clinical markers from the user's voice. Captures RTC audio via the audio subscriber, streams it to Thymia Sentinel, and pushes results to both the LLM (system message injection) and the client UI (via RTM).

Enable with `THYMIA_ENABLED=true` and `THYMIA_API_KEY`. Full details: **[integrations/thymia/README.md](integrations/thymia/README.md)**.

## Session Memory

Encrypted per-user session history with biomarker averages. When enabled, the memory module:

1. **On connect** — loads previous session summaries from disk, decrypts them, and injects a dated history (with biomarker baselines) into the system prompt
2. **During session** — accumulates running averages of voice biomarkers (from Thymia) and camera vitals (from Shen) on each LLM request
3. **On disconnect** — generates a private continuity summary for future AI sessions, computes final biomarker averages, encrypts everything, and writes to disk

If consultant-dashboard integration is configured, the same disconnect path also produces a separate generalized consultant-facing summary payload with:

- `overview`
- `biomarker_summary`
- `risk_overview`
- `follow_up`

### Safety Rule

Memory is **only** active when both conditions are met:
1. `ENCRYPTION_KEY` is set in env
2. `user_id` from the backend JWT is not `"anonymous"`

If either is false, memory is completely skipped — sessions are ephemeral.

### How It Works

The backend auth system (Google + SMS 2FA) produces a `user_id_hash = sha256(google_sub + '|' + name + '|' + phone)`. This hash flows to the custom LLM via the `register-agent` call and is used as:
- The disk path for session files (`data/users/{hash}/sessions/`)
- The HKDF input for per-user encryption key derivation

### Disk Structure

```
data/users/{user_id_hash}/
  sessions/
    2026-03-25T11-30-00-000Z.enc   # encrypted session data
    2026-03-26T14-22-00-000Z.enc
```

### Session Data Format

Each `.enc` file contains AES-256-GCM encrypted JSON:

```json
{
  "summary": "User discussed work stress and poor sleep...",
  "biomarkers": {
    "voice": { "stress": { "avg": 0.45, "count": 12 }, "fatigue": { "avg": 0.52, "count": 12 } },
    "vitals": { "heart_rate_bpm": { "avg": 82, "count": 8 }, "hrv_sdnn_ms": { "avg": 38, "count": 8 } }
  },
  "savedAt": "2026-03-30T12:00:00.000Z"
}
```

- `voice` — averages from Thymia (emotions, wellness, clinical scores as 0-1 floats)
- `vitals` — averages from Shen (HR in bpm, HRV in ms, stress index, breathing rate, BP)
- `count` — number of samples accumulated (one per LLM request)
- Old sessions without biomarkers (pre-biomarker format) still load correctly

### Prompt Injection Format

On reconnect, previous sessions are injected into the system prompt:

```
## Previous Session History (2 sessions)

### 2026-03-25 11-30-00-000 UTC:
User discussed work stress and poor sleep. Mentioned difficulty concentrating.
Biomarkers: stress 45%, fatigue 52%, distress 30% | Heart Rate 82 bpm, Hrv Sdnn 38 ms

### 2026-03-26 14-22-00-000 UTC:
User tried breathing exercises, felt calmer. Sleep improving.
Biomarkers: stress 38%, fatigue 44% | Heart Rate 76 bpm, Hrv Sdnn 43 ms
```

The LLM can observe trends across sessions and reference them naturally.

### Summarization

On session end, conversation messages (including `[Voice Biomarker` and `[Camera Vitals` system messages) are sent to the LLM for summarization. The prompt asks the model to note key topics, emotional themes, breakthroughs, and significant biomarker patterns.

### Encryption

- Algorithm: AES-256-GCM
- Key derivation: HKDF-SHA256 from master key (`ENCRYPTION_KEY`) + user_id_hash + random salt
- Each file has its own random salt and nonce
- Format: `salt(16) + nonce(12) + tag(16) + ciphertext`

### Verify Memory Works

1. Complete a chat session and hang up
2. Check server logs for `"Saved session summary... with N voice samples, M vitals samples"`
3. Check `data/users/<hash>/sessions/` for `.enc` files
4. Reconnect — logs should show `"Loaded N session(s)"`
5. Agent should reference previous session context and biomarker baselines

## Running with PM2

For production, use [PM2](https://pm2.keymetrics.io/) for process management, auto-restart, and log rotation.

**Add to your `ecosystem.config.js`:**

```javascript
{
  name: "server-custom-llm",
  cwd: "/path/to/server-custom-llm/node",
  script: "custom_llm.js",
  env: {
    PORT: 8100,
    THYMIA_ENABLED: "true",
    THYMIA_API_KEY: "your_sentinel_api_key",
  },
  watch: false,
  max_memory_restart: "300M",
}
```

**Start and manage:**

```bash
pm2 start ecosystem.config.js --only server-custom-llm
pm2 save                  # Persist across reboots
pm2 restart server-custom-llm
pm2 stop server-custom-llm
```

### Log Locations

PM2 writes logs to `~/.pm2/logs/`:

| File | Content |
|------|---------|
| `server-custom-llm-out.log` | stdout — request logs, RTM status, Thymia progress, biomarker events |
| `server-custom-llm-error.log` | stderr — errors, RTM failures, stack traces |

**Tail logs:**

```bash
pm2 logs server-custom-llm           # Live tail (both stdout + stderr)
pm2 logs server-custom-llm --lines 50  # Last 50 lines
```

**Flush logs:**

```bash
pm2 flush server-custom-llm
```

## Expose to the Internet

```bash
cloudflared tunnel --url http://localhost:8101
```

Or place behind nginx with prefix stripping:

```nginx
location ^~ /custom-llm/ {
    proxy_pass http://localhost:8100/;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 300s;
}
```

## License

This project is licensed under the MIT License.
