/**
 * Shen.AI integration module for custom_llm.js
 *
 * Unlike Thymia (which processes audio server-side), the Shen.AI SDK runs
 * entirely in the browser (WASM + camera). The client pushes vitals to the
 * server via RTM, and this module:
 *   1. Receives shen.vitals RTM messages
 *   2. Stores latest vitals in shen_store
 *   3. Pushes vitals via shared agent_updater (combined with other modules)
 */

const shenStore = require('./shen_store');
const agentUpdater = require('../../agent_updater');

const logger = {
  info: (msg) => console.log(`INFO: [Shen] ${msg}`),
  debug: (msg) => console.log(`DEBUG: [Shen] ${msg}`),
  error: (msg, err) => console.error(`ERROR: [Shen] ${msg}`, err || ''),
  warn: (msg) => console.warn(`WARN: [Shen] ${msg}`),
};

// Maps channel → appId so RTM messages can find the appId even before /register-agent
const channelAppIdMap = new Map();

let _rtmClientFactory = null;
let _rtmHandlerRegistered = false;
const meetingModeChannels = new Set();
const channelRuntimeKeys = new Map();
const videoBiomarkerChannels = new Map();

/**
 * Format vitals for LLM system prompt injection.
 */
function buildVitalsInjection(vitals) {
  if (!vitals || vitals.heart_rate_bpm === null) return null;

  const lines = ['[Camera Vitals Update] Live physiological data from camera-based health scan:'];

  if (vitals.heart_rate_bpm !== null) {
    lines.push(`Heart Rate: ${Math.round(vitals.heart_rate_bpm)} bpm`);
  }
  if (vitals.hrv_sdnn_ms !== null) {
    lines.push(`HRV (SDNN): ${Math.round(vitals.hrv_sdnn_ms)} ms`);
  }
  if (vitals.stress_index !== null) {
    lines.push(`Cardiac Stress: ${Math.round(vitals.stress_index)}`);
  }
  if (vitals.breathing_rate_bpm !== null) {
    lines.push(`Breathing Rate: ${Math.round(vitals.breathing_rate_bpm)} bpm`);
  }
  if (vitals.systolic_bp !== null && vitals.diastolic_bp !== null) {
    lines.push(
      `Blood Pressure: ${Math.round(vitals.systolic_bp)}/${Math.round(vitals.diastolic_bp)} mmHg`
    );
  }
  if (vitals.cardiac_workload !== null) {
    lines.push(`Cardiac Workload: ${Math.round(vitals.cardiac_workload)} mmHg/s`);
  }
  if (vitals.age_years !== null) {
    lines.push(`Estimated Age: ${Math.round(vitals.age_years)} years`);
  }
  if (vitals.signal_quality !== null) {
    const pct = Math.round(vitals.signal_quality * 100);
    lines.push(`Signal Quality: ${pct}%`);
  }
  if (vitals.progress > 0 && vitals.progress < 100) {
    lines.push(`Measurement Progress: ${Math.round(vitals.progress)}%`);
  }

  return lines.join('\n');
}

/**
 * Push vitals via shared agent updater.
 */
function pushVitals(appId, channel, vitals) {
  const injection = buildVitalsInjection(vitals);
  if (!injection) return;

  agentUpdater.setInjection(appId, channel, 'shen', injection);
}

/**
 * Handle incoming RTM message — filter for shen.vitals.
 */
