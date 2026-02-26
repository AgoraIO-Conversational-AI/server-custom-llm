# Go Audio Subscriber

Joins an Agora RTC channel and captures the user's audio as 16kHz mono 16-bit PCM. Communicates with the Node.js custom LLM server via stdin/stdout using a binary framing protocol.

Used by the Thymia integration to stream live audio to the Thymia Sentinel API for voice biomarker analysis.

## Prerequisites

- **Go 1.21+**
- **Linux** (Ubuntu 18.04+) for production. macOS works for development.
- **Agora native SDK** — downloaded automatically by the install script (~240 MB)

## Setup

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

The binary is output to `bin/audio_subscriber`.

### 3. Verify the build

```bash
# Linux
LD_LIBRARY_PATH=$(pwd)/sdk/agora_sdk ./bin/audio_subscriber --help

# macOS
DYLD_LIBRARY_PATH=$(pwd)/sdk/agora_sdk_mac ./bin/audio_subscriber --help
```

## Runtime library path

The Go binary links against native Agora SDK shared libraries at runtime. The Node.js `audio_subscriber.js` wrapper sets the library path automatically when spawning the child process:

- **Linux:** `LD_LIBRARY_PATH` → `sdk/agora_sdk/`
- **macOS:** `DYLD_LIBRARY_PATH` → `sdk/agora_sdk_mac/`

If running the binary manually, you must set the appropriate library path or the binary will fail immediately.

## Protocol

The Node.js server communicates with the Go binary via stdin (commands) and stdout (framed data).

**stdin (JSON commands, newline-delimited):**

```json
{"type": "start", "appId": "...", "channel": "...", "botUid": "5000", "token": "...", "targetUid": "101"}
{"type": "stop"}
```

**stdout (binary framing):**

| Field | Size | Description |
|-------|------|-------------|
| Type | 1 byte | `0x01` = JSON status, `0x02` = PCM audio |
| Length | 4 bytes (big-endian) | Payload size |
| Payload | _Length_ bytes | JSON string or raw PCM data |

**stderr:** Log messages (forwarded to Node.js server logs).

## File Structure

```
go-audio-subscriber/
  main.go           # Entry point, stdin command loop
  subscriber.go     # RTC connection, audio capture, stdout framing
  protocol.go       # Framing protocol constants and helpers
  Makefile           # Build targets
  sdk/              # Agora native SDK (downloaded, not committed)
    agora_sdk/      # Linux .so files
    agora_sdk_mac/  # macOS .dylib files
    go_sdk/         # Go SDK bindings
    scripts/        # SDK install script
```

## Troubleshooting

- **Binary crashes immediately / EPIPE:** The native SDK libraries are not found. Ensure `LD_LIBRARY_PATH` (Linux) or `DYLD_LIBRARY_PATH` (macOS) points to the correct `sdk/agora_sdk*` directory.
- **`make build` fails with CGO errors:** Ensure `CGO_ENABLED=1` (set by the Makefile). On Linux, you may need `gcc` installed (`sudo apt-get install build-essential`).
- **SDK download fails:** Check network connectivity. The SDK is ~240 MB downloaded from `download.agora.io`. Requires `curl` and `unzip`.
