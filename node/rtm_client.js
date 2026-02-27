/**
 * RTM (Real-Time Messaging) client for the Custom LLM Server.
 * Node.js only — uses the rtm-nodejs package.
 *
 * Can be initialized either from environment variables (legacy) or
 * dynamically from request params (appId, uid, token, channel).
 */

const logger = {
  info: (message) => console.log(`INFO: [RTM] ${message}`),
  debug: (message) => console.log(`DEBUG: [RTM] ${message}`),
  error: (message, error) => console.error(`ERROR: [RTM] ${message}`, error),
  warn: (message) => console.warn(`WARN: [RTM] ${message}`),
};

let rtmClient = null;
let defaultChannel = null;
let subscribedChannels = new Set();
let messageHandlers = [];
let reconnectAttempts = 0;
let lastInitParams = null;
const MAX_RECONNECT_ATTEMPTS = 10;
const BASE_RECONNECT_DELAY = 2000;
const MAX_RECONNECT_DELAY = 60000;

/**
 * Initialize RTM from environment variables. Returns the client or null.
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

  return _initWithParams(appId, userId, token, channel);
}

/**
 * Initialize RTM from explicit parameters (e.g. from ConvoAI request).
 * Idempotent — if already connected, subscribes to the new channel.
 */
async function initRTMWithParams(appId, uid, token, channel) {
  if (!appId || !uid) {
    logger.debug('Missing appId or uid for RTM init');
    return null;
  }

  // Already connected — just subscribe to the channel if new
  if (rtmClient && channel && !subscribedChannels.has(channel)) {
    try {
      await rtmClient.subscribe(channel);
      subscribedChannels.add(channel);
      logger.info(`Subscribed to additional channel: ${channel}`);
    } catch (e) {
      logger.error(`Failed to subscribe to channel ${channel}:`, e);
    }
    return rtmClient;
  }

  if (rtmClient) {
    return rtmClient; // Already connected and channel already subscribed
  }

  return _initWithParams(appId, uid, token, channel);
}

async function _initWithParams(appId, userId, token, channel) {
  lastInitParams = { appId, userId, token, channel };

  try {
    const AgoraRTM = require('rtm-nodejs');

    // rtm-nodejs requires token in constructor config (not in login() args)
    const rtmConfig = token ? { token } : {};
    rtmClient = new AgoraRTM.RTM(appId, userId, rtmConfig);

    await rtmClient.login();
    logger.info(`Logged in as ${userId}`);

    if (channel) {
      await rtmClient.subscribe(channel);
      subscribedChannels.add(channel);
      defaultChannel = channel;
      logger.info(`Subscribed to channel: ${channel}`);
    }

    setupEventListeners(appId, userId);

    reconnectAttempts = 0;
    return rtmClient;
  } catch (error) {
    logger.error('Failed to initialize RTM:', error);
    rtmClient = null;
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
      scheduleReconnection();
    } else if (event.state === 'CONNECTED') {
      reconnectAttempts = 0;
    }
  });

  rtmClient.addEventListener('error', (error) => {
    logger.error(`RTM error: ${error.message || error}`, error);
  });
}

function scheduleReconnection() {
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
      try {
        if (rtmClient) await rtmClient.logout();
      } catch (e) {
        // ignore
      }
      rtmClient = null;
      subscribedChannels.clear();

      if (lastInitParams) {
        const result = await _initWithParams(
          lastInitParams.appId,
          lastInitParams.userId,
          lastInitParams.token,
          lastInitParams.channel
        );
        if (result) {
          logger.info('Reconnected successfully');
        } else {
          scheduleReconnection();
        }
      }
    } catch (error) {
      logger.error('Reconnection failed:', error);
      scheduleReconnection();
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

  const targetChannel = channel || defaultChannel;
  if (!targetChannel) {
    logger.warn('No channel specified for RTM message');
    return false;
  }

  // Auto-subscribe if not yet subscribed
  if (!subscribedChannels.has(targetChannel)) {
    try {
      await rtmClient.subscribe(targetChannel);
      subscribedChannels.add(targetChannel);
      logger.info(`Auto-subscribed to channel: ${targetChannel}`);
    } catch (e) {
      logger.error(`Failed to subscribe to ${targetChannel}:`, e);
    }
  }

  try {
    await rtmClient.publish(targetChannel, message);
    logger.debug(`Message sent to ${targetChannel}`);
    return true;
  } catch (error) {
    logger.error('Failed to send RTM message:', error);
    return false;
  }
}

/**
 * Check if RTM is connected.
 */
function isConnected() {
  return rtmClient !== null;
}

/**
 * Register a handler for incoming RTM messages.
 */
function onRTMMessage(callback) {
  messageHandlers.push(callback);
}

module.exports = {
  initRTM,
  initRTMWithParams,
  sendRTMMessage,
  onRTMMessage,
  isConnected,
};
