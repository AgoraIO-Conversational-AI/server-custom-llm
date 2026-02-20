# Custom LLM Server — Go

Go implementation using Gin. Default port: **8102**.

## Quick Start

### Environment Preparation

- Go 1.21+

### Install Dependencies

```bash
go mod tidy
```

### Configuration

Set your LLM API key as an environment variable:

```bash
export LLM_API_KEY=sk-...
```

| Variable | Description | Default |
|----------|-------------|---------|
| `LLM_API_KEY` | API key for LLM provider | _(required)_ |
| `LLM_BASE_URL` | LLM API base URL | `https://api.openai.com/v1` |
| `LLM_MODEL` | Default model name | `gpt-4o-mini` |

Legacy env vars `YOUR_LLM_API_KEY` and `OPENAI_API_KEY` are also accepted.

### Run

```bash
go run .
```

The server starts on `http://localhost:8102`.

### Test

```bash
curl -X POST http://localhost:8102/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"messages": [{"role": "user", "content": "Hello, how are you?"}], "stream": true, "model": "gpt-4o-mini"}'
```

Run the automated tests:

```bash
bash ../test/test_go.sh
```

## File Structure

```
go/
  custom_llm.go           # Main server: endpoints, streaming, tool execution loop
  tools.go                # Tool definitions, RAG data, tool implementations
  conversation_store.go   # In-memory conversation store with trimming
  go.mod / go.sum
```

## Endpoints

See the [top-level README](../README.md#endpoints) for endpoint details. All three language implementations share the same endpoints and behavior.

**Health check:** `GET /ping` returns `{"status": "ok"}`.

## Adding Custom Tools

Edit `tools.go`:

1. Add a definition in `GetToolDefinitions()`:
```go
{
    Type: "function",
    Function: ToolFunctionDef{
        Name:        "my_tool",
        Description: "What it does",
        Parameters: map[string]any{
            "type": "object",
            "properties": map[string]any{
                "param1": map[string]any{"type": "string"},
            },
            "required": []string{"param1"},
        },
    },
}
```

2. Implement the handler:
```go
func myTool(appID, userID, channel string, args map[string]any) string {
    param1, _ := args["param1"].(string)
    return fmt.Sprintf("Result for %s", param1)
}
```

3. Register in `ToolMap`:
```go
var ToolMap = map[string]ToolHandler{
    "my_tool": myTool,
}
```

## Expose to the Internet

```bash
cloudflared tunnel --url http://localhost:8102
```

## License

This project is licensed under the MIT License.
