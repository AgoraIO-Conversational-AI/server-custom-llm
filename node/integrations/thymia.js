/**
 * Thymia voice biomarker module — self-contained plugin.
 *
 * Implements the module interface consumed by custom_llm.js:
 *   init(audioSubscriber, options)
 *   getToolDefinitions()
 *   getToolHandlers()
 *   onRequest(ctx)
 *   onResponse(ctx)
 *   getSystemInjection(appId, channel)
 *   shutdown()
 */

const https = require('https');
const { ThymiaClient } = require('../thymia_client');
const thymiaStore = require('../thymia_store');

const logger = {
  info: (message) => console.log(`INFO: [ThymiaModule] ${message}`),
  debug: (message) => console.log(`DEBUG: [ThymiaModule] ${message}`),
  error: (message, error) => console.error(`ERROR: [ThymiaModule] ${message}`, error),
};

// ─── Agent Registry (populated via onAgentRegistered from custom_llm.js) ───
const agentMap = new Map(); // appId:channel → { agentId, authHeader, agentEndpoint }

// Ring buffer: 60 seconds of 16kHz mono 16-bit PCM = 1,920,000 bytes
const PCM_BUFFER_SIZE = 16000 * 2 * 60;

// ─── Per-channel Thymia state ───

const channelState = new Map(); // key: "appId:channel"

function getKey(appId, channel) {
  return `${appId}:${channel}`;
}

function getOrCreateState(appId, channel) {
  const key = getKey(appId, channel);
  if (!channelState.has(key)) {
    channelState.set(key, {
      thymiaClient: null,
      thymiaConnected: false,
      // PCM ring buffer for pre-connection buffering
      pcmBuffer: Buffer.alloc(PCM_BUFFER_SIZE),
      pcmWritePos: 0,
      pcmBytesWritten: 0,
      // Pending transcripts queued before Thymia connects
      pendingTranscripts: [],
    });
  }
  return channelState.get(key);
}

// ─── Internal helpers ───

let _audioSubscriber = null;
let _getRtmClient = null; // getter function, since RTM initializes async

/**
 * Check if a biomarkers object has any non-null numeric scores.
 */
function hasNonNullScores(obj) {
  if (!obj) return false;
  return Object.values(obj).some((v) => v !== null && v !== undefined && typeof v === 'number');
}

/**
 * Format all biomarker scores into a human-readable summary.
 * Skips near-zero values (< 0.001) to reduce noise.
 */
function formatBiomarkerSummary(metrics) {
  const parts = [];
  const bio = metrics.biomarkers || {};

  for (const [name, value] of Object.entries(bio)) {
    if (value === null || value === undefined || typeof value !== 'number') continue;
    if (Math.abs(value) < 0.001) continue; // skip near-zero
    const pct = (value * 100).toFixed(1);
    // Capitalize first letter
    const label = name.charAt(0).toUpperCase() + name.slice(1).replace(/_/g, ' ');
    parts.push(`${label}: ${pct}%`);
  }

  // Also include safety if present
  const s = metrics.safety || {};
  if (s.alert && s.alert !== 'none') {
    parts.push(`Safety alert: ${s.alert}`);
  }

  return parts.length > 0
    ? `Voice Biomarker Results: ${parts.join(', ')}`
    : 'Voice biomarker analysis in progress...';
}

/**
 * Send biomarker results to frontend via RTM.
 */
function pushBiomarkersViaRTM(channel, metrics) {
  try {
    const rtm = require('../rtm_client');
    const keys = Object.keys(metrics.biomarkers || {}).filter(k => {
      const v = metrics.biomarkers[k];
      return v !== null && v !== undefined && typeof v === 'number' && Math.abs(v) >= 0.001;
    });
    const ts = Date.now();
    logger.info(`[RTM_SEND] t=${ts} biomarkers to ${channel}: ${keys.join(', ')} (${keys.length} scores)`);
    const rtmMsg = JSON.stringify({
      object: 'thymia.biomarkers',
      text: formatBiomarkerSummary(metrics),
      biomarkers: metrics.biomarkers,
      wellness: metrics.wellness,
      clinical: metrics.clinical,
      safety: metrics.safety,
      timestamp: new Date().toISOString(),
      _server_ts: ts,
    });
    rtm.sendRTMMessage(channel, rtmMsg).then((ok) => {
      logger.info(`[RTM_SENT] t=${Date.now()} biomarkers published=${ok} (latency=${Date.now() - ts}ms)`);
    });
  } catch (e) {
    logger.debug('RTM not available for biomarker push: ' + e.message);
  }
}

