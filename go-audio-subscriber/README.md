# Audio Subscriber

Go child process that joins an Agora RTC channel and captures raw PCM audio from a specific user. Designed to run as a subprocess spawned by the Node.js Custom LLM Server (`node/audio_subscriber.js`).

## How It Works

The Node.js server spawns this binary as a child process. Communication uses stdin/stdout:

- **stdin** — newline-delimited JSON commands from the Node.js parent
- **stdout** — binary framed protocol: `[1-byte type][4-byte BE length][payload]`
- **stderr** — log output (captured by Node.js parent)

```
┌──────────────┐   stdin (JSON)    ┌──────────────────┐
│ Node.js      │ ────────────────→ │ audio_subscriber │
│ Server       │                   │ (Go binary)      │
│              │ ←──────────────── │                  │
│ audio_       │  stdout (framed)  │ Joins Agora RTC  │
│ subscriber.js│                   │ channel, captures│
└──────────────┘                   │ PCM audio        │
                                   └──────────────────┘
```

### Frame Types

| Type        | Value  | Payload                                      |
| ----------- | ------ | -------------------------------------------- |
| JSON status | `0x01` | JSON object with `type`, `status`, `message` |
| PCM audio   | `0x02` | Raw 16kHz mono 16-bit PCM bytes              |

### Commands (stdin)

**start** — join a channel and subscribe to a target user's audio:

```json
{
  "type": "start",
  "appId": "your_app_id",
  "channel": "channel_name",
  "botUid": "5000",
  "token": "rtc_token",
  "targetUid": "user_uid_to_capture"
}
```

**stop** — disconnect and exit:

```json
{ "type": "stop" }
```

### Status Messages (stdout, type 0x01)

```json
{"type": "status", "status": "started",     "message": "Audio subscriber ready for commands"}
{"type": "status", "status": "connected",    "message": "Connected to channel room1"}
{"type": "status", "status": "subscribed",   "message": "Subscribed to UID 123", "uid": "123"}
{"type": "status", "status": "ready",        "message": "Subscribed to UID 123 in channel room1"}
{"type": "status", "status": "target_left",  "message": "Target UID 123 left", "uid": "123"}
{"type": "status", "status": "stopped",      "message": "Subscriber stopped"}
```

## Build

Requires Go 1.21+ and CGO (the Agora SDK is a native library).

### 1. Install the Agora native SDK (one-time)

```bash
cd sdk && bash scripts/install_agora_sdk.sh && cd ..
```

This downloads the platform-specific Agora RTC/RTM shared libraries to:

- **Linux:** `sdk/agora_sdk/` (`.so` files)
- **macOS:** `sdk/agora_sdk_mac/` (`.dylib` files)

### 2. Build the binary

```bash
make build
```

The binary is built to `bin/audio_subscriber`.

### Platform-Specific SDK

The Agora native SDK libraries are in `sdk/`:

| Platform | SDK directory        | Library path env    |
| -------- | -------------------- | ------------------- |
| macOS    | `sdk/agora_sdk_mac/` | `DYLD_LIBRARY_PATH` |
| Linux    | `sdk/agora_sdk/`     | `LD_LIBRARY_PATH`   |

The Node.js wrapper (`audio_subscriber.js`) sets the library path automatically when spawning the child process.

### Running Standalone (for testing)

```bash
# macOS
DYLD_LIBRARY_PATH=$(pwd)/sdk/agora_sdk_mac ./bin/audio_subscriber

# Linux
LD_LIBRARY_PATH=$(pwd)/sdk/agora_sdk ./bin/audio_subscriber
```

Then send a start command on stdin as JSON.

## Configuration

The audio subscriber is configured entirely via the start command from the Node.js parent. No environment variables are required.

| Field       | Description                                  |
| ----------- | -------------------------------------------- |
| `appId`     | Agora App ID                                 |
| `channel`   | RTC channel name to join                     |
| `botUid`    | UID for the subscriber bot (default: `5000`) |
| `token`     | RTC token for authentication                 |
| `targetUid` | UID of the user whose audio to capture       |

## Audio Format

- Sample rate: 16,000 Hz
- Channels: mono
- Bit depth: 16-bit signed PCM
- Byte order: little-endian

## Integration

The Node.js wrapper (`node/audio_subscriber.js`) manages the lifecycle:

- Spawns the Go binary with the correct library path
- Sends start/stop commands
- Parses the binary framing protocol
- Emits `audio`, `status`, `error`, and `stopped` events
- Auto-restarts on crash with exponential backoff (2s-30s, up to 5 attempts)

The Thymia integration consumes audio events to stream PCM to the Thymia Sentinel API for voice biomarker analysis.

## Files

```
go-audio-subscriber/
  main.go           # Entry point, stdin command loop
  subscriber.go     # Agora RTC connection and audio capture
  protocol.go       # Binary framing protocol (stdout)
  Makefile           # Build targets
  bin/               # Built binary output
  sdk/               # Agora native SDK (Go bindings + native libraries)
    agora_sdk/      # Linux .so files
    agora_sdk_mac/  # macOS .dylib files
    go_sdk/         # Go SDK bindings
    scripts/        # SDK install script
```

## Troubleshooting

- **Binary crashes immediately / EPIPE:** The native SDK libraries are not found. Ensure `LD_LIBRARY_PATH` (Linux) or `DYLD_LIBRARY_PATH` (macOS) points to the correct `sdk/agora_sdk*` directory.
- **`make build` fails with CGO errors:** Ensure `CGO_ENABLED=1` (set by the Makefile). On Linux, you may need `gcc` installed (`sudo apt-get install build-essential`).
- **SDK download fails:** Check network connectivity. The SDK is ~240 MB downloaded from `download.agora.io`. Requires `curl` and `unzip`.
