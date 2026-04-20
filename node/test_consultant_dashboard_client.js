const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildSessionCompletePayload,
  createDashboardConfig,
  flattenBiomarkers,
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
  };

  const payload = buildSessionCompletePayload(
    state,
    {
      brief_overview: 'Generalized session summary.',
      full_summary: 'Longer consultant-readable summary with continuity details.',
      biomarker_summary: 'Elevated stress with increased heart rate.',
      risk_overview: 'Highest safety level reached during the call was 3.',
      follow_up: 'Review safety plan and confirm external support.',
      source: 'custom-llm',
    },
    {
      voice: { stress: { avg: 0.72, count: 4, min: 0.5, max: 0.9 } },
      vitals: { heart_rate_bpm: { avg: 84.1, count: 8, min: 74, max: 96 } },
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
  assert.equal(payload.summary.biomarker_summary, 'Elevated stress with increased heart rate.');
  assert.equal(payload.summary.risk_overview, 'Highest safety level reached during the call was 3.');
  assert.equal(payload.summary.follow_up, 'Review safety plan and confirm external support.');
  assert.equal(payload.biomarkers.averages.stress, 0.72);
  assert.equal(payload.biomarkers.averages.heart_rate_bpm, 84.1);
  assert.equal(payload.transcript.provider, 'agora_stt');
  assert.equal(payload.transcript.text, 'Client discussed stress at work.');
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
