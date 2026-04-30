const https = require('https');

function speakWithAgentCredentials({
  appId,
  agentId,
  authHeader,
  agentEndpoint,
  text,
  priority = 'APPEND',
  logger = console,
}) {
  return new Promise((resolve, reject) => {
    if (!appId || !agentId || !authHeader || !agentEndpoint || !text) {
      resolve({ ok: false, skipped: true, reason: 'missing_agent_or_text' });
      return;
    }

    const speakUrl = `${agentEndpoint}/${appId}/agents/${agentId}/speak`;
    const truncated = text.length > 500 ? text.substring(0, 500) : text;
    const payload = JSON.stringify({
      text: truncated,
      priority,
      interruptable: true,
    });
    const startedAt = Date.now();

    logger.info(
      `[AgentSpeak] t=${startedAt} speak to agent=${agentId} priority=${priority} text="${truncated.substring(0, 100)}"`
    );

    const url = new URL(speakUrl);
    const req = https.request(
      {
        hostname: url.hostname,
        port: 443,
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: authHeader,
          'Content-Length': Buffer.byteLength(payload),
        },
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => {
          const latency = Date.now() - startedAt;
          if (res.statusCode === 200) {
            logger.info(
              `[AgentSpeak] t=${Date.now()} SUCCESS status=${res.statusCode} latency=${latency}ms`
            );
            resolve({ ok: true, statusCode: res.statusCode, body });
            return;
          }
          logger.error(
            `[AgentSpeak] t=${Date.now()} FAILED status=${res.statusCode} latency=${latency}ms body=${body.substring(0, 300)}`
          );
          resolve({ ok: false, statusCode: res.statusCode, body });
        });
      }
    );

    req.on('error', (error) => {
      logger.error(`[AgentSpeak] t=${Date.now()} ERROR: ${error.message}`);
      reject(error);
    });

    req.write(payload);
    req.end();
  });
}

module.exports = {
  speakWithAgentCredentials,
};
