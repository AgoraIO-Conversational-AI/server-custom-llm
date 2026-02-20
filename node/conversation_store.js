/**
 * In-memory conversation store for the Custom LLM Server.
 *
 * Stores conversations keyed by appId:userId:channel. Includes automatic
 * trimming when conversations exceed MAX_MESSAGES and periodic cleanup
 * of stale conversations.
 */

const logger = {
  info: (message) => console.log(`INFO: ${message}`),
  debug: (message) => console.log(`DEBUG: ${message}`),
  error: (message, error) => console.error(`ERROR: ${message}`, error),
};

// Limits
const MAX_MESSAGES = 100;
const TARGET_MESSAGES = 75;
const CLEANUP_INTERVAL = 3600 * 1000; // 1 hour in ms
const MAX_AGE = 86400 * 1000; // 24 hours in ms

// In-memory store: key -> { messages: [...], lastUpdated: timestamp }
const conversations = {};

function getConversationKey(appId, userId, channel) {
  return `${appId}:${userId}:${channel}`;
}

function getOrCreateConversation(appId, userId, channel) {
  const key = getConversationKey(appId, userId, channel);
  if (!conversations[key]) {
    logger.info(`Creating new conversation: ${key}`);
    conversations[key] = {
      messages: [],
      lastUpdated: Date.now(),
    };
  }
  return conversations[key];
}

/**
 * Append a message to the conversation and trim if necessary.
 *
 * message should be an object with at least { role, content }.
 * Tool messages should also have tool_call_id and name.
 * Assistant tool_call messages should have tool_calls.
 */
function saveMessage(appId, userId, channel, message) {
  const conv = getOrCreateConversation(appId, userId, channel);
  const msg = { ...message, timestamp: Date.now() };
  conv.messages.push(msg);
  conv.lastUpdated = Date.now();

  if (conv.messages.length > MAX_MESSAGES) {
    trimConversation(conv);
  }

  logger.debug(
    `Saved ${message.role} message, total=${conv.messages.length} [${appId}:${userId}:${channel}]`
  );
}

/**
 * Return a copy of the conversation messages.
 */
function getMessages(appId, userId, channel) {
  const conv = getOrCreateConversation(appId, userId, channel);
  return [...conv.messages];
}

/**
 * Trim a conversation to TARGET_MESSAGES, preserving:
 * 1. All system messages
 * 2. Tool call pairs (assistant with tool_calls + tool response)
 * 3. Most recent non-system messages
 */
function trimConversation(conv) {
  const messages = conv.messages;
  const systemMsgs = messages.filter((m) => m.role === 'system');
  const nonSystem = messages.filter((m) => m.role !== 'system');

  // Keep the most recent TARGET_MESSAGES non-system messages
  let kept = nonSystem.slice(-TARGET_MESSAGES);

  // Collect tool_call IDs that are in kept messages
  const toolCallIds = new Set();
  for (const m of kept) {
    if (m.role === 'tool' && m.tool_call_id) {
      toolCallIds.add(m.tool_call_id);
    }
    if (m.role === 'assistant' && m.tool_calls) {
      for (const tc of m.tool_calls) {
        if (tc.id) toolCallIds.add(tc.id);
      }
    }
  }

  // Add orphaned pair messages
  for (const m of nonSystem) {
    if (kept.includes(m)) continue;
    if (m.role === 'assistant' && m.tool_calls) {
      for (const tc of m.tool_calls) {
        if (tc.id && toolCallIds.has(tc.id)) {
          kept.unshift(m);
          break;
        }
      }
    } else if (m.role === 'tool' && toolCallIds.has(m.tool_call_id)) {
      kept.unshift(m);
    }
  }

  // Sort by timestamp
  kept.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));

  conv.messages = [...systemMsgs, ...kept];
  logger.debug(
    `Trimmed conversation: ${messages.length} -> ${conv.messages.length}`
  );
}

/**
 * Remove conversations older than MAX_AGE.
 */
function cleanupOldConversations() {
  const now = Date.now();
  let removed = 0;
  for (const key of Object.keys(conversations)) {
    if (now - conversations[key].lastUpdated > MAX_AGE) {
      delete conversations[key];
      removed++;
    }
  }
  if (removed) {
    logger.info(`Cleaned up ${removed} old conversation(s)`);
  }
}

// Start periodic cleanup
const cleanupTimer = setInterval(() => {
  try {
    cleanupOldConversations();
  } catch (e) {
    logger.error('Cleanup error:', e);
  }
}, CLEANUP_INTERVAL);

// Don't let the timer prevent process exit
if (cleanupTimer.unref) {
  cleanupTimer.unref();
}

logger.info(
  `Conversation store initialized (max=${MAX_MESSAGES}, target=${TARGET_MESSAGES}, cleanup every ${CLEANUP_INTERVAL / 1000}s)`
);

module.exports = {
  getOrCreateConversation,
  saveMessage,
  getMessages,
  cleanupOldConversations,
};
