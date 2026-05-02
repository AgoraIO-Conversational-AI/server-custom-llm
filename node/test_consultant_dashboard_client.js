const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildSignedHeaders,
  buildSessionCompletePayload,
  createDashboardConfig,
  flattenBiomarkers,
  getClientContext,
  postCrisisEscalateInit,
  postCrisisEscalateStatus,
  postSessionComplete,
} = require('./consultant_dashboard_client');

test('createDashboardConfig returns null when required fields are missing', () => {
  assert.equal(createDashboardConfig({}), null);
});

test('createDashboardConfig returns config when metadata is present', () => {
  const config = createDashboardConfig({
    consultant_dashboard_url: 'http://127.0.0.1:8090',
    consultant_dashboard_shared_secret: 'secret',
    client_id: 'client-123',
    consultant_id: 'consultant-456',
    profile_name: 'therapy',
  });

  assert.equal(config.baseUrl, 'http://127.0.0.1:8090');
  assert.equal(config.clientId, 'client-123');
  assert.equal(config.consultantId, 'consultant-456');
  assert.equal(config.profileName, 'therapy');
});

test('createDashboardConfig accepts generic meeting context fields', () => {
  const config = createDashboardConfig({
    meeting_context_url: 'http://127.0.0.1:8090',
    meeting_shared_secret: 'secret',
    client_id: 'client-123',
    consultant_id: 'consultant-456',
    meeting_id: 'meeting-789',
    meeting_runtime_key: 'test-app:room_abc:meeting-789',
    meeting_mode: true,
  });

  assert.equal(config.baseUrl, 'http://127.0.0.1:8090');
  assert.equal(config.meetingId, 'meeting-789');
  assert.equal(config.meetingRuntimeKey, 'test-app:room_abc:meeting-789');
  assert.equal(config.meetingMode, true);
});

test('flattenBiomarkers produces averages map', () => {
  const averages = flattenBiomarkers({
    voice: { stress: { avg: 0.72, count: 4, min: 0.5, max: 0.9 } },
    vitals: { heart_rate_bpm: { avg: 84.1, count: 8, min: 74, max: 96 } },
  });

  assert.deepEqual(averages, {
    stress: 0.72,
    heart_rate_bpm: 84.1,
  });
});

test('buildSessionCompletePayload produces dashboard-compatible structure', () => {
  const state = {
    channel: 'demo-channel',
    sessionId: 'sess-123',
    startedAt: '2026-04-13T18:00:00Z',
    startedAtMs: Date.now() - 300000,
    dashboard: {
      clientId: 'client-123',
      consultantId: 'consultant-456',
      profileName: 'therapy',
    },
    dashboardContext: {
      ai_personal_summary: {
        key_point_summary: {
          headline: 'Existing Client Key Point Summary',
          body: 'Existing body',
        },
      },
    },
  };

  const payload = buildSessionCompletePayload(
    state,
    {
      dashboardSummary: {
        key_point_summary: {
          headline: 'Session Key Point Summary',
          body: 'Longer consultant-readable summary with continuity details.',
        },
        brief_overview: 'Generalized session summary.',
        full_summary: 'Longer consultant-readable summary with continuity details.',
        biomarker_summary: 'Elevated stress with increased heart rate.',
        risk_overview: 'Highest safety level reached during the call was 3.',
        follow_up: 'Review safety plan and confirm external support.',
        source: 'custom-llm',
      },
      clientKeyPointSummary: {
        key_point_summary: {
          headline: 'Client Key Point Summary - AI Sessions',
          body: 'Recurring stress and work pressure across recent AI sessions.',
        },
      },
    },
    {
      voice: { stress: { avg: 0.72, count: 4, min: 0.5, max: 0.9 } },
      vitals: { heart_rate_bpm: { avg: 84.1, count: 8, min: 74, max: 96 } },
      safety: { level_stats: { avg: 2.25, max: 3, count: 4, min: 1 } },
    },
    'users/u123/sessions/abc.enc',
    { provider: 'agora_stt', text: 'Client discussed stress at work.' }
  );

  assert.equal(payload.client_id, 'client-123');
  assert.equal(payload.consultant_id, 'consultant-456');
  assert.equal(payload.session_kind, 'avatar_ai_session');
  assert.equal(payload.profile, 'therapy');
  assert.equal(payload.memory_storage_key, 'users/u123/sessions/abc.enc');
  assert.equal(payload.summary.brief_overview, 'Generalized session summary.');
  assert.equal(payload.summary.overview, 'Generalized session summary.');
  assert.equal(payload.summary.full_summary, 'Longer consultant-readable summary with continuity details.');
  assert.equal(payload.summary.key_point_summary.headline, 'Session Key Point Summary');
  assert.equal(payload.summary.key_point_summary.body, 'Longer consultant-readable summary with continuity details.');
  assert.equal(payload.summary.biomarker_summary, 'Elevated stress with increased heart rate.');
  assert.equal(payload.summary.risk_overview, 'Highest safety level reached during the call was 3.');
  assert.equal(payload.summary.follow_up, 'Review safety plan and confirm external support.');
  assert.equal(payload.biomarkers.averages.stress, 0.72);
  assert.equal(payload.biomarkers.averages.heart_rate_bpm, 84.1);
  assert.equal(payload.biomarkers.averages.safety_level, 2.25);
  assert.equal(payload.ai_personal_summary.key_point_summary.headline, 'Client Key Point Summary - AI Sessions');
  assert.equal(payload.transcript.provider, 'agora_stt');
  assert.equal(payload.transcript.text, 'Client discussed stress at work.');
});

