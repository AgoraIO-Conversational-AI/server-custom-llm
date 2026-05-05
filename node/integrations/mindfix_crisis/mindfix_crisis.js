const OpenAI = require('openai');

const defaultDashboardClient = require('../../consultant_dashboard_client');
const { dialOutboundIntoChannel: defaultDialOutbound } = require('../pstn/sipcm');

const logger = {
  info: (message) => console.log(`INFO: [MindFixCrisis] ${message}`),
  debug: (message) => console.log(`DEBUG: [MindFixCrisis] ${message}`),
  error: (message, error) => console.error(`ERROR: [MindFixCrisis] ${message}`, error),
};

const channelState = new Map();
// Defaults are the real imports; tests can override `dashboardClient`,
// `dialOutboundIntoChannel`, and the `recordAssistantUtterance` / `speakWithAgent`
// helpers via init(_, deps).
let _deps = {
  recordAssistantUtterance: async () => {},
  speakWithAgent: async () => ({ ok: false, skipped: true }),
  dashboardClient: defaultDashboardClient,
  dialOutboundIntoChannel: defaultDialOutbound,
  getLatestUserUtterance: () => '',
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (id) => clearTimeout(id),
  getGraceMs: () => CRISIS_CALL_GRACE_MS,
};

const CRISIS_CALL_ENABLED = process.env.CRISIS_CALL_ENABLED === 'true';
const CRISIS_TRIGGER_LEVEL = Number(process.env.CRISIS_TRIGGER_LEVEL || 3);
const CRISIS_CALL_GRACE_MS = Number(process.env.CRISIS_CALL_GRACE_MS || 20000);
const DEFAULT_LLM_API_KEY =
  process.env.LLM_API_KEY ||
  process.env.YOUR_LLM_API_KEY ||
  process.env.OPENAI_API_KEY ||
  '';
const DEFAULT_LLM_BASE_URL = process.env.LLM_BASE_URL || 'https://api.openai.com/v1';
const DEFAULT_LLM_MODEL = process.env.LLM_MODEL || 'gpt-4o-mini';

function getKey(appId, channel) {
  return `${appId}:${channel}`;
}

function isAiHumanSession(state) {
  return !!(state?.dashboard && !state.dashboard.meetingMode);
}

function getOrCreateState(appId, channel) {
  const key = getKey(appId, channel);
  if (!channelState.has(key)) {
    channelState.set(key, {
      appId,
      channel,
      userId: '',
      dashboard: null,
      sessionId: '',
      escalationEventId: '',
      phase: '',
      inFlight: false,
      suppressed: false,
      suppressionNote: '',
      graceTimer: null,
      pendingSafety: null,
      pendingTriggeringText: '',
      pendingLevel3StartedAt: 0,
    });
  }
  return channelState.get(key);
}

function escapeLine(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function buildPendingEscalationInstruction() {
  return (
    '[Crisis] A crisis escalation may already be underway during a short grace window. ' +
    'Do not tell the client to contact their escalation person manually, do not tell them to call emergency services, ' +
    'and do not imply they must arrange outside contact themselves unless the user specifically asks. ' +
    'Stay calm, supportive, and brief. Focus on grounding, immediate safety, and keeping the client engaged while the system handles any needed escalation.'
  );
}

function fallbackTexts(clientName, safety, triggeringText = '') {
  const firstName = (clientName || 'the client').split(/\s+/)[0];
  const concerns = Array.isArray(safety?.concerns) ? safety.concerns.slice(0, 2).join(', ') : '';
  const quote = escapeLine(triggeringText).slice(0, 180);
  return {
    clientAnnouncement:
      `I’m concerned about your safety, ${firstName}. I’m going to call your escalation contact now so they can join us.`,
    recipientSummary:
      `This is the MindFix session assistant. I detected a crisis-level safety concern for ${firstName}. ` +
      `${quote ? `They said: "${quote}". ` : ''}` +
      `${concerns ? `Main concerns: ${concerns}. ` : ''}` +
      `You are now connected to the live session and can speak with them directly.`,
  };
}

async function generateEscalationTexts({ clientName, safety, triggeringText }) {
  if (!DEFAULT_LLM_API_KEY) {
    return fallbackTexts(clientName, safety, triggeringText);
  }

  const client = new OpenAI({
    apiKey: DEFAULT_LLM_API_KEY,
    baseURL: DEFAULT_LLM_BASE_URL,
  });
  const prompt = {
    client_name: clientName || 'the client',
    level: safety?.level ?? null,
    alert: safety?.alert || '',
    concerns: safety?.concerns || [],
    guidance: safety?.guidance || '',
    triggering_text: escapeLine(triggeringText || ''),
  };

  try {
    const response = await client.chat.completions.create({
      model: DEFAULT_LLM_MODEL,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content:
            'You are writing two very short crisis escalation utterances for a therapy voice agent. ' +
            'Return strict JSON with keys client_announcement and recipient_summary. ' +
            'client_announcement: calm, direct, tell the client you are calling their escalation contact now. ' +
            'recipient_summary: one short handoff for the answered escalation contact, include client first name, the main safety concern, and what the client said if triggering_text is present. ' +
            'Say they are now connected to the live session. Do not mention legal disclaimers or internal systems beyond MindFix.',
        },
        {
          role: 'user',
          content: JSON.stringify(prompt),
        },
      ],
    });
    const content = response.choices?.[0]?.message?.content || '{}';
    const parsed = JSON.parse(content);
    const fallback = fallbackTexts(clientName, safety, triggeringText);
    return {
      clientAnnouncement: escapeLine(parsed.client_announcement) || fallback.clientAnnouncement,
      recipientSummary: escapeLine(parsed.recipient_summary) || fallback.recipientSummary,
    };
  } catch (error) {
    logger.error(`Escalation text generation failed: ${error.message}`);
    return fallbackTexts(clientName, safety, triggeringText);
  }
}

