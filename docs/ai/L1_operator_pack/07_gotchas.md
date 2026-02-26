# 07 Gotchas

> Critical pitfalls, tribal knowledge, and environment-specific behaviors.

## CGO Build Requirements

- The Go audio subscriber requires CGO enabled (`CGO_ENABLED=1`)
- `CGO_CFLAGS` must point to the Agora SDK C header directories
- `CGO_LDFLAGS` must point to the native library directory
- macOS uses `.dylib` files, Linux uses `.so` files — the Makefile handles this

## DYLD_LIBRARY_PATH (macOS)

- On macOS, the Go binary needs `DYLD_LIBRARY_PATH` set to find Agora `.dylib` files at runtime
- The `audio_manager.js` sets this automatically when spawning the child process
- If running the Go binary manually, set it: `DYLD_LIBRARY_PATH=./vendor_sdk/agora_sdk_mac ./bin/audio_subscriber`

## stdout Pollution from Agora SDK

- The Agora SDK prints to stdout, which corrupts the binary IPC protocol
- The Go binary redirects `os.Stdout` to `/dev/null` before initializing the SDK
- IPC writes go through the saved original stdout file descriptor
- **Never use `fmt.Println()` in the Go code** — use `logger.Printf()` (writes to stderr)

## Process Isolation

- The Go child process runs the Agora SDK in a separate process
- If the SDK crashes (segfault), only the child dies — Node.js stays up
- The AudioManager auto-restarts crashed children with exponential backoff
- On Node.js exit, all children receive SIGTERM (with SIGKILL fallback after 5s)

## Thymia Analysis Latency

- Thymia needs ~30 seconds of speech before returning meaningful biomarker results
- Earlier PolicyResults may have null or low-confidence scores
- The `get_wellness_metrics` tool returns `no_data` status until results arrive

## WebSocket Reconnection

- Both ThymiaClient and RTM client implement exponential backoff reconnection
- ThymiaClient: max 10 attempts, 1s to 30s delay
- On reconnect, the SentinelConfig is re-sent automatically
- Buffered PCM is NOT re-sent on reconnect (only pre-connection buffer is flushed once)

## Tool Execution Passes

- The LLM can trigger up to 5 tool execution passes per request
- Tool results are added to the message history and sent back to the LLM
- If the LLM keeps calling tools after 5 passes, the last response is returned as-is

## Auto-Subscribe Disabled

- The Go subscriber sets `AutoSubscribeAudio: false`
- It only subscribes to the specific `targetUid`, not all users in the channel
- This prevents echo loops and reduces bandwidth

## Related Deep Dives

- [go_audio_ipc](deep_dives/go_audio_ipc.md) — Process lifecycle and crash recovery details