test('buildSessionCompletePayload preserves existing client KPS when dashboard context is unavailable', () => {
  const payload = buildSessionCompletePayload(
    {
      channel: 'demo-channel',
      sessionId: 'sess-no-ctx',
      startedAt: '2026-04-13T18:00:00Z',
      startedAtMs: Date.now() - 300000,
      dashboard: {
        clientId: 'client-123',
        consultantId: 'consultant-456',
        profileName: 'therapy',
        meetingMode: false,
      },
      dashboardContext: null,
    },
    {
      dashboardSummary: {
        key_point_summary: { headline: 'Session Key Point Summary', body: 'Body' },
        brief_overview: 'Session Key Point Summary',
        full_summary: 'Body',
      },
      clientKeyPointSummary: {
        key_point_summary: {
          headline: 'Client Key Point Summary - AI Sessions',
          body: 'Should not be sent without dashboard context.',
        },
      },
    },
    { voice: {}, vitals: {} },
    '',
    null
  );

  assert.equal(payload.ai_personal_summary, null);
  assert.equal(payload.human_personal_summary, null);
});

test('buildSessionCompletePayload sends fresh AI KPS for a first AI session', () => {
  const payload = buildSessionCompletePayload(
    {
      channel: 'demo-channel',
      sessionId: 'sess-first-ai',
      startedAt: '2026-04-13T18:00:00Z',
      startedAtMs: Date.now() - 300000,
      dashboard: {
        clientId: 'client-123',
        consultantId: 'consultant-456',
        profileName: 'therapy',
        meetingMode: false,
      },
      dashboardContext: {
        ai_personal_summary: null,
        ai_session_count: 0,
      },
    },
    {
      dashboardSummary: {
        key_point_summary: { headline: 'Session Key Point Summary', body: 'Body' },
        brief_overview: 'Session Key Point Summary',
        full_summary: 'Body',
      },
      clientKeyPointSummary: {
        key_point_summary: {
          headline: 'Client Key Point Summary - AI Sessions',
          body: 'Fresh first-session KPS body.',
        },
      },
    },
    { voice: {}, vitals: {} },
    '',
    null
  );

  assert.equal(payload.ai_personal_summary.key_point_summary.headline, 'Client Key Point Summary - AI Sessions');
  assert.equal(payload.ai_personal_summary.key_point_summary.body, 'Fresh first-session KPS body.');
  assert.equal(payload.human_personal_summary, null);
});

test('buildSessionCompletePayload includes meeting metadata when present', () => {
  const payload = buildSessionCompletePayload(
    {
      channel: 'meeting-channel',
      sessionId: 'sess-meeting',
      startedAt: '2026-04-13T18:00:00Z',
      startedAtMs: Date.now() - 300000,
      dashboard: {
        clientId: 'client-123',
        consultantId: 'consultant-456',
        profileName: 'therapy',
        meetingId: 'meeting-789',
        meetingMode: true,
      },
    },
    { brief_overview: 'Meeting finished.', full_summary: 'Meeting finished.' },
    { voice: {}, vitals: {} },
    ''
  );

  assert.equal(payload.session_kind, 'consultant_live_session');
  assert.equal(payload.meeting_id, 'meeting-789');
});

test('buildSessionCompletePayload preserves backward compatibility for string summaries', () => {
  const state = {
    channel: 'demo-channel',
    sessionId: 'sess-456',
    startedAt: '2026-04-13T18:00:00Z',
    startedAtMs: Date.now() - 300000,
    dashboard: {
      clientId: 'client-123',
      consultantId: 'consultant-456',
      profileName: 'therapy',
    },
  };

  const payload = buildSessionCompletePayload(
    state,
    'Legacy summary string.',
    { voice: {}, vitals: {} },
    ''
  );

  assert.equal(payload.summary.brief_overview, 'Legacy summary string.');
  assert.equal(payload.summary.overview, 'Legacy summary string.');
  assert.equal(payload.summary.full_summary, 'Legacy summary string.');
  assert.equal(payload.summary.key_point_summary.headline, 'Legacy summary string.');
  assert.equal(payload.summary.key_point_summary.body, 'Legacy summary string.');
  assert.equal(payload.summary.biomarker_summary, '');
  assert.equal(payload.summary.risk_overview, '');
  assert.equal(payload.summary.follow_up, '');
});

