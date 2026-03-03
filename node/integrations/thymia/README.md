# Thymia — Voice Biomarker Analysis

Real-time voice biomarker analysis using [Thymia](https://thymia.ai/) Sentinel. Detects emotions, wellness indicators (stress, burnout, fatigue), and clinical markers from the user's voice during a conversation.

This is an optional module that plugs into `custom_llm.js` via the module system. Node.js only.

## How It Works

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
                                 │  Agent Update│
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

1. **Audio capture** — A Go child process ([go-audio-subscriber](../../../go-audio-subscriber/)) joins the Agora RTC channel and streams the user's PCM audio to the Node server via stdin
2. **Sentinel connection** — The server opens a WebSocket to `wss://ws.thymia.ai` and forwards audio frames + agent transcripts
3. **PolicyResult** — Thymia returns biomarker scores (emotions, wellness, clinical) as results become available
4. **Storage** — Results are stored in-memory per channel (`thymia_store.js`)
5. **RTM push** — Biomarker results are pushed to the client via RTM as `thymia.biomarkers` and `thymia.progress` messages
6. **Agent Update** — Current biomarker scores are pushed to the Agora ConvoAI Engine via the Agent Update API so the LLM can reference them in responses

## Setup

### 1. Build the Audio Subscriber

The Go audio subscriber binary must be built first. See [go-audio-subscriber/README.md](../../../go-audio-subscriber/README.md) for details.

```bash
cd go-audio-subscriber && make build
```

### 2. Configure Environment Variables

```bash
export THYMIA_ENABLED=true
export THYMIA_API_KEY=your_sentinel_api_key
```

| Variable            | Description                          | Default                       |
| ------------------- | ------------------------------------ | ----------------------------- |
| `THYMIA_ENABLED`    | Enable Thymia voice biomarker module | `false`                       |
| `THYMIA_API_KEY`    | Thymia Sentinel API key              | _(required when enabled)_     |
| `THYMIA_WS_URL`     | Sentinel WebSocket endpoint          | `wss://ws.thymia.ai`          |
| `THYMIA_BIOMARKERS` | Comma-separated biomarker suites     | `helios,apollo`               |
| `THYMIA_POLICIES`   | Comma-separated policy names         | `passthrough,safety_analysis` |

### 3. Start the Server

```bash
cd node
npm start
```

When `THYMIA_ENABLED=true`, the module auto-initializes on startup and begins capturing audio on the first `/chat/completions` request.

## Module Hooks

The Thymia module implements the standard module interface consumed by `custom_llm.js`:

| Hook                  | When                          | What it does                                                       |
| --------------------- | ----------------------------- | ------------------------------------------------------------------ |
| `init`                | Server startup                | Registers audio event listener                                     |
| `onAgentRegistered`   | `/register-agent` called      | Stores agent ID for Agent Update API                               |
| `onRequest`           | Each `/chat/completions` call | Starts audio subscriber + Thymia session, forwards user transcript |
| `onResponse`          | After LLM response generated  | Sends agent transcript to Thymia                                   |
| `onAgentUnregistered` | `/unregister-agent` called    | Disconnects Thymia, stops audio, cleans up                         |
| `getToolDefinitions`  | Tool list assembly            | Adds `get_wellness_metrics` and `start_thymia_session` tools       |
| `getToolHandlers`     | Tool dispatch                 | Handles tool execution                                             |
| `shutdown`            | Server exit                   | Cleans up all sessions                                             |

## Tools

The module registers two tools that the LLM can call:

### `get_wellness_metrics`

Returns the current biomarker data for this session:

```json
{
  "status": "ok",
  "session_active": true,
  "results_count": 5,
  "wellness": { "stress": 0.15, "burnout": 0.08, "fatigue": 0.12 },
  "clinical": { "depression_probability": 0.05, "anxiety_probability": 0.03 },
  "safety": { "level": 0, "alert": "none", "concerns": [] }
}
```

### `start_thymia_session`

Starts a voice biomarker analysis session with user demographics for calibration:

```json
{
  "name": "John",
  "year_of_birth": 1990,
  "sex": "male",
  "locale": "en"
}
```

## Biomarker Categories

| Category              | Source                     | Examples                                                                                      |
| --------------------- | -------------------------- | --------------------------------------------------------------------------------------------- |
| **Emotions**          | Real-time affect           | happy, sad, angry, fearful, neutral, surprised, disgusted                                     |
| **Wellness (Helios)** | Accumulated voice patterns | stress, burnout, fatigue, distress, low_self_esteem                                           |
| **Clinical (Apollo)** | Accumulated voice patterns | depression, anxiety, PTSD indicators                                                          |
| **Safety**            | Rule-based assessment      | level (0-3), alert (none/monitor/professional_referral/crisis), concerns, recommended actions |

Wellness and clinical scores require a minimum amount of speech (configurable `trigger_seconds`) before results are produced. Progress updates are sent via RTM so the client can show collection status.

## RTM Message Format

Biomarker results are pushed to the client via RTM as JSON strings with an `object` field for filtering:

```json
{"object": "thymia.biomarkers", "biomarkers": {"...": "..."}, "wellness": {"...": "..."}, "clinical": {"...": "..."}, "safety": {"...": "..."}}
{"object": "thymia.progress", "progress": {"helios": {"speech_seconds": 12.5, "trigger_seconds": 30, "processing": true}}}
```

The client uses `useRTMSubscription` from `@agora/agent-ui-kit` to filter messages by `object` type.

## Agent Lifecycle

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

## Sentinel WebSocket Protocol

The `thymia_client.js` implements the Thymia Sentinel protocol:

1. **Connect** to `wss://ws.thymia.ai` with API key in headers
2. **Send config** — session settings (user label, biomarker policies, sample rate)
3. **Stream audio** — binary frames of 16kHz mono 16-bit PCM
4. **Send transcripts** — JSON messages with agent responses for context
5. **Receive PolicyResult** — JSON messages with biomarker scores, safety assessments

## Files

```
integrations/thymia/
  thymia.js             # Module plugin (hooks into custom_llm.js)
  thymia_client.js      # Thymia Sentinel WebSocket client
  thymia_store.js       # In-memory biomarker results store
  README.md             # This file
```
