/**
 * In-memory store for Shen.AI camera vitals per channel.
 *
 * Unlike Thymia (server-side audio processing), Shen data arrives from the
 * client via RTM messages. The store caches the latest values for injection
 * into the LLM system prompt.
 */

const logger = {
  info: (msg) => console.log(`INFO: [ShenStore] ${msg}`),
  debug: (msg) => console.log(`DEBUG: [ShenStore] ${msg}`),
};

// Map<string, vitals> keyed by `${appId}:${channel}`
const store = new Map();

function key(appId, channel) {
  return `${appId}:${channel}`;
}

function getOrCreate(appId, channel) {
  const k = key(appId, channel);
  if (!store.has(k)) {
    store.set(k, {
      heart_rate_bpm: null,
      hrv_sdnn_ms: null,
      stress_index: null,
      breathing_rate_bpm: null,
      systolic_bp: null,
      diastolic_bp: null,
      cardiac_workload: null,
      age_years: null,
      signal_quality: null,
      measurement_state: '',
      progress: 0,
      lastUpdated: null,
    });
  }
  return store.get(k);
}

/**
 * Update vitals from a shen.vitals RTM message.
 */
function updateFromRTM(appId, channel, msg) {
  const vitals = getOrCreate(appId, channel);

  if (msg.heart_rate_bpm != null) vitals.heart_rate_bpm = msg.heart_rate_bpm;
  if (msg.hrv_sdnn_ms != null) vitals.hrv_sdnn_ms = msg.hrv_sdnn_ms;
  if (msg.stress_index != null) vitals.stress_index = msg.stress_index;
  if (msg.breathing_rate_bpm != null) vitals.breathing_rate_bpm = msg.breathing_rate_bpm;
  if (msg.systolic_bp != null) vitals.systolic_bp = msg.systolic_bp;
  if (msg.diastolic_bp != null) vitals.diastolic_bp = msg.diastolic_bp;
  if (msg.cardiac_workload != null) vitals.cardiac_workload = msg.cardiac_workload;
  if (msg.age_years != null) vitals.age_years = msg.age_years;
  if (msg.signal_quality != null) vitals.signal_quality = msg.signal_quality;
  if (msg.measurement_state) vitals.measurement_state = msg.measurement_state;
  if (msg.progress != null) vitals.progress = msg.progress;

  vitals.lastUpdated = Date.now();

  logger.debug(
    `Updated: HR=${vitals.heart_rate_bpm} HRV=${vitals.hrv_sdnn_ms} ` +
    `Stress=${vitals.stress_index} BR=${vitals.breathing_rate_bpm} ` +
    `BP=${vitals.systolic_bp}/${vitals.diastolic_bp}`
  );
}

/**
 * Get current vitals for a channel.
 */
function getVitals(appId, channel) {
  return store.get(key(appId, channel)) || null;
}

/**
 * Check if we have any meaningful vitals data.
 */
function hasVitals(appId, channel) {
  const vitals = store.get(key(appId, channel));
  return vitals && vitals.heart_rate_bpm !== null;
}

/**
 * Clear vitals for a channel.
 */
function clear(appId, channel) {
  store.delete(key(appId, channel));
  logger.info(`Cleared vitals for ${appId}:${channel}`);
}

/**
 * Clear all stored vitals.
 */
function clearAll() {
  store.clear();
  logger.info('Cleared all vitals');
}

module.exports = {
  updateFromRTM,
  getVitals,
  hasVitals,
  clear,
  clearAll,
};
