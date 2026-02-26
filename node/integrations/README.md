# Integrations

Optional modules that plug into `custom_llm.js` via the module system. Each module implements lifecycle hooks that the server calls at key points during request processing.

## Thymia — Voice Biomarker Analysis

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

### Configuration

```bash
export THYMIA_ENABLED=true
export THYMIA_API_KEY=your_sentinel_api_key
```

| Variable | Description | Default |
|----------|-------------|---------|
| `THYMIA_ENABLED` | Enable Thymia voice biomarker module | `false` |
| `THYMIA_API_KEY` | Thymia Sentinel API key | _(required when enabled)_ |
| `THYMIA_WS_URL` | Sentinel WebSocket endpoint | `wss://ws.thymia.ai` |

The Go audio subscriber binary must be built first:

```bash
cd ../../go-audio-subscriber && make build
```

### Files

```
node/
  thymia_client.js        # Thymia Sentinel WebSocket client
  thymia_store.js         # In-memory biomarker results store
  audio_subscriber.js     # RTC audio capture wrapper (Go child process)
  integrations/
    thymia.js             # Module plugin (hooks into custom_llm.js)
```

### Module Hooks

The Thymia module implements the standard module interface consumed by `custom_llm.js`:

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

### Tool — `get_biomarkers_json`

The Thymia module registers a tool that the LLM can call to retrieve the current biomarker data as JSON:

```json
{
  "biomarkers": {"happy": 0.12, "sad": 0.03, "neutral": 0.85, "...": "..."},
  "wellness": {"stress": 0.15, "burnout": 0.08, "...": "..."},
  "clinical": {"depression_probability": 0.05, "...": "..."},
  "safety": {"level": 0, "alert": "none", "concerns": []}
}
```

### RTM Message Format

Biomarker results are pushed to the client via RTM as JSON strings with an `object` field for filtering:

```json
{"object": "thymia.biomarkers", "biomarkers": {"...": "..."}, "wellness": {"...": "..."}, "clinical": {"...": "..."}, "safety": {"...": "..."}}
{"object": "thymia.progress", "progress": {"helios": {"speech_seconds": 12.5, "trigger_seconds": 30, "processing": true}}}
```

The client uses `useRTMSubscription` from `@agora/agent-ui-kit` to filter messages by `object` type.

### Sentinel WebSocket Protocol

The `thymia_client.js` implements the Thymia Sentinel protocol:

1. **Connect** to `wss://ws.thymia.ai` with API key in headers
2. **Send config** — session settings (user label, biomarker policies, sample rate)
3. **Stream audio** — binary frames of 16kHz mono 16-bit PCM
4. **Send transcripts** — JSON messages with agent responses for context
5. **Receive PolicyResult** — JSON messages with biomarker scores, safety assessments

See [docs/ai/L1_operator_pack/deep_dives/thymia_sentinel.md](../../docs/ai/L1_operator_pack/deep_dives/thymia_sentinel.md) for the full protocol reference.

### Biomarker Categories

| Category | Source | Examples |
|----------|--------|----------|
| **Emotions** | Real-time affect | happy, sad, angry, fearful, neutral, surprised, disgusted |
| **Wellness (Helios)** | Accumulated voice patterns | stress, burnout, fatigue, distress, low_self_esteem |
| **Clinical (Apollo)** | Accumulated voice patterns | depression, anxiety, PTSD indicators |
| **Safety** | Rule-based assessment | level (0-3), alert (none/monitor/professional_referral/crisis), concerns, recommended actions |

Wellness and clinical scores require a minimum amount of speech (configurable `trigger_seconds`) before results are produced. Progress updates are sent via RTM so the client can show collection status.

### Agent Lifecycle

The simple-backend calls `/register-agent` and `/unregister-agent` to manage the Thymia session:

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
