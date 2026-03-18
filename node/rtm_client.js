/**
 * RTM (Real-Time Messaging) client for the Custom LLM Server.
 * Node.js only — uses the rtm-nodejs package.
 *
 * Manages one RTM session per channel. Each session has its own login
 * using the appId/uid/token from the ConvoAI request params. The simple-backend
 * generates channel-scoped RTM UIDs (e.g. "5001-{channel}") so each session
 * has a unique identity and won't kick other sessions off.
 */

const logger = {
  info: (message) => console.log(`INFO: [RTM] ${message}`),
  debug: (message) => console.log(`DEBUG: [RTM] ${message}`),
  error: (message, error) => console.error(`ERROR: [RTM] ${message}`, error),
  warn: (message) => console.warn(`WARN: [RTM] ${message}`),
};

// Per-channel sessions: Map<channel, { client, appId, uid, token, reconnectAttempts, initParams }>
const sessions = new Map();
let messageHandlers = [];
const MAX_RECONNECT_ATTEMPTS = 10;
const BASE_RECONNECT_DELAY = 2000;
const MAX_RECONNECT_DELAY = 60000;

/**
 * Initialize RTM from environment variables (legacy). Returns the client or null.
 */
async function initRTM() {
  const appId = process.env.AGORA_APP_ID;
  const userId = process.env.AGORA_RTM_USER_ID;
  const token = process.env.AGORA_RTM_TOKEN || '';
  const channel = process.env.AGORA_RTM_CHANNEL;

  if (!appId || !userId || !channel) {
    logger.debug(
      'RTM env vars not set (AGORA_APP_ID, AGORA_RTM_USER_ID, AGORA_RTM_CHANNEL) — skipping RTM'
    );
    return null;
  }

  return initRTMWithParams(appId, userId, token, channel);
}

/**
 * Initialize RTM session for a channel. Creates a new session if one doesn't
 * exist for this channel. Idempotent — returns existing client if already connected.
 */
async function initRTMWithParams(appId, uid, token, channel) {
  if (!appId || !uid || !channel) {
    logger.debug('Missing appId, uid, or channel for RTM init');
    return null;
  }

  // Already have a session for this channel
  if (sessions.has(channel)) {
    return sessions.get(channel).client;
  }

  try {
    const AgoraRTM = require('rtm-nodejs');

    const rtmConfig = token ? { token } : {};
    const client = new AgoraRTM.RTM(appId, uid, rtmConfig);

    await client.login();
    logger.info(`[${channel}] Logged in as ${uid}`);

    await client.subscribe(channel);
    logger.info(`[${channel}] Subscribed`);

    const session = {
      client,
      appId,
      uid,
      token,
      channel,
      reconnectAttempts: 0,
      initParams: { appId, uid, token, channel },
    };

    setupEventListeners(session);
    sessions.set(channel, session);

    return client;
  } catch (error) {
    logger.error(`[${channel}] Failed to initialize RTM:`, error);
    return null;
  }
}

function setupEventListeners(session) {
  const { client, channel } = session;

  client.addEventListener('message', (event) => {
    try {
      for (const handler of messageHandlers) {
        try {
          handler(event);
        } catch (handlerError) {
          logger.error(`[${channel}] Error in message handler:`, handlerError);
        }
      }
    } catch (error) {
      logger.error(`[${channel}] Error processing RTM message:`, error);
    }
  });

  client.addEventListener('status', (event) => {
    logger.info(`[${channel}] Status: ${event.state}`);

    if (event.state === 'DISCONNECTED' || event.state === 'FAILED') {
      scheduleReconnection(channel);
    } else if (event.state === 'CONNECTED') {
      session.reconnectAttempts = 0;
    }
  });

  client.addEventListener('error', (error) => {
    logger.error(`[${channel}] RTM error: ${error.message || error}`, error);
  });
}

function scheduleReconnection(channel) {
  const session = sessions.get(channel);
  if (!session) return;

  session.reconnectAttempts++;

  if (session.reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
    logger.error(`[${channel}] Max reconnection attempts (${MAX_RECONNECT_ATTEMPTS}) reached`);
    sessions.delete(channel);
    return;
  }

  const delay = Math.min(
    BASE_RECONNECT_DELAY * Math.pow(2, session.reconnectAttempts - 1),
    MAX_RECONNECT_DELAY
  );

  logger.info(
    `[${channel}] Scheduling reconnection attempt ${session.reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS} in ${delay}ms`
  );

  setTimeout(async () => {
    try {
      // Clean up old client
      try {
        if (session.client) await session.client.logout();
      } catch (e) {
        // ignore
      }
      sessions.delete(channel);

      // Reconnect with saved params
      const { appId, uid, token } = session.initParams;
      const result = await initRTMWithParams(appId, uid, token, channel);
      if (result) {
        logger.info(`[${channel}] Reconnected successfully`);
      } else {
        scheduleReconnection(channel);
      }
    } catch (error) {
      logger.error(`[${channel}] Reconnection failed:`, error);
      scheduleReconnection(channel);
    }
  }, delay);
}

/**
 * Send a message to an RTM channel.
 */
async function sendRTMMessage(channel, message) {
  const session = sessions.get(channel);
  if (!session) {
    logger.warn(`[${channel}] No RTM session — cannot send message`);
    return false;
  }

  try {
    await session.client.publish(channel, message);
    logger.debug(`[${channel}] Message sent`);
    return true;
  } catch (error) {
    logger.error(`[${channel}] Failed to send RTM message:`, error);
    return false;
  }
}

/**
 * Destroy the RTM session for a channel (called on unregister-agent).
 */
async function destroySession(channel) {
  const session = sessions.get(channel);
  if (!session) return;

  // Remove from map first to prevent further use
  sessions.delete(channel);

  try {
    await session.client.unsubscribe(channel).catch((e) => {
      logger.warn(`[${channel}] Unsubscribe error (ignored): ${e.message || e}`);
    });
    await session.client.logout().catch((e) => {
      logger.warn(`[${channel}] Logout error (ignored): ${e.message || e}`);
    });
    logger.info(`[${channel}] Session destroyed`);
  } catch (error) {
    logger.error(`[${channel}] Error destroying session:`, error);
  }
}

/**
 * Check if RTM is connected for any channel (backwards-compatible).
 */
function isConnected() {
  return sessions.size > 0;
}

/**
 * Check if RTM is connected for a specific channel.
 */
function isChannelConnected(channel) {
  return sessions.has(channel);
}

/**
 * Register a handler for incoming RTM messages (from all sessions).
 */
function onRTMMessage(callback) {
  messageHandlers.push(callback);
}

module.exports = {
  initRTM,
  initRTMWithParams,
  sendRTMMessage,
  destroySession,
  onRTMMessage,
  isConnected,
  isChannelConnected,
};
