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

## Custom Policy Path Misconfiguration

- setting `THYMIA_CUSTOM_POLICY_PROMPT_PATH` does not guarantee the custom policy is active
- the file must load successfully at runtime
- the store now falls back to default Agora safety when the prompt file is missing, but the custom policy itself still will not run

## Thymia Teardown Timing

- on agent unregister, Thymia session state is no longer removed immediately
- the module now marks the session inactive with `setSessionActive(false)` so downstream summarization can still read the final peak safety snapshot
- this means cleanup timing is intentionally delayed relative to the older “remove immediately” behavior
- if you reintroduce eager removal here, persisted session biomarkers can lose the crisis peak even though live escalation worked

## AI-Human Memory Requires Two Flags

- `ENABLE_MEMORY=true` alone does not persist session summaries
- `ENCRYPTION_KEY` must also be set
- continuity memory is intentionally disabled for `meetingMode` / human-human sessions

## Dashboard KPS Is Now Part of Prompt Injection

- for MindFix AI-human sessions, the prompt injection is no longer only local disk memory
- it also includes dashboard-provided:
  - client demographics
  - notes
  - direction
  - `Client Key Point Summary - AI Sessions`
-  - `consultant_ai_testing_mode`
-  - `ai_escalation_enabled`
- if `client-context` fails, AI continuity falls back to local encrypted session history only

## AI Transcript Retention And Escalation Flags Are Separate

- `consultant_ai_testing_mode=true`
  - retain full AI transcripts for that consultant's AI sessions
  - does not itself disable escalation
- `ai_escalation_enabled=false`
  - suppress live AI escalation for that client
  - the crisis module must not enter its pending-escalation path or inject “escalation underway” guidance

## `node/.env` Is the Restart Source of Truth

- `custom_llm.js` calls `dotenv.config()` from the `node/` cwd
- storing only the new crisis vars there can accidentally disable Thymia/Shen/memory on the next restart
- keep the full runtime set together in `server-custom-llm/node/.env`
- this differs from `consultant_dashboard`, which reads its repo-root `.env`

## Tool Execution Passes

- The LLM can trigger up to 5 tool execution passes per request
- Tool results are added to the message history and sent back to the LLM
- If the LLM keeps calling tools after 5 passes, the last response is returned as-is

## Auto-Subscribe Disabled

- The Go subscriber sets `AutoSubscribeAudio: false`
- It only subscribes to the specific `targetUid`, not all users in the channel
- This prevents echo loops and reduces bandwidth

## Related Deep Dives

- [go_audio_ipc](L2/go_audio_ipc.md) — Process lifecycle and crash recovery details
- [mindfix_crisis_escalation](L2/mindfix_crisis_escalation.md) — Crisis trigger, suppression, and PSTN flow