/**
 * Send progress update to frontend via RTM.
 */
function pushProgressViaRTM(channel, progressData) {
  try {
    const rtm = require('../rtm_client');
    const summary = Object.entries(progressData).map(([k, v]) =>
      `${k}:${v.speech_seconds.toFixed(1)}/${v.trigger_seconds}s${v.processing ? '*' : ''}`
    ).join(' ');
    const ts = Date.now();
    logger.info(`[RTM_SEND] t=${ts} progress to ${channel}: ${summary}`);
    const rtmMsg = JSON.stringify({
      object: 'thymia.progress',
      progress: progressData,
      timestamp: new Date().toISOString(),
      _server_ts: ts,
    });
    rtm.sendRTMMessage(channel, rtmMsg).then((ok) => {
      logger.info(`[RTM_SENT] t=${Date.now()} progress published=${ok} (latency=${Date.now() - ts}ms)`);
    });
  } catch (e) {
    logger.debug('RTM not available for progress push: ' + e.message);
  }
}

/**
 * Build the biomarker system injection content string.
 * Categorizes biomarkers and includes recommended_actions.for_agent if present.
 */
function buildBiomarkerInjection(metrics) {
  const WELLNESS_KEYS = ['distress', 'stress', 'burnout', 'fatigue', 'low_self_esteem'];
  const CLINICAL_KEYS = ['depression_probability', 'anxiety_probability'];
  const EMOTION_KEYS = ['angry', 'disgusted', 'fearful', 'happy', 'neutral', 'other', 'sad', 'surprised'];
  const SKIP_KEYS = ['<unk>', 'unk', 'interpretation'];

  const wellnessParts = [];
  const clinicalParts = [];
  const emotionParts = [];

  for (const [name, value] of Object.entries(metrics.biomarkers || {})) {
    if (value === null || value === undefined || typeof value !== 'number') continue;
    if (Math.abs(value) < 0.001) continue;
    if (SKIP_KEYS.includes(name)) continue;

    const pct = Math.round(value * 100);
    const label = name.replace(/^symptom_/, '').replace(/_probability$/, '').replace(/_/g, ' ');

    if (WELLNESS_KEYS.includes(name)) {
      wellnessParts.push(`${label}: ${pct}%`);
    } else if (CLINICAL_KEYS.includes(name) || name.startsWith('symptom_')) {
      clinicalParts.push(`${label}: ${pct}%`);
    } else if (EMOTION_KEYS.includes(name)) {
      emotionParts.push(`${label}: ${pct}%`);
    }
  }

  if (wellnessParts.length === 0 && clinicalParts.length === 0 && emotionParts.length === 0) return null;

  let injection = `[Voice Biomarker Update] These are live voice biomarker scores analysed continuously since the start of this call. They update as the conversation progresses.\n`;
  if (wellnessParts.length > 0) {
    injection += `Wellness: ${wellnessParts.join(', ')}\n`;
  }
  if (emotionParts.length > 0) {
    injection += `Emotions: ${emotionParts.join(', ')}\n`;
  }
  if (clinicalParts.length > 0) {
    injection += `Clinical: ${clinicalParts.join(', ')}\n`;
  }

  // Include safety recommended_actions.for_agent if present
  const safety = metrics.safety || {};
  if (safety.recommended_actions) {
    const actions = safety.recommended_actions;
    if (typeof actions === 'object' && actions.for_agent) {
      injection += `\n[Safety Guidance] ${actions.for_agent}\n`;
      if (actions.urgency) injection += `Urgency: ${actions.urgency}\n`;
    } else if (Array.isArray(actions) && actions.length > 0) {
      injection += `\n[Safety Guidance] ${actions.join('; ')}\n`;
    }
  }
  if (safety.concerns && safety.concerns.length > 0) {
    injection += `Concerns: ${safety.concerns.join(', ')}\n`;
  }

  injection += `Use these insights naturally in conversation. Don't list numbers - describe what the data suggests. Celebrate low scores as positives and explore elevated scores therapeutically.`;

  return injection;
}

