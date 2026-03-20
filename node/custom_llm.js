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
const { AudioSubscriber } = require('./audio_subscriber');

// Load environment variables
dotenv.config();

// Env var fallback defaults (used when request doesn't provide credentials)
const DEFAULT_LLM_API_KEY =
  process.env.LLM_API_KEY ||
  process.env.YOUR_LLM_API_KEY ||
  process.env.OPENAI_API_KEY ||
  '';
const DEFAULT_LLM_BASE_URL = process.env.LLM_BASE_URL || 'https://api.openai.com/v1';
const DEFAULT_LLM_MODEL = process.env.LLM_MODEL || 'gpt-4o-mini';

/**
 * Get an OpenAI client for this request.
 * Uses API key from request headers if provided, otherwise falls back to env.
 */
function getOpenAIClient(req) {
  const authHeader = req.headers['authorization'] || '';
  const bearerKey = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  const apiKey = bearerKey || DEFAULT_LLM_API_KEY;
  return new OpenAI({
    apiKey,
    baseURL: DEFAULT_LLM_BASE_URL,
  });
}

// Default client for RTM and other non-request contexts
const openai = new OpenAI({
  apiKey: DEFAULT_LLM_API_KEY,
  baseURL: DEFAULT_LLM_BASE_URL,
});

// ─── Module registration ───

const THYMIA_ENABLED = process.env.THYMIA_ENABLED === 'true';
const modules = [];
const audioSubscriber = new AudioSubscriber();

if (THYMIA_ENABLED) {
  const thymiaModule = require('./integrations/thymia/thymia');
  thymiaModule.init(audioSubscriber, { rtmClient: () => rtmClient });
  modules.push(thymiaModule);
}

const SHEN_ENABLED = process.env.SHEN_ENABLED === 'true';
if (SHEN_ENABLED) {
  const shenModule = require('./integrations/shen/shen');
  shenModule.init(audioSubscriber, { rtmClient: () => rtmClient });
  modules.push(shenModule);
}

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

// ─── Agent Registry (appId:channel → agentId + auth) ───
const agentRegistry = new Map();

function registerAgent(appId, channel, agentId, authHeader, agentEndpoint) {
  const key = `${appId}:${channel}`;
  agentRegistry.set(key, { agentId, authHeader, agentEndpoint, registeredAt: Date.now() });
  logger.info(`[AgentRegistry] registered ${key} → agent=${agentId}`);
}

function unregisterAgent(appId, channel) {
  const key = `${appId}:${channel}`;
  const entry = agentRegistry.get(key);
  if (entry) {
    agentRegistry.delete(key);
    logger.info(`[AgentRegistry] unregistered ${key} (agent=${entry.agentId})`);
  }
  return entry;
}

function getAgent(appId, channel) {
  return agentRegistry.get(`${appId}:${channel}`) || null;
}

// Root endpoint
app.get('/', (req, res) => {
  res.json({
    message: 'Welcome to a simple Custom LLM server for Agora Convo AI Engine!',
    endpoints: [
      '/chat/completions',
      '/rag/chat/completions',
      '/audio/chat/completions',
      '/register-agent',
      '/unregister-agent',
    ],
  });
});

// ─── Agent Registration Endpoint ───
// Called by simple-backend after successful join to map appId+channel → agentId
app.post('/register-agent', (req, res) => {
  const { app_id, channel, agent_id, auth_header, agent_endpoint, prompt,
          user_uid, subscriber_token, rtm_token, rtm_uid, thymia_api_key } = req.body;
  if (!app_id || !channel || !agent_id) {
    logger.error('[RegisterAgent] missing required fields: app_id, channel, agent_id');
    return res.status(400).json({ error: 'Missing app_id, channel, or agent_id' });
  }
  registerAgent(app_id, channel, agent_id, auth_header, agent_endpoint);
  logger.info(`[RegisterAgent] prompt_len=${(prompt || '').length} has_tokens=${!!subscriber_token}`);
  // Notify modules about the agent registration (include early-start params)
  const earlyParams = { user_uid, subscriber_token, rtm_token, rtm_uid, thymia_api_key };
  for (const mod of modules) {
    if (mod.onAgentRegistered) {
      mod.onAgentRegistered(app_id, channel, agent_id, auth_header, agent_endpoint, prompt, earlyParams);
    }
  }
  res.json({ success: true, key: `${app_id}:${channel}`, agent_id });
});