async function postStatusSafe(state, payload) {
  if (!state?.dashboard || !state?.escalationEventId) return;
  try {
    await _deps.dashboardClient.postCrisisEscalateStatus(
      state.dashboard,
      {
        escalation_event_id: state.escalationEventId,
        ...payload,
      },
      logger
    );
  } catch (error) {
    logger.error(`crisis-escalate-status failed: ${error.message}`);
  }
}

function clearGraceTimer(state) {
  if (state?.graceTimer) {
    _deps.clearTimer(state.graceTimer);
    state.graceTimer = null;
  }
  state.pendingSafety = null;
  state.pendingTriggeringText = '';
  state.pendingLevel3StartedAt = 0;
}

async function startEscalation(state, safety) {
  if (!state.dashboard?.clientId) {
    logger.info(`Skipping crisis escalation for ${state.channel}: missing client context`);
    return;
  }

  const initResponse = await _deps.dashboardClient.postCrisisEscalateInit(
    state.dashboard,
    {
      meeting_id: state.dashboard.meetingId || '',
      client_id: state.dashboard.clientId,
      session_id: state.sessionId || state.channel,
      channel_name: state.channel,
      level: safety.level,
      alert: safety.alert,
      source: 'thymia',
    },
    logger
  );

  state.escalationEventId = initResponse.escalation_event_id || state.escalationEventId;

  if (!initResponse.escalate) {
    state.phase = 'skipped';
    logger.info(
      `Escalation skipped for ${state.channel} reason=${initResponse.reason || 'unknown'} event=${state.escalationEventId || 'none'}`
    );
    return;
  }

  const texts = await generateEscalationTexts({
    clientName: initResponse.client_display_name || state.dashboard.displayName || '',
    safety,
    triggeringText: state.pendingTriggeringText || _deps.getLatestUserUtterance(state.appId, state.userId || '101', state.channel),
  });
  logger.info(
    `starting escalation channel=${state.channel} event=${state.escalationEventId} triggering_text="${escapeLine(state.pendingTriggeringText).slice(0, 180)}"`
  );

  state.suppressed = true;
  state.suppressionNote =
    '[Crisis] A crisis escalation call is active. Do not respond further in the live conversation. Do not announce call failure to the client.';
  state.phase = 'dialing';

  await _deps.recordAssistantUtterance(
    state.appId,
    state.userId || '101',
    state.channel,
    texts.clientAnnouncement,
    { skipModuleFanout: true }
  );
  await _deps.speakWithAgent(state.appId, state.channel, texts.clientAnnouncement, 'APPEND');

  await postStatusSafe(state, {
    phase: 'dialing',
    client_announcement_text: texts.clientAnnouncement,
    recipient_summary_text: texts.recipientSummary,
  });

  const dialResult = await _deps.dialOutboundIntoChannel(
    {
      appId: state.appId,
      channelName: initResponse.channel_name,
      rtcToken: initResponse.rtc_token,
      toPhone: initResponse.escalation_phone_number,
      fromPhone: initResponse.from_phone,
      region: initResponse.region,
      pstnUid: initResponse.pstn_uid,
      sipGateway: initResponse.sip_gateway,
    },
    { logger }
  );

  if (dialResult.ok && dialResult.phase === 'answered') {
    state.phase = 'answered';
    logger.info(
      `answered escalation channel=${state.channel} event=${state.escalationEventId} recipient_summary="${texts.recipientSummary.slice(0, 220)}"`
    );
    await _deps.recordAssistantUtterance(
      state.appId,
      state.userId || '101',
      state.channel,
      texts.recipientSummary,
      { skipModuleFanout: true }
    );
    await _deps.speakWithAgent(state.appId, state.channel, texts.recipientSummary, 'APPEND');
    await postStatusSafe(state, {
      phase: 'answered',
      provider_result: dialResult.outcome,
      client_announcement_text: texts.clientAnnouncement,
      recipient_summary_text: texts.recipientSummary,
    });
    return;
  }

  state.phase = 'failed';
  await postStatusSafe(state, {
    phase: 'failed',
    reason: dialResult.outcome,
    provider_result: dialResult.outcome,
    client_announcement_text: texts.clientAnnouncement,
    recipient_summary_text: texts.recipientSummary,
  });
}

