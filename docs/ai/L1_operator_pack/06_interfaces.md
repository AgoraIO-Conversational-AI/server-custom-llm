# 06 Interfaces

> API contracts, IPC protocol, and external service schemas.

## HTTP API (OpenAI-Compatible)

### POST /chat/completions

Standard OpenAI chat completions with server-side tool execution.

**Extra field:** `context` object with `appId`, `userId`, `channel`.

```json
{
  "model": "gpt-4o-mini",
  "messages": [{"role": "user", "content": "Hello"}],
  "stream": true,
  "context": {
    "appId": "abc123",
    "userId": "user1",
    "channel": "room42"
  }
}
```

### POST /rag/chat/completions

Same as above with automatic RAG context injection.

### POST /audio/chat/completions

Streaming audio response (SSE with base64 PCM chunks).

### GET /ping

Returns `{ "message": "pong" }`.

## Go-Node.js IPC Protocol

### stdin (Node → Go): Newline-delimited JSON

```json
{"type":"start","appId":"...","channel":"...","botUid":"5000","token":"...","targetUid":"101"}
{"type":"stop"}
```

### stdout (Go → Node): Binary frames

```
[1-byte type][4-byte BE length][payload]
```

| Type | Value | Payload |
|------|-------|---------|
| JSON status | `0x01` | UTF-8 JSON: `{"type":"status","status":"connected",...}` |
| PCM audio | `0x02` | Raw 16kHz mono 16-bit LE PCM bytes |

## Thymia Sentinel Protocol (Summary)

### Config (first message after WebSocket open)

```json
{
  "api_key": "...",
  "user_label": "user",
  "language": "en",
  "biomarkers": ["helios", "apollo"],
  "policies": ["passthrough", "safety_analysis"],
  "sample_rate": 16000,
  "format": "pcm16",
  "channels": 1
}
```

### Audio (JSON header + binary)

```json
{"track": "user", "bytes": 3200, "format": "pcm16", "sample_rate": 16000, "channels": 1}
```
Followed immediately by raw PCM bytes.

### PolicyResult (server → client)

```json
{
  "type": "POLICY_RESULT",
  "policy": "passthrough",
  "biomarker_summary": {
    "stress": 0.3,
    "burnout": 0.1,
    "fatigue": 0.2,
    "distress": 0.15,
    "low_self_esteem": 0.05
  }
}
```

## Related Deep Dives

- [thymia_sentinel](deep_dives/thymia_sentinel.md) — Full Sentinel protocol specification
- [go_audio_ipc](deep_dives/go_audio_ipc.md) — Complete IPC protocol details