// ─── Agent Unregistration Endpoint ───
// Called by simple-backend on hangup to clean up audio subscriber + modules
app.post('/unregister-agent', (req, res) => {
  const { app_id, channel } = req.body;
  if (!app_id || !channel) {
    logger.error('[UnregisterAgent] missing required fields: app_id, channel');
    return res.status(400).json({ error: 'Missing app_id or channel' });
  }

  const entry = unregisterAgent(app_id, channel);
  if (!entry) {
    logger.info(`[UnregisterAgent] no agent registered for ${app_id}:${channel}`);
    return res.json({ success: true, message: 'No agent was registered for this channel' });
  }

  // Stop audio subscriber session for this channel
  audioSubscriber.stopSession(app_id, channel);

  // Destroy RTM session for this channel
  try {
    const rtm = require('./rtm_client');
    rtm.destroySession(channel).catch((e) => {
      logger.error(`[UnregisterAgent] RTM destroy error: ${e.message}`);
    });
  } catch (e) {
    // rtm_client not available
  }

  // Notify modules (e.g. Thymia disconnect)
  for (const mod of modules) {
    if (mod.onAgentUnregistered) {
      mod.onAgentUnregistered(app_id, channel, entry.agentId);
    }
  }

  logger.info(`[UnregisterAgent] cleaned up ${app_id}:${channel} (agent=${entry.agentId})`);
  res.json({ success: true, agent_id: entry.agentId });
});

// ─── Helpers ───

function extractContext(body) {
  const ctx = body.context || {};

  // ConvoAI custom vendor sends RTC params in the model params
  // which appear at the top level of the request body
  const appId = body.app_id || ctx.appId || process.env.AGORA_APP_ID || '';
  const channel = body.channel || ctx.channel || '';
  const userId = body.user_uid || ctx.userId || '';
  const agentUid = body.agent_uid || '';
  const subscriberToken = body.subscriber_token || '';
  const rtmToken = body.rtm_token || '';
  const rtmUid = body.rtm_uid || '';

  const thymiaApiKey = body.thymia_api_key || '';

  return { appId, userId, channel: channel || 'default', agentUid, subscriberToken, rtmToken, rtmUid, thymiaApiKey };
}

/**
 * Aggregate tool definitions from base tools + all modules.
 */
function getToolsForRequest(requestTools) {
  if (requestTools && requestTools.length > 0) return requestTools;
  const tools = [...TOOL_DEFINITIONS];
  for (const mod of modules) {
    if (mod.getToolDefinitions) {
      tools.push(...mod.getToolDefinitions());
    }
  }
  return tools;
}

/**
 * Build merged tool handler map from base tools + all modules.
 */
function getMergedToolMap() {
  const merged = { ...TOOL_MAP };
  for (const mod of modules) {
    if (mod.getToolHandlers) {
      Object.assign(merged, mod.getToolHandlers());
    }
  }
  return merged;
}