function handleRTMMessage(event) {
  try {
    const raw =
      typeof event.message === 'string'
        ? event.message
        : Buffer.isBuffer(event.message)
          ? event.message.toString('utf-8')
          : null;
    if (!raw) return;

    const msg = JSON.parse(raw);
    if (msg.object !== 'shen.vitals') return;

    // RTM messages include the channel in the event
    const channel = event.channelName || event.channel;
    if (!channel) {
      logger.debug('shen.vitals received but no channel in event');
      return;
    }

    // Find the appId from agent updater or channelAppIdMap fallback
    let appId = null;
    const agent = agentUpdater.getAgent(null, null); // unused — search by channel below
    // Search channelAppIdMap first (always populated on each request)
    appId = channelAppIdMap.get(channel);

    if (!appId) {
      logger.debug(`shen.vitals for channel=${channel} but no appId known`);
      return;
    }
    if (videoBiomarkerChannels.get(channel) === false) {
      logger.debug(`Ignoring shen.vitals for channel=${channel} because video biomarkers are disabled`);
      return;
    }

    logger.info(
      `Received shen.vitals: HR=${msg.heart_rate_bpm} HRV=${msg.hrv_sdnn_ms} channel=${channel}`
    );

    shenStore.updateFromRTM(appId, channel, msg);
    pushVitals(appId, channel, shenStore.getVitals(appId, channel));
  } catch (err) {
    logger.debug(`RTM message parse error: ${err.message}`);
  }
}

// ───── Module Interface ─────

module.exports = {
  /**
   * Initialize the Shen module.
   */
  init(_audioSubscriber, options) {
    logger.info('Shen module initialized');

    if (options && options.rtmClient) {
      _rtmClientFactory = options.rtmClient;
    }

    // Register RTM message handler (via rtm_client.js onRTMMessage)
    if (!_rtmHandlerRegistered) {
      try {
        const rtm = require('../../rtm_client');
        rtm.onRTMMessage(handleRTMMessage);
        _rtmHandlerRegistered = true;
        logger.info('Registered RTM message handler for shen.vitals');
      } catch (err) {
        logger.warn(`Could not register RTM handler: ${err.message}`);
      }
    }
  },

  /**
   * No tools for Shen — data flows from client via RTM, not via tool calls.
   */
  getToolDefinitions() {
    return [];
  },

  getToolHandlers() {
    return {};
  },

  /**
   * Called on each /chat/completions request.
   */
  onRequest(ctx) {
    // Track channel → appId so RTM handler can store vitals even before /register-agent
    if (ctx && ctx.appId && ctx.channel) {
      channelAppIdMap.set(ctx.channel, ctx.appId);
    }
  },

  /**
   * No local injection — vitals are pushed via Agent Update API.
   */
  getSystemInjection() {
    return null;
  },

  /**
   * Called after LLM response — nothing to forward for Shen.
   */
  onResponse(_ctx) {},

  /**
   * Register agent with shared updater.
   */
  onAgentRegistered(appId, channel, agentId, authHeader, agentEndpoint, prompt, earlyParams) {
    channelRuntimeKeys.set(channel, earlyParams?.meeting_runtime_key || '');
    videoBiomarkerChannels.set(channel, earlyParams?.video_biomarkers_enabled !== false);
    if (earlyParams?.meeting_mode) {
      meetingModeChannels.add(channel);
    } else {
      meetingModeChannels.delete(channel);
    }
    if (!earlyParams?.meeting_mode) {
      agentUpdater.registerAgent(appId, channel, agentId, authHeader, agentEndpoint, prompt);
    }
    logger.info(`Agent registered: ${agentId} on ${channel} meeting_mode=${!!earlyParams?.meeting_mode}`);
  },

  /**
   * Clean up when agent disconnects.
   */
  onAgentUnregistered(appId, channel, agentId, runtimeKey) {
    const activeRuntimeKey = channelRuntimeKeys.get(channel) || '';
    if (activeRuntimeKey && runtimeKey && activeRuntimeKey !== runtimeKey) {
      logger.info(`Skipping stale Shen cleanup for channel=${channel} runtime=${runtimeKey}`);
      return;
    }
    if (!meetingModeChannels.has(channel)) {
      agentUpdater.unregisterAgent(appId, channel);
    }
    meetingModeChannels.delete(channel);
    channelRuntimeKeys.delete(channel);
    videoBiomarkerChannels.delete(channel);
    channelAppIdMap.delete(channel);
    shenStore.clear(appId, channel);
    logger.info(`Agent unregistered: ${agentId} on ${channel}`);
  },

  /**
   * Clean up on server shutdown.
   */
  shutdown() {
    channelAppIdMap.clear();
    shenStore.clearAll();
    logger.info('Shen module shut down');
  },
};
