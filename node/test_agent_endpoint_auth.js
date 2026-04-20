const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');

async function waitForReady(port, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/ping`);
      if (response.ok) return;
    } catch (_error) {
      // retry
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`server on ${port} did not become ready`);
}

test('register-agent and unregister-agent require shared secret when configured', async (t) => {
  const port = 8117;
  const child = spawn(process.execPath, ['custom_llm.js'], {
    cwd: __dirname,
    env: {
      ...process.env,
      PORT: String(port),
      AGENT_SERVER_SHARED_SECRET: 'test-agent-secret',
      THYMIA_ENABLED: 'false',
      SHEN_ENABLED: 'false',
      ENABLE_MEMORY: 'false',
    },
    stdio: 'ignore',
  });
  t.after(() => {
    child.kill('SIGTERM');
  });

  await waitForReady(port);

  const noSecret = await fetch(`http://127.0.0.1:${port}/register-agent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert.equal(noSecret.status, 403);

  const withSecret = await fetch(`http://127.0.0.1:${port}/register-agent`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Agent-Server-Secret': 'test-agent-secret',
    },
    body: JSON.stringify({}),
  });
  assert.equal(withSecret.status, 400);

  const unregisterNoSecret = await fetch(`http://127.0.0.1:${port}/unregister-agent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert.equal(unregisterNoSecret.status, 403);
});
