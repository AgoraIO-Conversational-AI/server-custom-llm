const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const dotenv = require('dotenv');
const OpenAI = require('openai');
const fs = require('fs').promises;
const { randomUUID } = require('crypto');

const {
  TOOL_DEFINITIONS,
  TOOL_MAP,
  performRagRetrieval,
  refactMessages,
} = require('./tools');
const {
  saveMessage,
  getMessages,
} = require('./conversation_store');

// Load environment variables
dotenv.config();

// Env var standardization with backward-compatible fallbacks
const LLM_API_KEY =
  process.env.LLM_API_KEY ||
  process.env.YOUR_LLM_API_KEY ||
  process.env.OPENAI_API_KEY ||
  '';
const LLM_BASE_URL = process.env.LLM_BASE_URL || 'https://api.openai.com/v1';
const LLM_MODEL = process.env.LLM_MODEL || 'gpt-4o-mini';

// Initialize OpenAI client
const openai = new OpenAI({
  apiKey: LLM_API_KEY,
  baseURL: LLM_BASE_URL,
});

// Initialize Express app
const app = express();
const port = process.env.PORT || 8101;

// Configure logging
const logger = {
  info: (message) => console.log(`INFO: ${message}`),
  debug: (message) => console.log(`DEBUG: ${message}`),
  error: (message, error) => console.error(`ERROR: ${message}`, error),
};

// Middleware
app.use(cors());
app.use(morgan('dev'));
app.use(express.json());

// Health check endpoint
app.get('/ping', (req, res) => {
  res.json({ message: 'pong' });
});

// Root endpoint
app.get('/', (req, res) => {
  res.json({
    message: 'Welcome to a simple Custom LLM server for Agora Convo AI Engine!',
    endpoints: [
      '/chat/completions',
      '/rag/chat/completions',
      '/audio/chat/completions',
    ],
  });
});

// ─── Helpers ───

function extractContext(body) {
  const ctx = body.context || {};
  return {
    appId: ctx.appId || '',
    userId: ctx.userId || '',
    channel: ctx.channel || 'default',
  };
}

function getToolsForRequest(requestTools) {
  if (requestTools && requestTools.length > 0) return requestTools;
  return TOOL_DEFINITIONS;
}

function buildMessagesWithHistory(appId, userId, channel, requestMessages) {
  const history = getMessages(appId, userId, channel);
  const incoming = Array.isArray(requestMessages) ? requestMessages : [];

  // Save incoming user messages
  for (const msg of incoming) {
    if (msg.role === 'user') {
      saveMessage(appId, userId, channel, msg);
    }
  }

  return [...history, ...incoming];
}

/**
 * Accumulate streaming tool call fragments.
 */
function accumulateToolCalls(accumulated, deltaToolCalls) {
  for (const tc of deltaToolCalls) {
    const idx = tc.index ?? 0;
    while (accumulated.length <= idx) accumulated.push({});

    const entry = accumulated[idx];
    if (tc.id) entry.id = tc.id;
    if (tc.type) entry.type = tc.type;
    if (!entry.function) entry.function = {};

    const fn = tc.function || {};
    if (fn.name) entry.function.name = fn.name;
    if (fn.arguments != null) {
      entry.function.arguments =
        (entry.function.arguments || '') + fn.arguments;
    }
  }
  return accumulated;
}

/**
 * Execute tool calls and return tool result messages.
 */
function executeTools(toolCalls, appId, userId, channel) {
  const results = [];
  for (const tc of toolCalls) {
    const name = tc.function?.name || '';
    const argsStr = tc.function?.arguments || '{}';
    const tcId = tc.id || '';

    const fn = TOOL_MAP[name];
    if (!fn) {
      logger.error(`Unknown tool: ${name}`);
      results.push({
        role: 'tool',
        tool_call_id: tcId,
        name,
        content: `Error: unknown tool '${name}'`,
      });
      continue;
    }

    let args = {};
    try {
      args = JSON.parse(argsStr);
    } catch (e) {
      // ignore parse errors
    }

    try {
      const result = fn(appId, userId, channel, args);
      results.push({ role: 'tool', tool_call_id: tcId, name, content: result });
    } catch (e) {
      logger.error(`Tool execution error (${name}):`, e);
      results.push({
        role: 'tool',
        tool_call_id: tcId,
        name,
        content: `Error executing ${name}: ${e.message}`,
      });
    }
  }
  return results;
}