/**
 * Call Agora Agent Update API to push system_messages with biomarker context.
 */
function pushBiomarkersViaAgentUpdate(appId, channel, metrics) {
  const key = getKey(appId, channel);
  const agent = agentMap.get(key);
  if (!agent) {
    logger.debug(`[AgentUpdate] no agent registered for ${key}, skipping`);
    return;
  }

  const injection = buildBiomarkerInjection(metrics);
  if (!injection) {
    logger.debug(`[AgentUpdate] no meaningful biomarker data for ${key}, skipping`);
    return;
  }

  const { agentId, authHeader, agentEndpoint } = agent;
  // agentEndpoint is like: https://api.agora.io/api/conversational-ai-agent/v2/projects
  const updateUrl = `${agentEndpoint}/${appId}/agents/${agentId}/update`;
  const ts = Date.now();

  // Include original prompt + biomarker injection (Update API replaces all system_messages)
  const systemMessages = [];
  if (agent.originalPrompt) {
    systemMessages.push({ role: 'system', content: agent.originalPrompt });
  }
  systemMessages.push({ role: 'system', content: injection });

  const payload = JSON.stringify({
    properties: {
      llm: {
        system_messages: systemMessages
      }
    }
  });

  logger.info(`[AgentUpdate] t=${ts} pushing biomarkers to agent=${agentId} url=${updateUrl} content_len=${injection.length}`);
  logger.info(`[AgentUpdate] t=${ts} injection_preview="${injection.substring(0, 300)}"`);

  const url = new URL(updateUrl);
  const options = {
    hostname: url.hostname,
    port: 443,
    path: url.pathname,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': authHeader,
      'Content-Length': Buffer.byteLength(payload),
    },
  };

  const req = https.request(options, (res) => {
    let body = '';
    res.on('data', (chunk) => { body += chunk; });
    res.on('end', () => {
      const latency = Date.now() - ts;
      if (res.statusCode === 200) {
        logger.info(`[AgentUpdate] t=${Date.now()} SUCCESS status=${res.statusCode} latency=${latency}ms body=${body.substring(0, 200)}`);
      } else {
        logger.error(`[AgentUpdate] t=${Date.now()} FAILED status=${res.statusCode} latency=${latency}ms body=${body.substring(0, 500)}`);
      }
    });
  });

  req.on('error', (e) => {
    logger.error(`[AgentUpdate] t=${Date.now()} ERROR: ${e.message}`);
  });

  req.write(payload);
  req.end();
}

/**
 * Call Agora Agent Speak API to make the agent say something via TTS.
 * Useful when new biomarkers arrive during silence — nudge the agent to re-engage.
 */
function speakViaAgent(appId, channel, text, priority = 'APPEND') {
  const key = getKey(appId, channel);
  const agent = agentMap.get(key);
  if (!agent) {
    logger.debug(`[AgentSpeak] no agent registered for ${key}, skipping`);
    return;
  }

  const { agentId, authHeader, agentEndpoint } = agent;
  const speakUrl = `${agentEndpoint}/${appId}/agents/${agentId}/speak`;
  const ts = Date.now();

  // Max 512 bytes
  const truncated = text.length > 500 ? text.substring(0, 500) : text;

  const payload = JSON.stringify({
    text: truncated,
    priority,
    interruptable: true,
  });

  logger.info(`[AgentSpeak] t=${ts} speak to agent=${agentId} priority=${priority} text="${truncated.substring(0, 100)}"`);

  const url = new URL(speakUrl);
  const options = {
    hostname: url.hostname,
    port: 443,
    path: url.pathname,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': authHeader,
      'Content-Length': Buffer.byteLength(payload),
    },
  };

  const req = https.request(options, (res) => {
    let body = '';
    res.on('data', (chunk) => { body += chunk; });
    res.on('end', () => {
      const latency = Date.now() - ts;
      if (res.statusCode === 200) {
        logger.info(`[AgentSpeak] t=${Date.now()} SUCCESS status=${res.statusCode} latency=${latency}ms`);
      } else {
        logger.error(`[AgentSpeak] t=${Date.now()} FAILED status=${res.statusCode} latency=${latency}ms body=${body.substring(0, 300)}`);
      }
    });
  });

  req.on('error', (e) => {
    logger.error(`[AgentSpeak] t=${Date.now()} ERROR: ${e.message}`);
  });

  req.write(payload);
  req.end();
}

