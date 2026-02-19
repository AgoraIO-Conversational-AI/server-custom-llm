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
export YOUR_LLM_API_KEY=test-key
python3 custom_llm.py &
SERVER_PID=$!
bash ../test/test_python.sh
kill $SERVER_PID
```

### Node.js

```bash
cd node
npm install
OPENAI_API_KEY=test-key npm start &
SERVER_PID=$!
bash ../test/test_node.sh
kill $SERVER_PID
```

### Go

```bash
cd go
go build -o custom_llm_server custom_llm.go
YOUR_LLM_API_KEY=test-key ./custom_llm_server &
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
- `/chat/completions` accepts POST with valid body and returns SSE content-type
- `/rag/chat/completions` accepts POST and returns SSE content-type
- Endpoints exist and accept requests

### Failure Path
- Missing `messages` field returns 400/422
- `stream: false` returns 400
- Invalid JSON returns error
- Non-existent endpoint returns 404
