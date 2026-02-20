/**
 * RTM (Real-Time Messaging) client for the Custom LLM Server.
 * Node.js only — uses the rtm-nodejs package.
 *
 * Environment variables:
 *   AGORA_APP_ID        - Agora App ID
 *   AGORA_RTM_TOKEN     - RTM token (optional for testing)
 *   AGORA_RTM_USER_ID   - Agent's RTM user ID
 *   AGORA_RTM_CHANNEL   - RTM channel to subscribe to
 *
 * If env vars are not set, RTM initialization is silently skipped.
 */

const logger = {
  info: (message) => console.log(`INFO: [RTM] ${message}`),
  debug: (message) => console.log(`DEBUG: [RTM] ${message}`),
  error: (message, error) => console.error(`ERROR: [RTM] ${message}`, error),
  warn: (message) => console.warn(`WARN: [RTM] ${message}`),
};

let rtmClient = null;
let channelName = null;
let messageHandlers = [];
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 10;
const BASE_RECONNECT_DELAY = 2000; // 2 seconds
const MAX_RECONNECT_DELAY = 60000; // 60 seconds

/**
 * Initialize RTM client. Returns the client if successful, null otherwise.
 * Silently skips if environment variables are not configured.
 */
async function initRTM() {
  const appId = process.env.AGORA_APP_ID;
  const userId = process.env.AGORA_RTM_USER_ID;
  const token = process.env.AGORA_RTM_TOKEN || '';
  channelName = process.env.AGORA_RTM_CHANNEL;

  if (!appId || !userId || !channelName) {
    logger.debug(
      'RTM env vars not set (AGORA_APP_ID, AGORA_RTM_USER_ID, AGORA_RTM_CHANNEL) — skipping RTM'
    );
    return null;
  }

  try {
    const AgoraRTM = require('rtm-nodejs');

    rtmClient = new AgoraRTM.RTM(appId, userId);

    // Login
    const loginOptions = token ? { token } : {};
    await rtmClient.login(loginOptions);
    logger.info(`Logged in as ${userId}`);

    // Subscribe to channel
    await rtmClient.subscribe(channelName);
    logger.info(`Subscribed to channel: ${channelName}`);

    // Set up event listeners
    setupEventListeners(appId, userId);

    reconnectAttempts = 0;
    return rtmClient;
  } catch (error) {
    logger.error('Failed to initialize RTM:', error);
    return null;
  }
}

function setupEventListeners(appId, userId) {
  if (!rtmClient) return;

  rtmClient.addEventListener('message', (event) => {
    try {
      for (const handler of messageHandlers) {
        try {
          handler(event);
        } catch (handlerError) {
          logger.error('Error in message handler:', handlerError);
        }
      }
    } catch (error) {
      logger.error('Error processing RTM message:', error);
    }
  });

  rtmClient.addEventListener('status', (event) => {
    logger.info(`Status: ${event.state}`);

    if (event.state === 'DISCONNECTED' || event.state === 'FAILED') {
      scheduleReconnection(appId, userId);
    } else if (event.state === 'CONNECTED') {
      reconnectAttempts = 0;
    }
  });

  rtmClient.addEventListener('error', (error) => {
    logger.error(`RTM error: ${error.message || error}`, error);
  });
}

function scheduleReconnection(appId, userId) {
  reconnectAttempts++;

  if (reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
    logger.error(`Max reconnection attempts (${MAX_RECONNECT_ATTEMPTS}) reached`);
    return;
  }

  const delay = Math.min(
    BASE_RECONNECT_DELAY * Math.pow(2, reconnectAttempts - 1),
    MAX_RECONNECT_DELAY
  );

  logger.info(
    `Scheduling reconnection attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS} in ${delay}ms`
  );

  setTimeout(async () => {
    try {
      // Try to logout existing client
      try {
        if (rtmClient) await rtmClient.logout();
      } catch (e) {
        // ignore
      }

      // Reinitialize
      const result = await initRTM();
      if (result) {
        logger.info('Reconnected successfully');
      } else {
        scheduleReconnection(appId, userId);
      }
    } catch (error) {
      logger.error('Reconnection failed:', error);
      scheduleReconnection(appId, userId);
    }
  }, delay);
}

/**
 * Send a message to an RTM channel.
 */
async function sendRTMMessage(channel, message) {
  if (!rtmClient) {
    logger.warn('RTM client not initialized — cannot send message');
    return false;
  }

  try {
    await rtmClient.publish(channel || channelName, message);
    logger.debug(`Message sent to ${channel || channelName}`);
    return true;
  } catch (error) {
    logger.error('Failed to send RTM message:', error);
    return false;
  }
}

/**
 * Register a handler for incoming RTM messages.
 */
function onRTMMessage(callback) {
  messageHandlers.push(callback);
}

module.exports = {
  initRTM,
  sendRTMMessage,
  onRTMMessage,
};