/**
 * Flush the PCM ring buffer to the Thymia client.
 */
function flushBuffer(state) {
  if (!state.thymiaClient || state.pcmBytesWritten === 0) return;

  const totalBuffered = Math.min(state.pcmBytesWritten, state.pcmBuffer.length);
  let data;

  if (state.pcmBytesWritten <= state.pcmBuffer.length) {
    data = Buffer.from(state.pcmBuffer.slice(0, state.pcmWritePos));
  } else {
    data = Buffer.concat([
      state.pcmBuffer.slice(state.pcmWritePos),
      state.pcmBuffer.slice(0, state.pcmWritePos),
    ]);
  }

  // Send in 32KB chunks to avoid overwhelming WebSocket
  const chunkSize = 32 * 1024;
  for (let i = 0; i < data.length; i += chunkSize) {
    const chunk = data.slice(i, Math.min(i + chunkSize, data.length));
    state.thymiaClient.sendAudio(chunk);
  }

  logger.info(`Flushed ${totalBuffered} bytes of buffered PCM to Thymia`);

  state.pcmBytesWritten = 0;
  state.pcmWritePos = 0;
}

/**
 * Route PCM audio: stream to Thymia if connected, otherwise ring-buffer.
 */
function handleAudio(appId, channel, pcmData) {
  const state = getOrCreateState(appId, channel);

  if (state.thymiaConnected && state.thymiaClient) {
    state.thymiaClient.sendAudio(pcmData);
  } else {
    // Buffer PCM (ring buffer)
    const space = state.pcmBuffer.length - state.pcmWritePos;
    if (pcmData.length <= space) {
      pcmData.copy(state.pcmBuffer, state.pcmWritePos);
      state.pcmWritePos += pcmData.length;
    } else {
      pcmData.copy(state.pcmBuffer, state.pcmWritePos, 0, space);
      pcmData.copy(state.pcmBuffer, 0, space);
      state.pcmWritePos = pcmData.length - space;
    }
    state.pcmBytesWritten += pcmData.length;
  }
}

/**
 * Connect Thymia client for a channel.
 */
function connectThymia(appId, channel, config) {
  const key = getKey(appId, channel);
  const state = getOrCreateState(appId, channel);

  if (state.thymiaClient && state.thymiaConnected) {
    logger.info(`Thymia already connected for ${key}`);
    return state.thymiaClient;
  }

  const client = new ThymiaClient({
    onPolicyResult: (result) => {
      const ts = Date.now();
      const bioKeys = Object.keys((result.result || {}).biomarkers || {});
      const actions = (result.result || {}).recommended_actions;
      logger.info(`[THYMIA_CB] t=${ts} onPolicyResult policy=${result.policy} biomarker_keys=[${bioKeys.join(',')}] has_actions=${!!actions}`);
      if (actions) {
        logger.info(`[THYMIA_CB] t=${ts} recommended_actions=${JSON.stringify(actions).substring(0, 300)}`);
      }
      thymiaStore.updateFromPolicyResult(appId, channel, result);
      // Push to frontend via RTM + Agent Update API when we have meaningful biomarker scores
      const metrics = thymiaStore.getMetrics(appId, channel);
      if (metrics && hasNonNullScores(metrics.biomarkers)) {
        pushBiomarkersViaRTM(channel, metrics);
        pushBiomarkersViaAgentUpdate(appId, channel, metrics);
      } else {
        logger.info(`[THYMIA_CB] t=${Date.now()} no non-null scores yet, skipping pushes`);
      }
    },
    onProgress: (msg) => {
      const ts = Date.now();
      thymiaStore.updateProgress(appId, channel, msg);
      if (msg.biomarkers) {
        pushProgressViaRTM(channel, msg.biomarkers);
      } else {
        logger.info(`[THYMIA_CB] t=${ts} onProgress but no biomarkers field in msg`);
      }
    },
    onStatus: (status) => {
      if (status === 'connected') {
        state.thymiaConnected = true;
        thymiaStore.setSessionActive(appId, channel, true);
        logger.info(`Thymia connected for ${key}, flushing buffered audio`);
        flushBuffer(state);
        // Flush pending transcripts
        if (state.pendingTranscripts.length > 0) {
          logger.info(`Flushing ${state.pendingTranscripts.length} pending transcript(s)`);
          for (const t of state.pendingTranscripts) {
            state.thymiaClient.sendTranscript(t.speaker, t.text);
          }
          state.pendingTranscripts = [];
        }
      } else if (status === 'disconnected') {
        state.thymiaConnected = false;
        thymiaStore.setSessionActive(appId, channel, false);
      }
    },
    onError: (err) => {
      logger.error(`Thymia error for ${key}:`, err);
    },
  });

  state.thymiaClient = client;
  client.connect(config);

  return client;
}

