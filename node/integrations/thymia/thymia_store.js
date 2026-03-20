/**
 * In-memory store for Thymia voice biomarker results, keyed by appId:channel.
 *
 * Stores wellness scores, clinical indicators, and safety assessments
 * from real-time Thymia Sentinel analysis. Parallel to conversation_store.js.
 */

const logger = {
  info: (message) => console.log(`INFO: ${message}`),
  debug: (message) => console.log(`DEBUG: ${message}`),
  error: (message, error) => console.error(`ERROR: ${message}`, error),
};

const CLEANUP_INTERVAL = 3600 * 1000; // 1 hour
const MAX_AGE = 86400 * 1000; // 24 hours

// In-memory store: "appId:channel" -> ThymiaData
const store = {};

function getKey(appId, channel) {
  return `${appId}:${channel}`;
}

/**
 * Get or create a Thymia data entry for a channel.
 */
function getOrCreate(appId, channel) {
  const key = getKey(appId, channel);
  if (!store[key]) {
    store[key] = {
      wellness: {
        distress: null,
        stress: null,
        burnout: null,
        fatigue: null,
        low_self_esteem: null,
      },
      clinical: {
        depression_probability: null,
        anxiety_probability: null,
        severity: null,
      },
      safety: {
        level: null,
        alert: false,
        concerns: [],
        recommended_actions: [],
      },
      // All raw biomarkers from passthrough (emotions, etc.)
      biomarkers: {},
      progress: {},
      resultsCount: 0,
      lastUpdated: Date.now(),
      sessionActive: false,
    };
    logger.info(`Thymia store: created entry for ${key}`);
  }
  return store[key];
}

/**
 * Update wellness scores from a Thymia PolicyResult.
 *
 * Actual Thymia response format:
 * - Passthrough: { type:"POLICY_RESULT", policy:"passthrough", result:{ biomarkers:{ stress:0.72, ... } } }
 * - Safety:      { type:"POLICY_RESULT", policy:"safety_analysis", policy_name:"agora_safety_analysis", result:{ level:1, alert:"monitor", concerns:[...], recommended_actions:[...] } }
 */
function updateFromPolicyResult(appId, channel, result) {
  const data = getOrCreate(appId, channel);
  const inner = result.result || {};

  const biomarkers = inner.biomarkers || inner.biomarker_summary;
  if (result.policy === 'passthrough' && biomarkers) {
    const b = biomarkers;

    // Store ALL numeric biomarkers generically (emotions, wellness, clinical, etc.)
    for (const [name, value] of Object.entries(b)) {
      if (typeof value === 'number') {
        data.biomarkers[name] = value;
      }
    }

    // Also map known wellness fields
    if (b.distress !== undefined) data.wellness.distress = b.distress;
    if (b.stress !== undefined) data.wellness.stress = b.stress;
    if (b.burnout !== undefined) data.wellness.burnout = b.burnout;
    if (b.fatigue !== undefined) data.wellness.fatigue = b.fatigue;
    if (b.low_self_esteem !== undefined) data.wellness.low_self_esteem = b.low_self_esteem;

    // Also map known clinical fields
    if (b.depression_probability !== undefined) data.clinical.depression_probability = b.depression_probability;
    if (b.anxiety_probability !== undefined) data.clinical.anxiety_probability = b.anxiety_probability;
    if (b.severity !== undefined) data.clinical.severity = b.severity;
  }

  // Safety analysis — also extract biomarkers if present
  // API returns policy:"safety_analysis" + policy_name:"agora_safety_analysis"
  const isSafety = result.policy_name === 'agora_safety_analysis' || result.policy === 'safety_analysis';
  if (isSafety) {
    const safeBio = inner.biomarkers || inner.biomarker_summary;
    if (safeBio) {
      for (const [name, value] of Object.entries(safeBio)) {
        if (typeof value === 'number') {
          data.biomarkers[name] = value;
        }
      }
      if (safeBio.distress !== undefined) data.wellness.distress = safeBio.distress;
      if (safeBio.stress !== undefined) data.wellness.stress = safeBio.stress;
      if (safeBio.burnout !== undefined) data.wellness.burnout = safeBio.burnout;
      if (safeBio.fatigue !== undefined) data.wellness.fatigue = safeBio.fatigue;
      if (safeBio.low_self_esteem !== undefined) data.wellness.low_self_esteem = safeBio.low_self_esteem;
    }
  }
  if (isSafety) {
    data.safety.level = inner.level !== undefined ? inner.level : data.safety.level;
    data.safety.alert = inner.alert || false;
    data.safety.concerns = inner.concerns || [];
    data.safety.recommended_actions = inner.recommended_actions || data.safety.recommended_actions;
  }

  data.resultsCount++;
  data.lastUpdated = Date.now();

  logger.debug(
    `Thymia store: updated ${getKey(appId, channel)} (${data.resultsCount} results)`
  );
}

/**
 * Update progress info from a Thymia PROGRESS message.
 *
 * Format: { type:"PROGRESS", biomarkers:{ helios:{ speech_seconds, trigger_seconds, processing }, apollo:{...} }, timestamp }
 */
function updateProgress(appId, channel, msg) {
  const data = getOrCreate(appId, channel);
  if (!data.progress) {
    data.progress = {};
  }
  if (msg.biomarkers) {
    for (const [name, info] of Object.entries(msg.biomarkers)) {
      data.progress[name] = {
        speech_seconds: info.speech_seconds,
        trigger_seconds: info.trigger_seconds,
        processing: info.processing,
      };
    }
  }
  data.lastUpdated = Date.now();
}

/**
 * Get current metrics for a channel. Returns null if no data.
 */
function getMetrics(appId, channel) {
  const key = getKey(appId, channel);
  const data = store[key];
  if (!data || data.resultsCount === 0) {
    return null;
  }

  return {
    wellness: { ...data.wellness },
    clinical: { ...data.clinical },
    safety: { ...data.safety },
    biomarkers: { ...data.biomarkers },
    progress: { ...data.progress },
    resultsCount: data.resultsCount,
    lastUpdated: new Date(data.lastUpdated).toISOString(),
    sessionActive: data.sessionActive,
  };
}

/**
 * Mark a session as active (Thymia connected).
 */
function setSessionActive(appId, channel, active) {
  const data = getOrCreate(appId, channel);
  data.sessionActive = active;
  data.lastUpdated = Date.now();
}

/**
 * Remove a channel's data.
 */
function remove(appId, channel) {
  const key = getKey(appId, channel);
  delete store[key];
  logger.info(`Thymia store: removed ${key}`);
}

/**
 * Periodic cleanup of stale entries.
 */
function cleanup() {
  const now = Date.now();
  let removed = 0;
  for (const key of Object.keys(store)) {
    if (now - store[key].lastUpdated > MAX_AGE) {
      delete store[key];
      removed++;
    }
  }
  if (removed) {
    logger.info(`Thymia store: cleaned up ${removed} stale entries`);
  }
}

const cleanupTimer = setInterval(() => {
  try {
    cleanup();
  } catch (e) {
    logger.error('Thymia store cleanup error:', e);
  }
}, CLEANUP_INTERVAL);

if (cleanupTimer.unref) {
  cleanupTimer.unref();
}

logger.info('Thymia store initialized');

module.exports = {
  getOrCreate,
  updateFromPolicyResult,
  updateProgress,
  getMetrics,
  setSessionActive,
  remove,
  cleanup,
};
