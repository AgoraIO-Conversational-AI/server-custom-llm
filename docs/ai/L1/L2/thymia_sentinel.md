# Thymia Sentinel WebSocket Protocol

> **When to read this:** You are modifying `thymia_client.js`, debugging biomarker analysis,
> or integrating a new Thymia feature.

## Overview

Thymia Sentinel is a real-time voice biomarker analysis service. The client connects via
WebSocket, sends a configuration message, then streams audio and transcripts. The server
responds with PolicyResult messages containing biomarker scores.

## Connection Flow

```
Client                              Server (wss://ws.thymia.ai)
  │                                      │
  │──── WebSocket CONNECT ──────────────►│
  │                                      │
  │──── SentinelConfig (JSON) ─────────►│
  │                                      │
  │◄─── STATUS (JSON) ──────────────────│
  │                                      │
  │──── AudioHeader (JSON) ────────────►│
  │──── PCM bytes (binary) ────────────►│
  │──── AudioHeader (JSON) ────────────►│
  │──── PCM bytes (binary) ────────────►│
  │     ... repeat ...                   │
  │                                      │
  │──── Transcript (JSON) ─────────────►│  (optional, improves accuracy)
  │                                      │
  │◄─── POLICY_RESULT (JSON) ──────────│  (after ~30s of speech)
  │◄─── POLICY_RESULT (JSON) ──────────│  (periodic updates)
  │                                      │
  │──── close ──────────────────────────►│
```

## SentinelConfig (Client → Server, first message)

```json
{
  "api_key": "sk-thymia-...",
  "user_label": "participant_001",
  "date_of_birth": "1990-01-01",
  "birth_sex": "male",
  "language": "en",
  "biomarkers": ["helios", "apollo"],
  "policies": ["passthrough", "safety_analysis"],
  "sample_rate": 16000,
  "format": "pcm16",
  "channels": 1
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `api_key` | string | Yes | Thymia API key |
| `user_label` | string | Yes | Unique label for the user in this session |
| `date_of_birth` | string | No | ISO date, enables age-adjusted scoring |
| `birth_sex` | string | No | `"male"` or `"female"`, improves voice calibration |
| `language` | string | No | BCP 47 code, default `"en"` |
| `biomarkers` | string[] | Yes | Models to run: `"helios"` (wellness), `"apollo"` (clinical) |
| `policies` | string[] | Yes | Analysis policies: `"passthrough"`, `"safety_analysis"` |
| `sample_rate` | int | Yes | Audio sample rate in Hz (16000 recommended) |
| `format` | string | Yes | `"pcm16"` (16-bit signed little-endian) |
| `channels` | int | Yes | Number of audio channels (1 = mono) |

## Audio Streaming (Client → Server)

Audio is sent as a pair of messages: a JSON header followed by raw binary PCM bytes.

### AudioHeader (JSON)

```json
{
  "track": "user",
  "bytes": 3200,
  "format": "pcm16",
  "sample_rate": 16000,
  "channels": 1
}
```

| Field | Type | Description |
|-------|------|-------------|
| `track` | string | `"user"` for user audio, `"agent"` for agent audio |
| `bytes` | int | Exact byte count of the following binary message |
| `format` | string | Must match SentinelConfig format |
| `sample_rate` | int | Must match SentinelConfig sample_rate |
| `channels` | int | Must match SentinelConfig channels |

### PCM Binary

Raw PCM bytes immediately following the header. Length must match `bytes` field.

- Format: 16-bit signed little-endian
- Recommended chunk size: 100ms of audio (3,200 bytes at 16kHz mono)
- Minimum: 10ms, Maximum: 1 second per chunk

## Transcript (Client → Server, optional)

```json
{
  "type": "transcript",
  "speaker": "user",
  "text": "I've been feeling really stressed lately",
  "is_final": true
}
```

Transcripts improve analysis accuracy by providing linguistic context alongside voice features.

## PolicyResult (Server → Client)

```json
{
  "type": "POLICY_RESULT",
  "policy": "passthrough",
  "biomarker_summary": {
    "distress": 0.65,
    "stress": 0.72,
    "burnout": 0.31,
    "fatigue": 0.45,
    "low_self_esteem": 0.12
  },
  "classification": null,
  "timestamp": "2026-02-25T10:30:00Z"
}
```

### Passthrough Policy

Returns raw biomarker scores from the requested models.

**Helios biomarkers** (wellness, 0.0-1.0 scale):
- `distress` — Overall emotional distress level
- `stress` — Acute stress indicator
- `burnout` — Chronic exhaustion / burnout
- `fatigue` — Physical/mental fatigue
- `low_self_esteem` — Self-esteem indicator

**Apollo biomarkers** (clinical):
- `depression_probability` — Probability of depression (0.0-1.0)
- `anxiety_probability` — Probability of anxiety (0.0-1.0)
- `severity` — Overall clinical severity (`"none"`, `"mild"`, `"moderate"`, `"severe"`)

### Safety Analysis Policy

Returns safety classification with actionable recommendations.

```json
{
  "type": "POLICY_RESULT",
  "policy": "safety_analysis",
  "classification": {
    "level": "elevated",
    "alert": true,
    "concerns": ["high stress indicators", "elevated distress"],
    "recommended_actions": ["suggest stress management techniques", "recommend professional support"]
  }
}
```

## Error Messages (Server → Client)

```json
{
  "type": "ERROR",
  "message": "Invalid API key",
  "code": "AUTH_FAILED"
}
```

## Implementation Notes

- First PolicyResult typically arrives after ~30 seconds of speech
- Results update approximately every 10-15 seconds of new speech
- Silence is ignored — the timer is based on speech duration, not wall clock
- WebSocket ping/pong is handled automatically by the `ws` library
- On disconnect, buffered audio is lost; the client should reconnect and continue streaming
