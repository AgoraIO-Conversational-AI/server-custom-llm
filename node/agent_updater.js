/**
 * Shared Agent Update manager.
 *
 * Multiple modules (Shen, Thymia) need to inject system messages via the
 * Agora Agent Update API. The API replaces the entire system_messages array,
 * so if modules call it independently they overwrite each other.
 *
 * This module solves that by:
 *   1. Each module calls setInjection(appId, channel, moduleName, content)
 *   2. All injections are combined into a single system_messages array
 *   3. A debounced Agent Update call sends the combined payload
 *
 * Usage:
 *   const updater = require('./agent_updater');
 *   updater.registerAgent(appId, channel, agentId, authHeader, agentEndpoint, prompt);
 *   updater.setInjection(appId, channel, 'shen', vitalsText);
 *   updater.setInjection(appId, channel, 'thymia', biomarkerText);
 */

const https = require('https');
const http = require('http');

const logger = {
  info: (msg) => console.log(`INFO: [AgentUpdater] ${msg}`),
  debug: (msg) => console.log(`DEBUG: [AgentUpdater] ${msg}`),
  error: (msg, err) => console.error(`ERROR: [AgentUpdater] ${msg}`, err || ''),
  warn: (msg) => console.warn(`WARN: [AgentUpdater] ${msg}`),
};

// Per-channel agent info: appId:channel → { agentId, authHeader, agentEndpoint, originalPrompt }
const agentRegistry = new Map();

// Per-channel module injections: appId:channel → { moduleName: content, ... }
const injections = new Map();

// Debounce timers: appId:channel → timeout
const debounceTimers = new Map();

// Debounce window in ms — wait for all modules to push before sending
const DEBOUNCE_MS = 100;

function getKey(appId, channel) {
  return `${appId}:${channel}`;
}

/**
 * Register an agent for a channel. Must be called before setInjection.
 */
function registerAgent(appId, channel, agentId, authHeader, agentEndpoint, prompt) {
  const key = getKey(appId, channel);
  agentRegistry.set(key, { agentId, authHeader, agentEndpoint, originalPrompt: prompt || null });
  logger.info(`Agent registered: ${agentId} on ${channel}`);
}

/**
 * Get agent info for a channel.
 */
function getAgent(appId, channel) {
  return agentRegistry.get(getKey(appId, channel)) || null;
}

/**
 * Unregister an agent and clear its injections.
 */
function unregisterAgent(appId, channel) {
  const key = getKey(appId, channel);
  agentRegistry.delete(key);
  injections.delete(key);
  const timer = debounceTimers.get(key);
  if (timer) {
    clearTimeout(timer);
    debounceTimers.delete(key);
  }
  logger.info(`Agent unregistered on ${channel}`);
}

/**
 * Set injection content for a module. Triggers a debounced Agent Update.
 *
 * @param {string} appId
 * @param {string} channel
 * @param {string} moduleName - e.g. 'shen' or 'thymia'
 * @param {string} content - the system message content, or null to remove
 */
function setInjection(appId, channel, moduleName, content) {
  const key = getKey(appId, channel);

  if (!agentRegistry.has(key)) {
    logger.debug(`No agent registered for ${key}, skipping injection from ${moduleName}`);
    return;
  }

  // Update or remove this module's injection
  let channelInjections = injections.get(key);
  if (!channelInjections) {
    channelInjections = {};
    injections.set(key, channelInjections);
  }

  if (content) {
    channelInjections[moduleName] = content;
  } else {
    delete channelInjections[moduleName];
  }

  // Debounce: wait DEBOUNCE_MS for other modules to also push
  const existing = debounceTimers.get(key);
  if (existing) clearTimeout(existing);

  debounceTimers.set(key, setTimeout(() => {
    debounceTimers.delete(key);
    flushUpdate(appId, channel);
  }, DEBOUNCE_MS));
}

/**
 * Send the combined Agent Update.
 */
function flushUpdate(appId, channel) {
  const key = getKey(appId, channel);
  const agent = agentRegistry.get(key);
  if (!agent) return;

  const channelInjections = injections.get(key) || {};
  const moduleNames = Object.keys(channelInjections);

  if (moduleNames.length === 0) return;

  const { agentId, authHeader, agentEndpoint, originalPrompt } = agent;
  const updateUrl = `${agentEndpoint}/${appId}/agents/${agentId}/update`;

  // Build system_messages: original prompt + one message per module injection
  const systemMessages = [];
  if (originalPrompt) {
    systemMessages.push({ role: 'system', content: originalPrompt });
  }
  for (const name of moduleNames) {
    systemMessages.push({ role: 'system', content: channelInjections[name] });
  }

  const payload = JSON.stringify({
    properties: {
      llm: {
        system_messages: systemMessages,
      },
    },
  });

  const ts = Date.now();
  const contentPreview = moduleNames.map(n => {
    const c = channelInjections[n];
    return `${n}:${c.substring(0, 80).replace(/\n/g, '\\n')}`;
  }).join(' | ');
  logger.info(`t=${ts} pushing combined update (${moduleNames.join('+')}) to agent=${agentId} sysMsgs=${systemMessages.length}`);
  logger.info(`t=${ts} preview: ${contentPreview}`);

  const url = new URL(updateUrl);
  const protocol = url.protocol === 'https:' ? https : http;
  const options = {
    method: 'POST',
    hostname: url.hostname,
    port: url.port || (url.protocol === 'https:' ? 443 : 80),
    path: url.pathname,
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
    },
  };

  if (authHeader) {
    options.headers['Authorization'] = authHeader;
  }

  const req = protocol.request(options, (res) => {
    let body = '';
    res.on('data', (chunk) => { body += chunk; });
    res.on('end', () => {
      const latency = Date.now() - ts;
      if (res.statusCode >= 200 && res.statusCode < 300) {
        logger.info(`t=${Date.now()} SUCCESS status=${res.statusCode} latency=${latency}ms modules=${moduleNames.join('+')}`);
      } else {
        logger.error(`t=${Date.now()} FAILED status=${res.statusCode} latency=${latency}ms body=${body.substring(0, 500)}`);
      }
    });
  });

  req.on('error', (e) => {
    logger.error(`t=${Date.now()} ERROR: ${e.message}`);
  });

  req.write(payload);
  req.end();
}

module.exports = {
  registerAgent,
  getAgent,
  unregisterAgent,
  setInjection,
};