/**
 * Forward a transcript to Thymia, or queue if not yet connected.
 */
function sendTranscript(appId, channel, speaker, text) {
  const key = getKey(appId, channel);
  const state = channelState.get(key);
  if (!state) return;

  if (state.thymiaClient && state.thymiaConnected) {
    logger.info(`Sending transcript to Thymia [${key}]: ${speaker}: ${text.slice(0, 80)}`);
    state.thymiaClient.sendTranscript(speaker, text);
  } else {
    state.pendingTranscripts.push({ speaker, text });
    logger.debug(`Queued transcript (Thymia not ready) [${key}]: ${speaker}: ${text.slice(0, 80)}`);
  }
}

// ─── Tool definitions ───

const TOOL_DEFINITIONS = [
  {
    type: 'function',
    function: {
      name: 'get_wellness_metrics',
      description:
        'Get the current voice biomarker wellness metrics for the user in this session. ' +
        'Returns stress, burnout, fatigue, and other indicators detected from voice analysis. ' +
        'Only available after Thymia voice analysis has been running for at least 30 seconds.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'start_thymia_session',
      description:
        'Start a Thymia voice biomarker analysis session for the current user. ' +
        'This connects to the Thymia Sentinel API and begins analyzing the user voice ' +
        'for wellness indicators. Call this when the user wants a wellness check or ' +
        'when you need to assess their emotional state from voice.',
      parameters: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: "User's name or label for the session",
          },
          year_of_birth: {
            type: 'integer',
            description: "User's birth year (e.g. 1990), used for age-adjusted analysis",
          },
          sex: {
            type: 'string',
            enum: ['male', 'female'],
            description: "User's biological sex, used for voice analysis calibration",
          },
          locale: {
            type: 'string',
            description: "User's language/locale code (e.g. 'en', 'es', 'fr'). Default: 'en'",
          },
        },
        required: ['name'],
      },
    },
  },
];

function getWellnessMetrics(appId, userId, channel, args) {
  logger.info(`get_wellness_metrics called for ${appId}:${channel}`);
  const metrics = thymiaStore.getMetrics(appId, channel);

  if (!metrics) {
    return JSON.stringify({
      status: 'no_data',
      message:
        'No voice biomarker data available yet. The analysis needs at least 30 seconds of speech. ' +
        'If a Thymia session has not been started, call start_thymia_session first.',
    });
  }

  return JSON.stringify({
    status: 'ok',
    session_active: metrics.sessionActive,
    results_count: metrics.resultsCount,
    last_updated: metrics.lastUpdated,
    wellness: metrics.wellness,
    clinical: metrics.clinical,
    safety: metrics.safety,
  });
}

function startThymiaSession(appId, userId, channel, args) {
  logger.info(`start_thymia_session called for ${appId}:${channel}`);

  if (!_audioSubscriber) {
    return JSON.stringify({
      status: 'error',
      message: 'Audio subscriber not available. Thymia integration is not enabled.',
    });
  }

  const name = args.name || 'user';
  const yearOfBirth = args.year_of_birth;
  const sex = args.sex;
  const locale = args.locale || 'en';

  const dateOfBirth = yearOfBirth ? `${yearOfBirth}-01-01` : undefined;

  const config = {
    user_label: name,
    date_of_birth: dateOfBirth,
    birth_sex: sex,
    language: locale,
  };

  connectThymia(appId, channel, config);

  return JSON.stringify({
    status: 'ok',
    message: `Thymia voice analysis session started for ${name}. ` +
      'Biomarker results will be available after approximately 30 seconds of speech. ' +
      'Use get_wellness_metrics to retrieve results.',
  });
}

