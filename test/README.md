# Testing

Self-tests for the Custom LLM Server. These tests validate that the server
starts, responds to requests with the correct SSE format, and rejects invalid
inputs. They do NOT require a real LLM API key — they test server structure and
error handling only.

## Port Assignments

| Language | Default Port |
|----------|-------------|
| Python | 8100 |
| Node.js | 8101 |
| Go | 8102 |

All servers use dedicated ports so they can run and be tested in parallel.

## Running Tests

### Python

```bash
cd python
export LLM_API_KEY=test-key
python3 custom_llm.py &
SERVER_PID=$!
bash ../test/test_python.sh
kill $SERVER_PID
```

### Node.js

```bash
cd node
npm install
LLM_API_KEY=test-key npm start &
SERVER_PID=$!
bash ../test/test_node.sh
kill $SERVER_PID
```

### Go

```bash
cd go
LLM_API_KEY=test-key go run . &
SERVER_PID=$!
bash ../test/test_go.sh
kill $SERVER_PID
```

### All at once

```bash
bash test/run_all.sh
```

## Test Coverage

### Happy Path
- Server starts and responds on correct port
- `/chat/completions` accepts POST with streaming and returns SSE content-type
- `/chat/completions` accepts POST with non-streaming mode
- `/chat/completions` accepts requests with `context` field (conversation memory)
- `/chat/completions` accepts requests with empty `context` object
- `/chat/completions` accepts requests with `tools` field (tool execution)
- `/rag/chat/completions` accepts POST and returns SSE content-type
- `/rag/chat/completions` returns a waiting message before LLM response
- `/audio/chat/completions` accepts POST and returns SSE data
- Endpoints exist and accept requests

### Failure Path
- Missing `messages` field returns 400/422
- `stream: false` on RAG endpoint returns 400
- `stream: false` on audio endpoint returns 400
- Missing messages on RAG endpoint returns 400
- Invalid JSON returns error
- Non-existent endpoint returns 404