function scheduleEscalation(state, safety) {
  if (state.graceTimer || state.inFlight || state.suppressed) return;
  const graceMs = Number(_deps.getGraceMs?.() ?? CRISIS_CALL_GRACE_MS);
  state.phase = 'pending';
  state.pendingSafety = safety;
  if (!state.pendingTriggeringText) {
    state.pendingTriggeringText = _deps.getLatestUserUtterance(state.appId, state.userId || '101', state.channel);
  }
  if (!state.pendingLevel3StartedAt) {
    state.pendingLevel3StartedAt = Date.now();
  }

  const run = async () => {
    state.graceTimer = null;
    if (state.suppressed || !state.pendingSafety) return;
    state.inFlight = true;
    try {
      await startEscalation(state, state.pendingSafety || safety || {});
    } catch (error) {
      logger.error(`Escalation flow failed for ${state.channel}: ${error.message}`);
      state.phase = 'failed';
      await postStatusSafe(state, {
        phase: 'failed',
        reason: error.message,
        provider_result: error.message,
      });
    } finally {
      clearGraceTimer(state);
      state.inFlight = false;
    }
  };

  if (graceMs <= 0) {
    return run();
  }
  logger.info(
    `grace window started channel=${state.channel} ms=${graceMs} trigger_text="${escapeLine(state.pendingTriggeringText).slice(0, 180)}"`
  );
  state.graceTimer = _deps.setTimer(() => {
    Promise.resolve(run()).catch((error) => {
      logger.error(`Escalation timer failed for ${state.channel}: ${error.message}`);
    });
  }, graceMs);
}

module.exports = {
  name: 'mindfix_crisis',

  init(_audioSubscriber, deps = {}) {
    _deps = {
      ..._deps,
      ...deps,
    };
    logger.info(`MindFix crisis module initialized enabled=${CRISIS_CALL_ENABLED}`);
  },

  onAgentRegistered(appId, channel, _agentId, _authHeader, _agentEndpoint, _prompt, earlyParams) {
    const state = getOrCreateState(appId, channel);
    state.dashboard = _deps.dashboardClient.createDashboardConfig(earlyParams);
    state.userId = earlyParams?.user_uid || state.userId || '101';
    state.sessionId = earlyParams?.session_id || state.sessionId || channel;
    state.phase = '';
    state.inFlight = false;
    state.suppressed = false;
    state.suppressionNote = '';
    state.escalationEventId = '';
  },

  onRequest(ctx) {
    const state = getOrCreateState(ctx.appId, ctx.channel);
    if (ctx.userId && ctx.userId !== 'anonymous') {
      state.userId = ctx.userId;
    }
  },

  async onSafetyUpdate({ appId, channel, safety }) {
    const state = getOrCreateState(appId, channel);
    if (!CRISIS_CALL_ENABLED) return;
    if (!isAiHumanSession(state)) return;
    const level = Number(safety?.level) || 0;
    if (level < CRISIS_TRIGGER_LEVEL) {
      if (state.graceTimer) {
        logger.info(
          `grace window cancelled channel=${channel} level=${level} elapsed_ms=${Date.now() - (state.pendingLevel3StartedAt || Date.now())}`
        );
        clearGraceTimer(state);
        if (state.phase === 'pending') state.phase = '';
      }
      return;
    }
    if (state.inFlight || state.suppressed || state.phase === 'skipped' || state.phase === 'failed') return;
    state.pendingSafety = safety || {};
    if (!state.pendingTriggeringText) {
      state.pendingTriggeringText = _deps.getLatestUserUtterance(appId, state.userId || '101', channel);
    }
    if (!state.pendingLevel3StartedAt) {
      state.pendingLevel3StartedAt = Date.now();
    }
    await scheduleEscalation(state, safety || {});
  },

  shouldSuppressAssistantReply(appId, channel) {
    const state = channelState.get(getKey(appId, channel));
    return !!state?.suppressed;
  },

  getSuppressionInstruction(appId, channel) {
    const state = channelState.get(getKey(appId, channel));
    return state?.suppressionNote || '';
  },

  getSystemInjection(appId, channel) {
    const state = channelState.get(getKey(appId, channel));
    if (!state || !isAiHumanSession(state)) return '';
    if (state.phase !== 'pending' || state.suppressed) return '';
    return buildPendingEscalationInstruction();
  },

  async onAgentUnregistered(appId, channel) {
    const key = getKey(appId, channel);
    const state = channelState.get(key);
    if (state) {
      clearGraceTimer(state);
    }
    if (state?.phase === 'answered') {
      await postStatusSafe(state, { phase: 'completed', provider_result: 'session_ended' });
    } else if (state?.escalationEventId && (state?.phase === 'dialing' || state?.phase === 'initialised')) {
      await postStatusSafe(state, {
        phase: 'failed',
        reason: 'session_ended_during_dial',
        provider_result: 'session_ended_during_dial',
      });
    }
    channelState.delete(key);
  },

  shutdown() {
    channelState.clear();
  },
};
