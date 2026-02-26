# Custom LLM Server — Node.js

Node.js implementation using Express. Default port: **8101**.

This is the only implementation with RTM text messaging and Thymia voice biomarker support.

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

| Variable | Description | Default |
|----------|-------------|---------|
| `LLM_API_KEY` | API key for LLM provider | _(required)_ |
| `LLM_BASE_URL` | LLM API base URL | `https://api.openai.com/v1` |
| `LLM_MODEL` | Default model name | `gpt-4o-mini` |

Legacy env vars `YOUR_LLM_API_KEY` and `OPENAI_API_KEY` are also accepted.

**RTM (optional):**

| Variable | Description |
|----------|-------------|
| `AGORA_APP_ID` | Agora App ID |
| `AGORA_RTM_TOKEN` | RTM token (optional for testing) |
| `AGORA_RTM_USER_ID` | Agent's RTM user ID |
| `AGORA_RTM_CHANNEL` | RTM channel to subscribe to |

RTM can also initialize dynamically from request parameters — see [RTM Integration](#rtm-integration).

**Thymia (optional):**

| Variable | Description | Default |
|----------|-------------|---------|
| `THYMIA_ENABLED` | Enable Thymia voice biomarker module | `false` |
| `THYMIA_API_KEY` | Thymia Sentinel API key | _(required when enabled)_ |
| `THYMIA_WS_URL` | Sentinel WebSocket endpoint | `wss://ws.thymia.ai` |

See [Thymia Integration](#thymia-integration) for details.

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
  rtm_client.js           # RTM integration (optional, requires rtm-nodejs)
  audio_subscriber.js     # RTC audio capture wrapper (Go child process)
  thymia_client.js        # Thymia Sentinel WebSocket client
  thymia_store.js         # In-memory biomarker results store
  integrations/
    thymia.js             # Thymia module plugin (hooks into custom_llm.js)
  package.json
```

## Endpoints

See the [top-level README](../README.md#endpoints) for endpoint details. All three language implementations share the same core endpoints.

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/chat/completions` | Streaming LLM with tool execution |
| `POST` | `/rag/chat/completions` | RAG-enhanced with context injection |
| `POST` | `/audio/chat/completions` | Multimodal audio responses |
| `POST` | `/register-agent` | Register agent for a channel (Thymia lifecycle) |
| `POST` | `/unregister-agent` | Unregister agent and clean up resources |
| `GET` | `/ping` | Health check — returns `{"message": "pong"}` |
| `GET` | `/` | Lists available endpoints |

### Agent Registration

When using Thymia, the simple-backend calls these endpoints to manage agent lifecycle:

**Register** — called after the Agora agent joins a channel:

```bash
curl -X POST http://localhost:8101/register-agent \
  -H "Content-Type: application/json" \
  -d '{
    "app_id": "your_app_id",
    "channel": "channel_name",
    "agent_id": "agent_123",
    "auth_header": "Basic ...",
    "agent_endpoint": "https://api.agora.io/...",
    "prompt": "You are a wellness therapist..."
  }'
```

**Unregister** — called on hangup to clean up audio subscriber, Thymia session, and store:

```bash
curl -X POST http://localhost:8101/unregister-agent \
  -H "Content-Type: application/json" \
  -d '{"app_id": "your_app_id", "channel": "channel_name"}'
```

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

## Thymia Integration

Thymia provides real-time voice biomarker analysis — detecting emotions, wellness indicators (stress, burnout, fatigue), and clinical markers from the user's voice during a conversation.

### How It Works

```
┌─────────────┐    PCM audio     ┌──────────────┐   WebSocket    ┌─────────────┐
│ Agora RTC   │ ───────────────→ │ Custom LLM   │ ─────────────→ │ Thymia      │
│ Channel     │                  │ Server       │                │ Sentinel    │
└─────────────┘                  │              │ ←───────────── │ API         │
                                 │  ┌────────┐  │  PolicyResult  └─────────────┘
                                 │  │ Store  │  │
                                 │  └────────┘  │
                                 │       │      │
                                 │  RTM push +  │
                                 │  System msg  │
                                 └──────┬───────┘
                                        │
                            ┌───────────┴───────────┐
                            │                       │
                      ┌─────▼─────┐          ┌──────▼──────┐
                      │ RTM →     │          │ LLM gets    │
                      │ Client UI │          │ biomarkers  │
                      │ ThymiaPanel│         │ in system   │
                      └───────────┘          │ message     │
                                             └─────────────┘
```

1. **Audio capture** — A Go child process (`go-audio-subscriber`) joins the Agora RTC channel and streams the user's PCM audio to the Node server via stdin
2. **Sentinel connection** — The server opens a WebSocket to `wss://ws.thymia.ai` and forwards audio frames + agent transcripts
3. **PolicyResult** — Thymia returns biomarker scores (emotions, wellness, clinical) as results become available
4. **Storage** — Results are stored in-memory per channel (`thymia_store.js`)
5. **RTM push** — Biomarker results are pushed to the client via RTM as `thymia.biomarkers` and `thymia.progress` messages
6. **System injection** — On each LLM request, current biomarker scores are injected as a system message so the LLM can reference them in responses

### Enabling Thymia

```bash
export THYMIA_ENABLED=true
export THYMIA_API_KEY=your_sentinel_api_key
```

The Go audio subscriber binary must be built first:

```bash
cd ../go-audio-subscriber && make build
```

### Thymia API

The Thymia module hooks into the custom LLM server's module system. It exposes:

**Module hooks** (called by `custom_llm.js`):

| Hook | When | What it does |
|------|------|-------------|
| `onAgentRegistered` | `/register-agent` called | Connects to Thymia Sentinel WebSocket |
| `onRequest` | Each `/chat/completions` call | Starts audio subscriber if not running |
| `onResponse` | After LLM response generated | Sends agent transcript to Thymia |
| `onAgentUnregistered` | `/unregister-agent` called | Disconnects Thymia, stops audio, cleans up |
| `getSystemInjection` | Before LLM call | Returns biomarker summary as system message |
| `getToolDefinitions` | Tool list assembly | Adds `get_biomarkers_json` tool |
| `getToolHandlers` | Tool dispatch | Handles `get_biomarkers_json` execution |
| `shutdown` | Server exit | Cleans up all sessions |

**Tool — `get_biomarkers_json`:**

The Thymia module registers a tool that the LLM can call to retrieve the current biomarker data as JSON:

```json
{
  "biomarkers": {"happy": 0.12, "sad": 0.03, "neutral": 0.85, ...},
  "wellness": {"stress": 0.15, "burnout": 0.08, ...},
  "clinical": {"depression_probability": 0.05, ...},
  "safety": {"level": 0, "alert": "none", "concerns": []}
}
```

### Sentinel WebSocket Protocol

The `thymia_client.js` implements the Thymia Sentinel protocol:

1. **Connect** to `wss://ws.thymia.ai` with API key in headers
2. **Send config** — session settings (user label, biomarker policies, sample rate)
3. **Stream audio** — binary frames of 16kHz mono 16-bit PCM
4. **Send transcripts** — JSON messages with agent responses for context
5. **Receive PolicyResult** — JSON messages with biomarker scores, safety assessments

See [docs/ai/L1_operator_pack/deep_dives/thymia_sentinel.md](../docs/ai/L1_operator_pack/deep_dives/thymia_sentinel.md) for the full protocol reference.

### Biomarker Categories

| Category | Source | Examples |
|----------|--------|----------|
| **Emotions** | Real-time affect | happy, sad, angry, fearful, neutral, surprised, disgusted |
| **Wellness (Helios)** | Accumulated voice patterns | stress, burnout, fatigue, distress, low_self_esteem |
| **Clinical (Apollo)** | Accumulated voice patterns | depression, anxiety, PTSD indicators |
| **Safety** | Rule-based assessment | level (0-3), alert (none/monitor/professional_referral/crisis), concerns, recommended actions |

Wellness and clinical scores require a minimum amount of speech (configurable `trigger_seconds`) before results are produced. Progress updates are sent via RTM so the client can show collection status.

## Expose to the Internet

```bash
cloudflared tunnel --url http://localhost:8101
```

## License

This project is licensed under the MIT License.
