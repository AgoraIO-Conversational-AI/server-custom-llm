const crypto = require('crypto');

function createDashboardConfig(earlyParams) {
  if (!earlyParams) return null;
  const baseUrl = earlyParams.consultant_dashboard_url || '';
  const sharedSecret = earlyParams.consultant_dashboard_shared_secret || '';
  const clientId = earlyParams.client_id || '';
  if (!baseUrl || !sharedSecret || !clientId) return null;
  return {
    baseUrl,
    sharedSecret,
    clientId,
    consultantId: earlyParams.consultant_id || '',
    consultantName: earlyParams.consultant_name || '',
    profileName: earlyParams.profile_name || 'default',
  };
}

function flattenBiomarkers(biomarkers) {
  const averages = {};
  const sections = [biomarkers?.voice || {}, biomarkers?.vitals || {}];
  for (const section of sections) {
    for (const [key, value] of Object.entries(section)) {
      if (value && typeof value.avg === 'number' && !Number.isNaN(value.avg)) {
        averages[key] = value.avg;
      }
    }
  }
  return averages;
}

function buildSessionCompletePayload(state, summary, biomarkers, memoryStorageKey) {
  return {
    client_id: state.dashboard.clientId,
    consultant_id: state.dashboard.consultantId,
    session_id: state.sessionId,
    profile: state.dashboard.profileName,
    channel: state.channel,
    started_at: state.startedAt,
    ended_at: new Date().toISOString(),
    duration_seconds: Math.max(0, Math.round((Date.now() - state.startedAtMs) / 1000)),
    status: 'completed',
    summary: {
      overview: summary,
      source: 'custom-llm',
    },
    biomarkers: {
      averages: flattenBiomarkers(biomarkers),
      voice: biomarkers?.voice || {},
      vitals: biomarkers?.vitals || {},
    },
    memory_storage_key: memoryStorageKey || '',
    alerts: [],
  };
}

function buildSignedHeaders(sharedSecret, method, pathname, payload) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const canonical = `${timestamp}.${method}.${pathname}.${payload}`;
  const signature = crypto
    .createHmac('sha256', sharedSecret)
    .update(canonical)
    .digest('hex');
  return {
    'Content-Type': 'application/json',
    'X-Consultant-Timestamp': timestamp,
    'X-Consultant-Signature': signature,
  };
}

async function postSessionComplete(state, summary, biomarkers, memoryStorageKey, logger) {
  if (!state?.dashboard) return null;

  const url = new URL('/internal/session-complete', state.dashboard.baseUrl);
  const payload = JSON.stringify(
    buildSessionCompletePayload(state, summary, biomarkers, memoryStorageKey)
  );
  const headers = buildSignedHeaders(
    state.dashboard.sharedSecret,
    'POST',
    url.pathname,
    payload
  );

  const response = await fetch(url.toString(), {
    method: 'POST',
    headers,
    body: payload,
  });

  const responseText = await response.text();
  if (!response.ok) {
    throw new Error(`dashboard post failed: ${response.status} ${responseText}`);
  }

  if (logger) {
    logger.info(
      `Posted session-complete to dashboard for client_id=${state.dashboard.clientId} session_id=${state.sessionId}`
    );
  }

  try {
    return JSON.parse(responseText);
  } catch (_err) {
    return { ok: true };
  }
}

module.exports = {
  buildSessionCompletePayload,
  createDashboardConfig,
  flattenBiomarkers,
  postSessionComplete,
};
