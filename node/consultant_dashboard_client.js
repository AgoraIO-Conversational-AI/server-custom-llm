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
    displayName: earlyParams.display_name || '',
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
  const safetyLevelAvg = biomarkers?.safety?.level_stats?.avg;
  if (typeof safetyLevelAvg === 'number' && !Number.isNaN(safetyLevelAvg)) {
    averages.safety_level = safetyLevelAvg;
  }
  return averages;
}

function normalizeDashboardSummary(summary) {
  if (summary && typeof summary === 'object' && !Array.isArray(summary)) {
    const briefOverview = summary.brief_overview || summary.overview || '';
    const fullSummary = summary.full_summary || summary.overview || '';
    const headline = summary.key_point_summary?.headline || briefOverview;
    const body = summary.key_point_summary?.body || fullSummary;
    return {
      key_point_summary: {
        headline,
        body,
      },
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
    key_point_summary: {
      headline: typeof summary === 'string' ? summary : '',
      body: typeof summary === 'string' ? summary : '',
    },
    brief_overview: typeof summary === 'string' ? summary : '',
    overview: typeof summary === 'string' ? summary : '',
    full_summary: typeof summary === 'string' ? summary : '',
    biomarker_summary: '',
    risk_overview: '',
    follow_up: '',
    source: 'custom-llm',
  };
}

function normalizeClientKeyPointSummary(summary) {
  if (!summary || typeof summary !== 'object' || Array.isArray(summary)) return null;
  const headline = summary.key_point_summary?.headline || summary.headline || summary.brief_overview || summary.overview || '';
  const body = summary.key_point_summary?.body || summary.body || summary.full_summary || '';
  if (!headline && !body) return null;
  return {
    key_point_summary: {
      headline,
      body,
    },
    headline,
    body,
    brief_overview: headline,
    overview: headline,
    full_summary: body,
    source: summary.source || 'custom-llm',
  };
}

function buildSessionCompletePayload(state, summary, biomarkers, memoryStorageKey, transcript) {
  const summaryBundle = summary && typeof summary === 'object' && !Array.isArray(summary) && summary.dashboardSummary
    ? summary
    : { dashboardSummary: summary };
  const aiPersonalSummary = !state.dashboard.meetingMode
    ? normalizeClientKeyPointSummary(summaryBundle.clientKeyPointSummary)
    : null;
  const humanPersonalSummary = state.dashboard.meetingMode
    ? normalizeClientKeyPointSummary(summaryBundle.clientKeyPointSummary)
    : null;
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
    summary: normalizeDashboardSummary(summaryBundle.dashboardSummary),
    ai_personal_summary: aiPersonalSummary,
    human_personal_summary: humanPersonalSummary,
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

async function getClientContext(dashboard, logger) {
  if (!dashboard?.baseUrl || !dashboard?.sharedSecret || !dashboard?.clientId) {
    throw new Error('dashboard config missing for client context');
  }

  const url = new URL('/internal/client-context', dashboard.baseUrl);
  url.searchParams.set('client_id', dashboard.clientId);
  const pathname = url.pathname;
  const query = url.searchParams.toString();
  const headers = buildSignedHeaders(
    dashboard.sharedSecret,
    'GET',
    pathname,
    query
  );

  if (logger) {
    logger.info(`Fetching client-context from ${url.toString()} client_id=${dashboard.clientId}`);
  }

  const response = await fetch(url.toString(), {
    method: 'GET',
    headers,
    signal: AbortSignal.timeout(8000),
  });

  const responseText = await response.text();
  if (!response.ok) {
    throw new Error(`client context failed: ${response.status} ${responseText}`);
  }
  return responseText ? JSON.parse(responseText) : {};
}

async function postCrisisEscalateInit(dashboard, payloadObject, logger) {
  if (!dashboard?.baseUrl || !dashboard?.sharedSecret) {
    throw new Error('dashboard config missing for crisis escalate init');
  }

  const url = new URL('/internal/crisis-escalate-init', dashboard.baseUrl);
  const payload = JSON.stringify(payloadObject);
  const headers = buildSignedHeaders(
    dashboard.sharedSecret,
    'POST',
    url.pathname,
    payload
  );

  if (logger) {
    logger.info(
      `Posting crisis-escalate-init to ${url.toString()} meeting_id=${payloadObject.meeting_id || 'none'} client_id=${payloadObject.client_id || 'none'}`
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
    throw new Error(`crisis escalate init failed: ${response.status} ${responseText}`);
  }
  return responseText ? JSON.parse(responseText) : { ok: true };
}

async function postCrisisEscalateStatus(dashboard, payloadObject, logger) {
  if (!dashboard?.baseUrl || !dashboard?.sharedSecret) {
    throw new Error('dashboard config missing for crisis escalate status');
  }

  const url = new URL('/internal/crisis-escalate-status', dashboard.baseUrl);
  const payload = JSON.stringify(payloadObject);
  const headers = buildSignedHeaders(
    dashboard.sharedSecret,
    'POST',
    url.pathname,
    payload
  );

  if (logger) {
    logger.info(
      `Posting crisis-escalate-status to ${url.toString()} event_id=${payloadObject.escalation_event_id || 'none'} phase=${payloadObject.phase || 'none'}`
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
    throw new Error(`crisis escalate status failed: ${response.status} ${responseText}`);
  }
  return responseText ? JSON.parse(responseText) : { ok: true };
}

module.exports = {
  buildSignedHeaders,
  buildSessionCompletePayload,
  createDashboardConfig,
  flattenBiomarkers,
  getClientContext,
  postCrisisEscalateInit,
  postCrisisEscalateStatus,
  postSessionComplete,
};
