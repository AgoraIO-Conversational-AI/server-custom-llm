const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const http = require('node:http');

async function waitForReady(url, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch (_error) {
      // retry
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`server at ${url} did not become ready`);
}

function startMockUpstream(port) {
  const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/chat/completions') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      const chunk = {
        id: 'mock',
        object: 'chat.completion.chunk',
        choices: [
          {
            index: 0,
            delta: { role: 'assistant', content: 'mock reply' },
            finish_reason: null,
          },
        ],
      };
      res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }
    res.writeHead(404);
    res.end();
  });

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

test('rag endpoint does not throw reference errors without reasoning_effort', async (t) => {
  const upstreamPort = 8126;
  const appPort = 8127;
  const upstream = await startMockUpstream(upstreamPort);
  t.after(() => {
    upstream.close();
  });

  const child = spawn(process.execPath, ['custom_llm.js'], {
    cwd: __dirname,
    env: {
      ...process.env,
      PORT: String(appPort),
      LLM_API_KEY: 'test-key',
      LLM_BASE_URL: `http://127.0.0.1:${upstreamPort}`,
      THYMIA_ENABLED: 'false',
      SHEN_ENABLED: 'false',
      ENABLE_MEMORY: 'false',
    },
    stdio: 'ignore',
  });
  t.after(() => {
    child.kill('SIGTERM');
  });

  await waitForReady(`http://127.0.0.1:${appPort}/ping`);

  const response = await fetch(`http://127.0.0.1:${appPort}/rag/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      stream: true,
      messages: [{ role: 'user', content: 'Tell me about Agora ConvoAI' }],
    }),
  });

  assert.equal(response.status, 200);
  const body = await response.text();
  assert.match(response.headers.get('content-type') || '', /text\/event-stream/);
  assert.doesNotMatch(body, /ReferenceError|effectiveRequestTools|effectiveReasoningEffort/);
  assert.match(body, /data:/);
});
