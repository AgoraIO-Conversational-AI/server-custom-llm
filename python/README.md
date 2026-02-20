# Custom LLM Server — Python

Python implementation using FastAPI and uvicorn. Default port: **8100**.

## Quick Start

### Environment Preparation

- Python 3.10+

```bash
python3 -m venv venv
source venv/bin/activate
```

### Install Dependencies

```bash
pip install -r requirements.txt
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
python3 custom_llm.py
```

The server starts on `http://0.0.0.0:8100`.

### Test

```bash
curl -X POST http://localhost:8100/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"messages": [{"role": "user", "content": "Hello, how are you?"}], "stream": true, "model": "gpt-4o-mini"}'
```

Run the automated tests:

```bash
bash ../test/test_python.sh
```

## File Structure

```
python/
  custom_llm.py           # Main server: endpoints, streaming, tool execution loop
  tools.py                # Tool definitions, RAG data, tool implementations
  conversation_store.py   # In-memory conversation store with trimming
  requirements.txt
```

## Endpoints

See the [top-level README](../README.md#endpoints) for endpoint details. All three language implementations share the same endpoints and behavior.

**Health check:** FastAPI auto-generates API docs at `/docs`.

## Adding Custom Tools

Edit `tools.py`:

1. Add a schema to `TOOL_DEFINITIONS`:
```python
{
    "type": "function",
    "function": {
        "name": "my_tool",
        "description": "What it does",
        "parameters": {
            "type": "object",
            "properties": {"param1": {"type": "string"}},
            "required": ["param1"],
        },
    },
}
```

2. Implement the handler:
```python
def my_tool(app_id, user_id, channel, args):
    return f"Result for {args['param1']}"
```

3. Register in `TOOL_MAP`:
```python
TOOL_MAP["my_tool"] = my_tool
```

## Expose to the Internet

```bash
cloudflared tunnel --url http://localhost:8100
```

## License

This project is licensed under the MIT License.