test('postSessionComplete sends a timeout signal with the dashboard request', async () => {
  const originalFetch = global.fetch;
  let capturedSignal = null;
  global.fetch = async (_url, options) => {
    capturedSignal = options.signal;
    return {
      ok: true,
      text: async () => '{"ok":true}',
    };
  };

  try {
    const result = await postSessionComplete(
      {
        channel: 'demo-channel',
        sessionId: 'sess-789',
        startedAt: '2026-04-13T18:00:00Z',
        startedAtMs: Date.now() - 300000,
        dashboard: {
          baseUrl: 'http://127.0.0.1:8090',
          sharedSecret: 'secret',
          clientId: 'client-123',
          consultantId: 'consultant-456',
          profileName: 'therapy',
        },
      },
      'Legacy summary string.',
      { voice: {}, vitals: {} },
      '',
      null
    );

    assert.deepEqual(result, { ok: true });
    assert.ok(capturedSignal);
  } finally {
    global.fetch = originalFetch;
  }
});

test('getClientContext sends a signed GET request and parses response', async () => {
  const originalFetch = global.fetch;
  let captured = null;
  global.fetch = async (url, options) => {
    captured = { url, options };
    return {
      ok: true,
      text: async () => '{"client_id":"client-123","ai_session_count":4,"ai_personal_summary":{"key_point_summary":{"headline":"Client Key Point Summary - AI Sessions","body":"Recurring AI themes."}}}',
    };
  };

  try {
    const result = await getClientContext(
      {
        baseUrl: 'http://127.0.0.1:8090',
        sharedSecret: 'secret',
        clientId: 'client-123',
      }
    );

    assert.equal(result.client_id, 'client-123');
    assert.equal(result.ai_session_count, 4);
    assert.equal(result.ai_personal_summary.key_point_summary.body, 'Recurring AI themes.');
    assert.equal(captured.options.method, 'GET');
    assert.ok(captured.options.headers['X-Consultant-Signature']);
    assert.match(captured.url, /client_id=client-123/);
  } finally {
    global.fetch = originalFetch;
  }
});

test('buildSignedHeaders returns consultant signing headers', () => {
  const headers = buildSignedHeaders('secret', 'POST', '/internal/crisis-escalate-init', '{"ok":true}');
  assert.ok(headers['X-Consultant-Timestamp']);
  assert.ok(headers['X-Consultant-Signature']);
  assert.equal(headers['Content-Type'], 'application/json');
});

test('postCrisisEscalateInit posts signed payload and parses response', async () => {
  const originalFetch = global.fetch;
  let captured = null;
  global.fetch = async (url, options) => {
    captured = { url, options };
    return {
      ok: true,
      text: async () => '{"ok":true,"escalate":true,"channel_name":"room_1"}',
    };
  };

  try {
    const result = await postCrisisEscalateInit(
      {
        baseUrl: 'http://127.0.0.1:8090',
        sharedSecret: 'secret',
      },
      {
        meeting_id: 'meeting-1',
        client_id: 'client-1',
        level: 3,
        alert: 'crisis',
      }
    );

    assert.equal(result.escalate, true);
    assert.equal(result.channel_name, 'room_1');
    assert.equal(captured.options.method, 'POST');
    assert.ok(captured.options.headers['X-Consultant-Signature']);
  } finally {
    global.fetch = originalFetch;
  }
});

test('postCrisisEscalateStatus posts signed payload and parses response', async () => {
  const originalFetch = global.fetch;
  let captured = null;
  global.fetch = async (url, options) => {
    captured = { url, options };
    return {
      ok: true,
      text: async () => '{"ok":true,"phase":"answered"}',
    };
  };

  try {
    const result = await postCrisisEscalateStatus(
      {
        baseUrl: 'http://127.0.0.1:8090',
        sharedSecret: 'secret',
      },
      {
        escalation_event_id: 'esc-1',
        phase: 'answered',
      }
    );

    assert.equal(result.phase, 'answered');
    assert.equal(captured.options.method, 'POST');
    assert.ok(captured.options.headers['X-Consultant-Signature']);
  } finally {
    global.fetch = originalFetch;
  }
});