const TOOL_MAP = {
  get_wellness_metrics: getWellnessMetrics,
  start_thymia_session: startThymiaSession,
};

// ─── Module interface ───

module.exports = {
  name: 'thymia',

  /**
   * Initialize the module with an AudioSubscriber and options.
   */
  init(audioSubscriber, options = {}) {
    _audioSubscriber = audioSubscriber;
    _getRtmClient = options.rtmClient || null;

    // Listen for audio events from the generic subscriber
    audioSubscriber.on('audio', (appId, channel, pcmData) => {
      handleAudio(appId, channel, pcmData);
    });

    logger.info('Thymia module initialized');
  },

  /**
   * Called when simple-backend registers an agent_id for an appId+channel.
   * Stores the mapping so we can call Agent Update API when biomarkers arrive.
   */
  onAgentRegistered(appId, channel, agentId, authHeader, agentEndpoint, prompt) {
    const key = getKey(appId, channel);
    agentMap.set(key, { agentId, authHeader, agentEndpoint, originalPrompt: prompt || null });
    logger.info(`[AgentRegistered] ${key} → agent=${agentId} prompt_len=${(prompt || '').length}`);
  },

  /**
   * Return tool definitions to be merged into the LLM's tool list.
   */
  getToolDefinitions() {
    return TOOL_DEFINITIONS;
  },

  /**
   * Return tool handler map to be merged into the tool dispatcher.
   */
  getToolHandlers() {
    return TOOL_MAP;
  },

  /**
   * Called on each incoming /chat/completions request.
   * Auto-starts audio + Thymia, forwards user transcript.
   */
  onRequest(ctx) {
    const { appId, userId, channel, subscriberToken, messages } = ctx;

    if (!appId || !channel || channel === 'default') return;

    const key = getKey(appId, channel);

    // Auto-start audio subscription
    if (_audioSubscriber && !_audioSubscriber.hasSession(appId, channel)) {
      _audioSubscriber.startSession(appId, channel, userId, subscriberToken);
    }

    // Auto-connect Thymia if not already connected
    const state = channelState.get(key);
    if (!state || !state.thymiaConnected) {
      connectThymia(appId, channel, {
        user_label: `user-${userId}-${channel}`,
        date_of_birth: '1990-01-01',
        birth_sex: 'MALE',
        biomarkers: ['helios', 'apollo'],
        policies: ['passthrough', 'safety_analysis'],
      });
    }

    // Forward last user transcript to Thymia
    const userMessages = (messages || []).filter((m) => m.role === 'user');
    const lastUserMsg = userMessages[userMessages.length - 1];
    if (lastUserMsg && lastUserMsg.content) {
      sendTranscript(appId, channel, 'user', lastUserMsg.content);
    }
  },

  /**
   * Called after the LLM produces a final assistant response.
   * Forwards assistant transcript to Thymia.
   */
  onResponse(ctx) {
    const { appId, channel, content } = ctx;
    if (content) {
      sendTranscript(appId, channel, 'agent', content);
    }
  },

  // getSystemInjection removed — biomarkers now pushed via Agent Update API directly to ConvoAI engine

  /**
   * Called when an agent is unregistered (call ended / hangup).
   * Disconnects Thymia client and cleans up state for this channel.
   */
  onAgentUnregistered(appId, channel, agentId) {
    const key = getKey(appId, channel);
    logger.info(`[AgentUnregistered] ${key} agent=${agentId}`);

    // Disconnect Thymia client for this channel
    const state = channelState.get(key);
    if (state) {
      if (state.thymiaClient) {
        state.thymiaClient.disconnect();
        logger.info(`[AgentUnregistered] Thymia client disconnected for ${key}`);
      }
      channelState.delete(key);
    }

    // Remove from agent map
    agentMap.delete(key);

    // Clear store data for this channel
    thymiaStore.remove(appId, channel);
  },

  /**
   * Shut down all Thymia clients and clear state.
   */
  shutdown() {
    for (const [key, state] of channelState) {
      if (state.thymiaClient) {
        state.thymiaClient.disconnect();
      }
    }
    channelState.clear();
    logger.info('All Thymia sessions shut down');
  },
};