const mergedToolMap = getMergedToolMap();

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

    const fn = mergedToolMap[name];
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
    // Log non-message fields to see what engine forwards
    const { messages: _msgs, ...reqMeta } = req.body;
    logger.info(`Request meta (non-messages): ${JSON.stringify(reqMeta)}`);

    const {
      model = DEFAULT_LLM_MODEL,
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

    const { appId, userId, channel, agentUid, subscriberToken, rtmToken, rtmUid, thymiaApiKey } = extractContext(req.body);
    const client = getOpenAIClient(req);

    logger.info(`Context: appId=${appId}, userId=${userId}, channel=${channel}, model=${model} thymia_key_in_params=${thymiaApiKey ? 'yes' : 'no'}`);

    // Initialize RTM session for this channel (idempotent — creates once per channel)
    if (appId && channel && channel !== 'default' && rtmUid) {
      const rtm = require('./rtm_client');
      rtm.initRTMWithParams(appId, rtmUid, rtmToken, channel).catch((e) => {
        logger.error('RTM init from params failed:', e);
      });
    }

    // Module onRequest hooks (auto-start audio, connect services, forward transcripts)
    const moduleCtx = { appId, userId, channel, agentUid, subscriberToken, thymiaApiKey, messages: requestMessages, req };
    for (const mod of modules) {
      if (mod.onRequest) mod.onRequest(moduleCtx);
    }

    // GPT-5.x reasoning models use max_completion_tokens instead of max_tokens
    // and don't support temperature
    const isReasoningModel = model && model.toLowerCase().startsWith('gpt-5');

    const tools = getToolsForRequest(requestTools);
    let messages = buildMessagesWithHistory(
      appId,
      userId,
      channel,
      requestMessages
    );

    // Inject system messages from modules (e.g. biomarker context)
    // Insert after the first system message (the prompt) so the LLM has context
    for (const mod of modules) {
      if (mod.getSystemInjection) {
        const injection = mod.getSystemInjection(appId, channel);
        logger.info(`[SystemInjection] module=${mod.name || 'unknown'} hasInjection=${!!injection}${injection ? ` content="${injection.substring(0, 200)}"` : ''}`);
        if (injection) {
          const sysIdx = messages.findIndex(m => m.role === 'system');
          if (sysIdx >= 0) {
            messages.splice(sysIdx + 1, 0, { role: 'system', content: injection });
          } else {
            messages.unshift({ role: 'system', content: injection });
          }
        }
      }
    }

    // Log system messages summary so we can verify injection ordering
    const sysMsgs = messages.filter(m => m.role === 'system');
    for (let i = 0; i < sysMsgs.length; i++) {
      const preview = sysMsgs[i].content.substring(0, 120).replace(/\n/g, '\\n');
      logger.info(`[SysMsg ${i}/${sysMsgs.length}] ${preview}...`);
    }

    // Dump full messages to /tmp for debugging (enable via DUMP_LLM_MESSAGES=true)
    if (process.env.DUMP_LLM_MESSAGES === 'true') {
      const ts = Date.now();
      const dumpPath = `/tmp/llm_messages_${channel}_${ts}.json`;
      require('fs').writeFileSync(dumpPath, JSON.stringify(messages, null, 2));
      logger.info(`[MessageDump] ${dumpPath} (${messages.length} messages)`);
    }

    if (!stream) {
      // ── Non-streaming with multi-pass tool execution ──
      let finalResponse = null;
      for (let pass = 0; pass < 5; pass++) {
        const completionParams = {
          model,
          messages,
          tools: tools.length ? tools : undefined,
          tool_choice: tools.length && tool_choice ? tool_choice : undefined,
        };
        if (isReasoningModel) {
          completionParams.max_completion_tokens = 1024;
        }
        const response = await client.chat.completions.create(completionParams);

        finalResponse = response;
        const choice = response.choices[0];

        if (!choice.message.tool_calls || !choice.message.tool_calls.length) {
          const content = choice.message.content || '';
          if (content) {
            saveMessage(appId, userId, channel, {
              role: 'assistant',
              content,
            });
            // Module onResponse hooks
            for (const mod of modules) {
              if (mod.onResponse) mod.onResponse({ appId, userId, channel, content });
            }
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
      const streamParams = {
        model,
        messages: currentMessages,
        tools: tools.length ? tools : undefined,
        tool_choice: tools.length && tool_choice ? tool_choice : undefined,
        response_format,
        stream: true,
      };
      if (isReasoningModel) {
        streamParams.max_completion_tokens = 1024;
      }
      const completion = await client.chat.completions.create(streamParams);

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
        // Module onResponse hooks
        for (const mod of modules) {
          if (mod.onResponse) mod.onResponse({ appId, userId, channel, content: accumulatedContent });
        }
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
      model = DEFAULT_LLM_MODEL,
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
    const ragClient = getOpenAIClient(req);
    const completion = await ragClient.chat.completions.create({
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

async function initRTM() {
  try {
    const rtm = require('./rtm_client');
    // Register message handler for all sessions (current and future)
    rtm.onRTMMessage(handleRTMMessage);
    // Register presence handler — detect agent leaving channel for cleanup
    rtm.onPresence(handleRTMPresence);
    // Try env-var-based init (legacy)
    await rtm.initRTM();
    logger.info('RTM integration enabled');
  } catch (e) {
    // rtm_client.js or rtm-nodejs not available — skip silently
    logger.debug('RTM not available (optional): ' + e.message);
  }
}

/**
 * Handle RTM presence events. When the agent RTM UID (100-{channel}) leaves,
 * trigger full cleanup (Thymia disconnect, RTM destroy, audio subscriber stop).
 * This is the server-side equivalent of /unregister-agent without relying on
 * the client to call hangup.
 */
function handleRTMPresence(channel, event) {
  const type = event.eventType || event.type || '';
  const publisher = event.publisher || event.userId || '';

  // Only care about leave/timeout events
  if (type !== 'REMOTE_LEAVE' && type !== 'REMOTE_TIMEOUT') return;

  // Check if the publisher is the client RTM UID (format: "101-{channel}")
  // or the agent RTM UID (format: "100-{channel}")
  // The client leaves first on hangup; the agent may never send REMOTE_LEAVE.
  const isClient = publisher.startsWith('101-');
  const isAgent = publisher.startsWith('100-');
  if (!isClient && !isAgent) return;

  const role = isClient ? 'Client' : 'Agent';
  logger.info(`[Presence] ${role} RTM UID ${publisher} left channel ${channel} (${type}) — triggering cleanup`);

  // Find the appId for this channel from the agent registry
  let appId = null;
  for (const [key, entry] of agentRegistry.entries()) {
    if (key.endsWith(`:${channel}`)) {
      appId = key.split(':')[0];
      break;
    }
  }

  if (!appId) {
    logger.warn(`[Presence] No agent registry entry for channel ${channel} — skipping cleanup`);
    return;
  }

  // Trigger the same cleanup as /unregister-agent
  const entry = unregisterAgent(appId, channel);
  if (!entry) return;

  audioSubscriber.stopSession(appId, channel);

  // Destroy RTM session (async, fire-and-forget)
  try {
    const rtm = require('./rtm_client');
    rtm.destroySession(channel).catch((e) => {
      logger.error(`[Presence] RTM destroy error: ${e.message}`);
    });
  } catch (e) { /* rtm not available */ }

  // Notify modules (Thymia disconnect, Shen cleanup, etc.)
  for (const mod of modules) {
    if (mod.onAgentUnregistered) {
      mod.onAgentUnregistered(appId, channel, entry.agentId);
    }
  }

  logger.info(`[Presence] Cleanup complete for ${appId}:${channel} (agent=${entry.agentId})`);
}

async function handleRTMMessage(event) {
  try {
    const messageText =
      typeof event.message === 'string'
        ? event.message
        : event.message?.toString?.() || '';
    const channelName = event.channelName || 'default';
    const publisherUserId = event.publisher || 'unknown';

    // Skip messages handled by integration modules (shen.vitals, thymia.biomarkers, etc.)
    try {
      const parsed = JSON.parse(messageText);
      if (parsed.object && /^(shen\.|thymia\.)/.test(parsed.object)) {
        return; // Already handled by the module's own RTM handler
      }
    } catch (_) {
      // Not JSON — treat as a regular chat message
    }

    logger.info(
      `RTM message from ${publisherUserId} on ${channelName}: ${messageText}`
    );

    // Use a default appId from env for RTM conversations
    const appId = process.env.AGORA_APP_ID || '';

    // Build messages with history
    const messages = buildMessagesWithHistory(appId, publisherUserId, channelName, [
      { role: 'user', content: messageText },
    ]);

    const tools = getToolsForRequest(null);

    // Multi-pass non-streaming tool execution
    let currentMessages = [...messages];
    let finalContent = '';

    for (let pass = 0; pass < 5; pass++) {
      const response = await openai.chat.completions.create({
        model: DEFAULT_LLM_MODEL,
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

// ─── Process cleanup ───

function shutdownAll() {
  audioSubscriber.shutdownAll();
  for (const mod of modules) {
    if (mod.shutdown) mod.shutdown();
  }
}

process.on('exit', shutdownAll);
process.on('SIGINT', () => { shutdownAll(); process.exit(0); });
process.on('SIGTERM', () => { shutdownAll(); process.exit(0); });

// Prevent RTM WASM async errors from crashing the server
process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception (server continues):', err);
});
process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled rejection (server continues):', reason);
});

// Start server
app.listen(port, () => {
  logger.info(`Server running on port ${port}`);
  logger.info(`AudioSubscriber initialized`);

  if (modules.length > 0) {
    logger.info(`Modules loaded: ${modules.map((m) => m.name).join(', ')}`);
  }

  // Initialize RTM (non-blocking, optional)
  initRTM();
});
