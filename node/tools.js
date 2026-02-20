/**
 * Tool definitions, RAG data, and tool implementations for the Custom LLM Server.
 *
 * Add your own tools by:
 * 1. Adding a schema to TOOL_DEFINITIONS
 * 2. Implementing a handler function with signature (appId, userId, channel, args) => string
 * 3. Registering the handler in TOOL_MAP
 */

const logger = {
  info: (message) => console.log(`INFO: ${message}`),
  debug: (message) => console.log(`DEBUG: ${message}`),
  error: (message, error) => console.error(`ERROR: ${message}`, error),
};

// Sample knowledge base for RAG retrieval
const RAG_DATA = {
  agora_convoai:
    'Agora Conversational AI enables real-time voice and video AI agents. ' +
    'It connects to LLM providers through a Custom LLM server, supports ' +
    'tool calling, and provides sub-second voice interactions. Agents join ' +
    'Agora RTC channels and communicate with users via voice, video, or text.',
  custom_llm:
    'A Custom LLM server intercepts requests between Agora ConvoAI and your ' +
    'LLM provider. It receives OpenAI-compatible chat completion requests, ' +
    'can modify messages, inject RAG context, execute tools server-side, ' +
    'and route to different models. Responses stream back as Server-Sent Events.',
  agora_rtm:
    'Agora Real-Time Messaging (RTM) provides low-latency text messaging ' +
    'between users and AI agents. RTM channels allow the Custom LLM server ' +
    'to receive and send text messages alongside voice/video interactions.',
  tool_calling:
    'Tool calling lets LLMs invoke external functions during a conversation. ' +
    'The model returns a tool_calls response, the server executes the function, ' +
    'and sends the result back to the model for a final answer. This enables ' +
    'weather lookups, calculations, database queries, and more.',
};

// OpenAI-compatible tool schemas
const TOOL_DEFINITIONS = [
  {
    type: 'function',
    function: {
      name: 'get_weather',
      description: 'Get the current weather for a given location',
      parameters: {
        type: 'object',
        properties: {
          location: {
            type: 'string',
            description: "City name, e.g. 'Tokyo' or 'San Francisco'",
          },
        },
        required: ['location'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'calculate',
      description: 'Evaluate a mathematical expression and return the result',
      parameters: {
        type: 'object',
        properties: {
          expression: {
            type: 'string',
            description: "Math expression to evaluate, e.g. '42 * 17'",
          },
        },
        required: ['expression'],
      },
    },
  },
];

/**
 * Simulated weather lookup. Replace with a real weather API call.
 */
function getWeather(appId, userId, channel, args) {
  const location = args.location || 'Unknown';
  logger.info(`get_weather called for location=${location}`);
  return `Weather in ${location}: 72°F (22°C), partly cloudy, humidity 45%`;
}

/**
 * Safe math expression evaluator.
 */
function calculate(appId, userId, channel, args) {
  const expression = args.expression || '0';
  logger.info(`calculate called with expression=${expression}`);
  try {
    // Restrict to safe math operations
    const sanitized = expression.replace(/[^0-9+\-*/().%\s]/g, '');
    if (sanitized !== expression) {
      return `Error: expression contains invalid characters`;
    }
    const result = Function('"use strict"; return (' + sanitized + ')')();
    return `Result: ${result}`;
  } catch (e) {
    return `Error evaluating '${expression}': ${e.message}`;
  }
}

// Map tool names to handler functions
const TOOL_MAP = {
  get_weather: getWeather,
  calculate: calculate,
};

/**
 * Simple keyword-based RAG retrieval from RAG_DATA.
 *
 * Finds the last user message and matches keywords (>3 chars) against
 * the knowledge base entries.
 */
function performRagRetrieval(messages) {
  let query = '';

  if (Array.isArray(messages)) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.role === 'user' && msg.content) {
        query = String(msg.content).toLowerCase();
        break;
      }
    }
  }

  if (!query) return '';

  const keywords = query.split(/\s+/).filter((w) => w.length > 3);
  if (!keywords.length) return '';

  const relevant = [];
  for (const [, value] of Object.entries(RAG_DATA)) {
    const valueLower = value.toLowerCase();
    if (keywords.some((word) => valueLower.includes(word))) {
      relevant.push(value);
    }
  }

  return relevant.length > 0
    ? relevant.join('\n\n')
    : 'No relevant information found.';
}

/**
 * Inject retrieved RAG context as a system message prepended to the
 * message list. If context is empty or not found, returns messages unchanged.
 */
function refactMessages(context, messages) {
  if (!context || context === 'No relevant information found.') {
    return messages;
  }

  const contextMsg = {
    role: 'system',
    content: `Use this knowledge to answer the user's question:\n${context}`,
  };

  return [contextMsg, ...messages];
}

module.exports = {
  RAG_DATA,
  TOOL_DEFINITIONS,
  TOOL_MAP,
  performRagRetrieval,
  refactMessages,
};
