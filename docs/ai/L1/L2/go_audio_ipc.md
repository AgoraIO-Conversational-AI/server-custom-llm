# Go-Node.js IPC Binary Framing Protocol

> **When to read this:** You are modifying the Go audio subscriber, debugging the
> audio pipeline, adding new IPC commands, or investigating child process issues.

## Overview

The Go audio subscriber runs as a child process of the Node.js server. Communication
uses three channels:
- **stdin** (Node → Go): Newline-delimited JSON commands
- **stdout** (Go → Node): Binary framed protocol for status + PCM audio
- **stderr** (Go → Node): Human-readable log output

## stdin Protocol (Node.js → Go)

Each command is a single line of JSON terminated by `\n`.

### start

```json
{"type":"start","appId":"abc123","channel":"room42","botUid":"5000","token":"","targetUid":"101"}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | string | Yes | `"start"` |
| `appId` | string | Yes | Agora App ID |
| `channel` | string | Yes | Agora channel name |
| `botUid` | string | Yes | UID for the subscriber bot (default: 5000) |
| `token` | string | No | Agora token (empty string for testing without auth) |
| `targetUid` | string | Yes | UID of the user to subscribe to |

### stop

```json
{"type":"stop"}
```

Gracefully disconnects from the channel and exits the process.

## stdout Protocol (Go → Node.js)

Binary framed protocol. Each frame:

```
┌──────────┬──────────────────────┬──────────────────────┐
│ Type     │ Length               │ Payload              │
│ 1 byte   │ 4 bytes (big-endian) │ variable length      │
└──────────┴──────────────────────┴──────────────────────┘
```

### Frame Types

| Type Byte | Name | Payload Format |
|-----------|------|---------------|
| `0x01` | JSON Status | UTF-8 JSON string |
| `0x02` | PCM Audio | Raw 16kHz mono 16-bit LE PCM bytes |

### JSON Status Messages (0x01)

```json
{"type":"status","status":"started","message":"Audio subscriber ready for commands"}
{"type":"status","status":"connected","message":"Connected to channel room42"}
{"type":"status","status":"subscribed","message":"Subscribed to UID 101","uid":"101"}
{"type":"status","status":"ready","message":"Subscribed to UID 101 in channel room42"}
{"type":"status","status":"target_left","message":"Target UID 101 left","uid":"101"}
{"type":"status","status":"stopped","message":"Subscriber stopped"}
{"type":"error","error":"Missing appId or channel in start command"}
```

### PCM Audio Frames (0x02)

- Raw PCM bytes from the Agora audio callback
- Format: 16kHz, mono, 16-bit signed little-endian
- Typical frame size: 320 bytes (10ms of audio)
- Frames arrive at ~100Hz (every 10ms)

## Node.js Frame Parser

The `AudioManager._onChildData()` method parses the binary stream:

```javascript
while (frameBuf.length >= 5) {
  const frameType = frameBuf[0];
  const payloadLen = frameBuf.readUInt32BE(1);
  if (frameBuf.length < 5 + payloadLen) break;

  const payload = frameBuf.slice(5, 5 + payloadLen);
  frameBuf = frameBuf.slice(5 + payloadLen);

  if (frameType === 0x01) handleJSON(payload);
  else if (frameType === 0x02) handlePCM(payload);
}
```

## Process Lifecycle

```
Node.js                          Go Child
  │                                │
  │── spawn ──────────────────────►│ (process starts)
  │                                │── redirect stdout to /dev/null
  │                                │── save original stdout for IPC
  │◄── 0x01 {"status":"started"} ─│
  │                                │
  │── stdin: {"type":"start",...} ►│
  │                                │── Initialize Agora SDK
  │◄── 0x01 {"status":"connected"}│
  │                                │── Subscribe to target UID
  │◄── 0x01 {"status":"subscribed"}│
  │◄── 0x01 {"status":"ready"} ───│
  │                                │
  │◄── 0x02 [PCM 320 bytes] ──────│  ← every 10ms
  │◄── 0x02 [PCM 320 bytes] ──────│
  │◄── 0x02 [PCM 320 bytes] ──────│
  │     ... (continuous stream) ... │
  │                                │
  │── stdin: {"type":"stop"} ─────►│
  │◄── 0x01 {"status":"stopped"} ─│
  │                                │── exit(0)
```

## stdout Pollution Prevention

The Agora SDK prints debug output to stdout, which would corrupt the binary protocol.
The Go binary handles this by:

1. Saving the original `os.Stdout` file descriptor
2. Redirecting `os.Stdout` to `/dev/null`
3. Using the saved fd for all IPC writes via `FrameWriter`

**Critical rule:** Never use `fmt.Println()` or `fmt.Printf()` in Go code.
Always use `logger.Printf()` which writes to stderr.

## Crash Recovery

When the Go child process crashes:

1. Node.js detects the exit via the `child.on('exit')` handler
2. AudioManager schedules a restart with exponential backoff
3. Backoff: 2s, 4s, 8s, 16s, 30s (max 5 attempts)
4. On restart, a new `start` command is sent automatically
5. PCM that arrived during the restart gap is lost

On Node.js shutdown:

1. All children receive SIGTERM
2. After 5 seconds, any remaining children receive SIGKILL
3. The AudioManager clears all session state

## Audio Data Flow

```
Agora RTC Channel
      │
      ▼ (SDK audio callback, 10ms frames)
Go: OnPlaybackAudioFrameBeforeMixing()
      │
      ▼ (filter: only targetUid)
Go: FrameWriter.WritePCM(frame.Buffer)
      │
      ▼ (binary frame on stdout)
Node: AudioManager._onChildData()
      │
      ▼ (parse frame)
Node: AudioManager._onChildPCM()
      │
      ├── [Thymia connected] → ThymiaClient.sendAudio()
      │                              │
      │                              ▼
      │                        Thymia Sentinel API
      │
      └── [Not connected] → Ring buffer (up to 60s)
                                │
                                ▼ (flushed on Thymia connect)
                          ThymiaClient.sendAudio()
```
