const crypto = require('crypto');

function createDashboardConfig(earlyParams) {
  if (!earlyParams) return null;
  const baseUrl = earlyParams.meeting_context_url || earlyParams.consultant_dashboard_url || '';
  const sharedSecret = earlyParams.meeting_shared_secret || earlyParams.consultant_dashboard_shared_secret || '';
  const clientId = earlyParams.client_id || '';
  if (!baseUrl || !sharedSecret || !clientId) return null;
  return {
    baseUrl,
    sharedSecret,
    clientId,
    consultantId: earlyParams.consultant_id || '',
    consultantName: earlyParams.consultant_name || '',
    profileName: earlyParams.profile_name || 'default',
    meetingId: earlyParams.meeting_id || '',
    meetingMode: !!earlyParams.meeting_mode,
    meetingRuntimeKey: earlyParams.meeting_runtime_key || '',
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

function normalizeDashboardSummary(summary) {
  if (summary && typeof summary === 'object' && !Array.isArray(summary)) {
    const briefOverview = summary.brief_overview || summary.overview || '';
    const fullSummary = summary.full_summary || summary.overview || '';
    return {
      brief_overview: briefOverview,
      overview: briefOverview,
      full_summary: fullSummary,
      biomarker_summary: summary.biomarker_summary || '',
      risk_overview: summary.risk_overview || '',
      follow_up: summary.follow_up || '',
      source: summary.source || 'custom-llm',
    };
  }

  return {
    brief_overview: typeof summary === 'string' ? summary : '',
    overview: typeof summary === 'string' ? summary : '',
    full_summary: typeof summary === 'string' ? summary : '',
    biomarker_summary: '',
    risk_overview: '',
    follow_up: '',
    source: 'custom-llm',
  };
}

function buildSessionCompletePayload(state, summary, biomarkers, memoryStorageKey, transcript) {
  return {
    client_id: state.dashboard.clientId,
    consultant_id: state.dashboard.consultantId,
    session_id: state.sessionId,
    session_kind: state.dashboard.meetingMode ? 'consultant_live_session' : 'avatar_ai_session',
    meeting_id: state.dashboard.meetingId || '',
    profile: state.dashboard.profileName,
    channel: state.channel,
    started_at: state.startedAt,
    ended_at: new Date().toISOString(),
    duration_seconds: Math.max(0, Math.round((Date.now() - state.startedAtMs) / 1000)),
    status: 'completed',
    summary: normalizeDashboardSummary(summary),
    biomarkers: {
      averages: flattenBiomarkers(biomarkers),
      voice: biomarkers?.voice || {},
      vitals: biomarkers?.vitals || {},
      safety: biomarkers?.safety || {},
    },
    memory_storage_key: memoryStorageKey || '',
    transcript: transcript || null,
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

async function postSessionComplete(state, summary, biomarkers, memoryStorageKey, logger, transcript) {
  if (!state?.dashboard) return null;

  const url = new URL('/internal/session-complete', state.dashboard.baseUrl);
  const payloadObject = buildSessionCompletePayload(state, summary, biomarkers, memoryStorageKey, transcript);
  const payload = JSON.stringify(payloadObject);
  const headers = buildSignedHeaders(
    state.dashboard.sharedSecret,
    'POST',
    url.pathname,
    payload
  );

  if (logger) {
    logger.info(
      `Posting session-complete to ${url.toString()} for client_id=${state.dashboard.clientId} ` +
      `session_id=${state.sessionId} summary_overview_len=${(payloadObject.summary?.overview || '').length} ` +
      `memory_key=${memoryStorageKey || 'none'}`
    );
  }

  const response = await fetch(url.toString(), {
    method: 'POST',
    headers,
    body: payload,
    signal: AbortSignal.timeout(8000),
  });

  const responseText = await response.text();
  if (!response.ok) {
    throw new Error(`dashboard post failed: ${response.status} ${responseText}`);
  }

  if (logger) {
    logger.info(
      `Posted session-complete to dashboard for client_id=${state.dashboard.clientId} ` +
      `session_id=${state.sessionId} response=${responseText || '{}'}`
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
