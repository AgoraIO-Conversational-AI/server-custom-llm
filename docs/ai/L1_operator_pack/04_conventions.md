# 04 Conventions

> Naming patterns, code style, and structural conventions used in this repo.

## Tool Handler Signature

All tool handlers follow the same signature:

```javascript
function myTool(appId, userId, channel, args) {
  // args is parsed JSON from the LLM tool_call
  return JSON.stringify({ status: 'ok', data: ... });
}
```

- Return value must be a string (JSON-stringified for structured data)
- Register in `TOOL_MAP` (core tools) or `THYMIA_TOOL_MAP` (Thymia tools)
- Add schema to `TOOL_DEFINITIONS` or `THYMIA_TOOL_DEFINITIONS`

## Naming Conventions

- **Files**: `snake_case.js` for Node.js, `snake_case.go` for Go
- **Functions**: `camelCase` in JS, `PascalCase` (exported) / `camelCase` (private) in Go
- **Constants**: `UPPER_SNAKE_CASE` in JS, `camelCase` in Go
- **Env vars**: `UPPER_SNAKE_CASE`, prefixed by feature (`THYMIA_`, `AUDIO_`, `LLM_`)

## Logging

All modules create a local logger object:

```javascript
const logger = {
  info: (message) => console.log(`INFO: ${message}`),
  debug: (message) => console.log(`DEBUG: ${message}`),
  error: (message, error) => console.error(`ERROR: ${message}`, error),
};
```

Go modules log to stderr (parent captures via child process stderr pipe).

## IPC Protocol Convention

- Node.js → Go: newline-delimited JSON on stdin
- Go → Node.js: binary framed on stdout `[1-byte type][4-byte BE length][payload]`
- Go stderr: human-readable logs

## Error Handling

- HTTP errors: return JSON `{ detail: "error message" }` with appropriate status code
- Tool errors: return error string as tool result (LLM sees the error)
- Child process crashes: auto-restart with exponential backoff (max 5 attempts)
- WebSocket errors: auto-reconnect with exponential backoff (max 10 attempts)

## Related Deep Dives

- [go_audio_ipc](deep_dives/go_audio_ipc.md) — Full IPC protocol specification