// ─── Chat Completions Endpoint ───

app.post('/chat/completions', async (req, res) => {
  try {
    logger.info(`Received request: ${JSON.stringify(req.body)}`);

    const {
      model = LLM_MODEL,
      messages: requestMessages,
      modalities = ['text'],
      tools: requestTools,
      tool_choice,
      response_format,
      audio,
      stream = true,
      stream_options,
      context,
    } = req.body;

    if (!requestMessages) {
      return res
        .status(400)
        .json({ detail: 'Missing messages in request body' });
    }

    const { appId, userId, channel } = extractContext(req.body);
    const tools = getToolsForRequest(requestTools);
    let messages = buildMessagesWithHistory(
      appId,
      userId,
      channel,
      requestMessages
    );

    if (!stream) {
      // ── Non-streaming with multi-pass tool execution ──
      let finalResponse = null;
      for (let pass = 0; pass < 5; pass++) {
        const response = await openai.chat.completions.create({
          model,
          messages,
          tools: tools.length ? tools : undefined,
          tool_choice: tools.length && tool_choice ? tool_choice : undefined,
        });

        finalResponse = response;
        const choice = response.choices[0];

        if (!choice.message.tool_calls || !choice.message.tool_calls.length) {
          const content = choice.message.content || '';
          if (content) {
            saveMessage(appId, userId, channel, {
              role: 'assistant',
              content,
            });
          }
          return res.json(response);
        }

        // Execute tools
        const assistantMsg = {
          role: 'assistant',
          content: choice.message.content || '',
          tool_calls: choice.message.tool_calls,
        };
        messages.push(assistantMsg);
        saveMessage(appId, userId, channel, assistantMsg);

        const toolResults = executeTools(
          choice.message.tool_calls,
          appId,
          userId,
          channel
        );
        for (const tr of toolResults) {
          messages.push(tr);
          saveMessage(appId, userId, channel, tr);
        }
      }

      return res.json(finalResponse);
    }

    // ── Streaming with tool execution ──
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    let currentMessages = [...messages];

    for (let pass = 0; pass < 5; pass++) {
      const completion = await openai.chat.completions.create({
        model,
        messages: currentMessages,
        tools: tools.length ? tools : undefined,
        tool_choice: tools.length && tool_choice ? tool_choice : undefined,
        response_format,
        stream: true,
      });

      let accumulatedToolCalls = [];
      let accumulatedContent = '';
      let finishReason = null;

      for await (const chunk of completion) {
        const delta = chunk.choices?.[0]?.delta;
        finishReason = chunk.choices?.[0]?.finish_reason;

        if (delta?.tool_calls) {
          accumulatedToolCalls = accumulateToolCalls(
            accumulatedToolCalls,
            delta.tool_calls
          );
          // Don't send tool call chunks to client
          continue;
        }

        if (delta?.content) {
          accumulatedContent += delta.content;
        }

        // Send non-tool chunks to client
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      }

      if (
        finishReason === 'tool_calls' &&
        accumulatedToolCalls.length > 0
      ) {
        // Execute tools and loop
        const assistantMsg = {
          role: 'assistant',
          content: accumulatedContent || '',
          tool_calls: accumulatedToolCalls,
        };
        currentMessages.push(assistantMsg);
        saveMessage(appId, userId, channel, assistantMsg);

        const toolResults = executeTools(
          accumulatedToolCalls,
          appId,
          userId,
          channel
        );
        for (const tr of toolResults) {
          currentMessages.push(tr);
          saveMessage(appId, userId, channel, tr);
        }
        continue;
      }

      // No tool calls — save and end
      if (accumulatedContent) {
        saveMessage(appId, userId, channel, {
          role: 'assistant',
          content: accumulatedContent,
        });
      }
      break;
    }

    res.write('data: [DONE]\n\n');
    res.end();
  } catch (error) {
    logger.error('Chat completion error:', error);

    if (!res.headersSent) {
      const errorDetail = `${error.message}\n${error.stack || ''}`;
      return res.status(500).json({ detail: errorDetail });
    }

    res.write(`data: ${JSON.stringify({ error: error.message })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  }
});

// Waiting messages for RAG
const waitingMessages = [
  "Just a moment, I'm thinking...",
  'Let me think about that for a second...',
  'Good question, let me find out...',
];

// ─── RAG-enhanced Chat Completions ───

app.post('/rag/chat/completions', async (req, res) => {
  try {
    logger.info(`Received RAG request: ${JSON.stringify(req.body)}`);

    const {
      model = LLM_MODEL,
      messages: requestMessages,
      modalities = ['text'],
      tools: requestTools,
      tool_choice,
      response_format,
      audio,
      stream = true,
      stream_options,
    } = req.body;

    if (!requestMessages) {
      return res
        .status(400)
        .json({ detail: 'Missing messages in request body' });
    }

    if (!stream) {
      return res
        .status(400)
        .json({ detail: 'chat completions require streaming' });
    }

    const { appId, userId, channel } = extractContext(req.body);

    // Set SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    // Send waiting message
    const waitingMessage = {
      id: 'waiting_msg',
      choices: [
        {
          index: 0,
          delta: {
            role: 'assistant',
            content:
              waitingMessages[
                Math.floor(Math.random() * waitingMessages.length)
              ],
          },
          finish_reason: null,
        },
      ],
    };
    res.write(`data: ${JSON.stringify(waitingMessage)}\n\n`);

    // Build messages with history
    let messages = buildMessagesWithHistory(
      appId,
      userId,
      channel,
      requestMessages
    );

    // Perform RAG retrieval
    const retrievedContext = performRagRetrieval(messages);

    // Adjust messages with context
    const ragMessages = refactMessages(retrievedContext, messages);

    // Create streaming completion
    const completion = await openai.chat.completions.create({
      model,
      messages: ragMessages,
      tools: requestTools ? requestTools : undefined,
      tool_choice:
        requestTools && tool_choice ? tool_choice : undefined,
      response_format,
      stream: true,
    });

    let accumulatedContent = '';

    for await (const chunk of completion) {
      const delta = chunk.choices?.[0]?.delta;
      if (delta?.content) {
        accumulatedContent += delta.content;
      }
      res.write(`data: ${JSON.stringify(chunk)}\n\n`);
    }

    // Save assistant response
    if (accumulatedContent) {
      saveMessage(appId, userId, channel, {
        role: 'assistant',
        content: accumulatedContent,
      });
    }

    res.write('data: [DONE]\n\n');
    res.end();
  } catch (error) {
    logger.error('RAG chat completion error:', error);

    if (!res.headersSent) {
      const errorDetail = `${error.message}\n${error.stack || ''}`;
      return res.status(500).json({ detail: errorDetail });
    }

    res.write(`data: ${JSON.stringify({ error: error.message })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  }
});

// ─── File helpers ───

async function readTextFile(filePath) {
  try {
    const content = await fs.readFile(filePath, 'utf8');
    return content;
  } catch (error) {
    logger.error(`Failed to read text file: ${filePath}`, error);
    throw error;
  }
}

async function readPCMFile(filePath, sampleRate, durationMs) {
  try {
    const content = await fs.readFile(filePath);
    const chunkSize = Math.floor(sampleRate * 2 * (durationMs / 1000));
    const chunks = [];
    for (let i = 0; i < content.length; i += chunkSize) {
      chunks.push(content.slice(i, i + chunkSize));
    }
    return chunks;
  } catch (error) {
    logger.error(`Failed to read PCM file: ${filePath}`, error);
    throw error;
  }
}

// ─── Audio Chat Completions ───

app.post('/audio/chat/completions', async (req, res) => {
  try {
    logger.info(`Received audio request: ${JSON.stringify(req.body)}`);

    const { stream = true } = req.body;

    if (!req.body.messages) {
      return res
        .status(400)
        .json({ detail: 'Missing messages in request body' });
    }

    if (!stream) {
      return res
        .status(400)
        .json({ detail: 'chat completions require streaming' });
    }

    // Set SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const textFilePath = './file.txt';
    const pcmFilePath = './file.pcm';
    const sampleRate = 16000;
    const durationMs = 40;

    try {
      const textContent = await readTextFile(textFilePath);
      const audioChunks = await readPCMFile(
        pcmFilePath,
        sampleRate,
        durationMs
      );

      const audioId = randomUUID();

      const textMessage = {
        id: randomUUID(),
        choices: [
          {
            index: 0,
            delta: {
              audio: { id: audioId, transcript: textContent },
            },
            finish_reason: null,
          },
        ],
      };
      res.write(`data: ${JSON.stringify(textMessage)}\n\n`);

      for (const chunk of audioChunks) {
        const audioMessage = {
          id: randomUUID(),
          choices: [
            {
              index: 0,
              delta: {
                audio: { id: audioId, data: chunk.toString('base64') },
              },
              finish_reason: null,
            },
          ],
        };
        res.write(`data: ${JSON.stringify(audioMessage)}\n\n`);
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    } catch (fileError) {
      logger.error(
        'Error reading audio files, using simulated response',
        fileError
      );

      const audioId = randomUUID();
      const simulatedTranscript =
        "This is a simulated audio response because actual audio files weren't found.";

      const textMessage = {
        id: randomUUID(),
        choices: [
          {
            index: 0,
            delta: {
              audio: { id: audioId, transcript: simulatedTranscript },
            },
            finish_reason: null,
          },
        ],
      };
      res.write(`data: ${JSON.stringify(textMessage)}\n\n`);

      for (let i = 0; i < 5; i++) {
        const randomData = Buffer.from(
          Array(40)
            .fill(0)
            .map(() => Math.floor(Math.random() * 256))
        );
        const audioMessage = {
          id: randomUUID(),
          choices: [
            {
              index: 0,
              delta: {
                audio: { id: audioId, data: randomData.toString('base64') },
              },
              finish_reason: null,
            },
          ],
        };
        res.write(`data: ${JSON.stringify(audioMessage)}\n\n`);
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }

    res.write('data: [DONE]\n\n');
    res.end();
  } catch (error) {
    logger.error('Audio chat completion error:', error);

    if (!res.headersSent) {
      const errorDetail = `${error.message}\n${error.stack || ''}`;
      return res.status(500).json({ detail: errorDetail });
    }

    res.write(`data: ${JSON.stringify({ error: error.message })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  }
});

// ─── RTM Integration (optional) ───

let rtmClient = null;

async function initRTM() {
  try {
    const rtm = require('./rtm_client');
    rtmClient = await rtm.initRTM();
    if (rtmClient) {
      rtm.onRTMMessage(handleRTMMessage);
      logger.info('RTM integration enabled');
    }
  } catch (e) {
    // rtm_client.js or rtm-nodejs not available — skip silently
    logger.debug('RTM not available (optional): ' + e.message);
  }
}

async function handleRTMMessage(event) {
  try {
    const messageText =
      typeof event.message === 'string'
        ? event.message
        : event.message?.toString?.() || '';
    const channelName = event.channelName || 'default';
    const publisherUserId = event.publisher || 'unknown';

    logger.info(
      `RTM message from ${publisherUserId} on ${channelName}: ${messageText}`
    );

    // Use a default appId from env for RTM conversations
    const appId = process.env.AGORA_APP_ID || '';

    // Build messages with history
    const messages = buildMessagesWithHistory(appId, publisherUserId, channelName, [
      { role: 'user', content: messageText },
    ]);

    const tools = TOOL_DEFINITIONS;

    // Multi-pass non-streaming tool execution
    let currentMessages = [...messages];
    let finalContent = '';

    for (let pass = 0; pass < 5; pass++) {
      const response = await openai.chat.completions.create({
        model: LLM_MODEL,
        messages: currentMessages,
        tools: tools.length ? tools : undefined,
      });

      const choice = response.choices[0];

      if (!choice.message.tool_calls || !choice.message.tool_calls.length) {
        finalContent = choice.message.content || '';
        break;
      }

      // Execute tools
      const assistantMsg = {
        role: 'assistant',
        content: choice.message.content || '',
        tool_calls: choice.message.tool_calls,
      };
      currentMessages.push(assistantMsg);
      saveMessage(appId, publisherUserId, channelName, assistantMsg);

      const toolResults = executeTools(
        choice.message.tool_calls,
        appId,
        publisherUserId,
        channelName
      );
      for (const tr of toolResults) {
        currentMessages.push(tr);
        saveMessage(appId, publisherUserId, channelName, tr);
      }
    }

    // Save and send response
    if (finalContent) {
      saveMessage(appId, publisherUserId, channelName, {
        role: 'assistant',
        content: finalContent,
      });

      // Send response back via RTM
      try {
        const rtm = require('./rtm_client');
        await rtm.sendRTMMessage(channelName, finalContent);
      } catch (e) {
        logger.error('Failed to send RTM response:', e);
      }
    }
  } catch (error) {
    logger.error('RTM message handler error:', error);
  }
}

// Start server
app.listen(port, () => {
  logger.info(`Server running on port ${port}`);

  // Initialize RTM (non-blocking, optional)
  initRTM();
});
