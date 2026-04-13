const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildSessionCompletePayload,
  createDashboardConfig,
  flattenBiomarkers,
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

test('flattenBiomarkers produces averages map', () => {
  const averages = flattenBiomarkers({
    voice: { stress: { avg: 0.72, count: 4 } },
    vitals: { heart_rate_bpm: { avg: 84.1, count: 8 } },
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
    'Generalized session summary.',
    {
      voice: { stress: { avg: 0.72, count: 4 } },
      vitals: { heart_rate_bpm: { avg: 84.1, count: 8 } },
    },
    'users/u123/sessions/abc.enc'
  );

  assert.equal(payload.client_id, 'client-123');
  assert.equal(payload.consultant_id, 'consultant-456');
  assert.equal(payload.profile, 'therapy');
  assert.equal(payload.memory_storage_key, 'users/u123/sessions/abc.enc');
  assert.equal(payload.summary.overview, 'Generalized session summary.');
  assert.equal(payload.biomarkers.averages.stress, 0.72);
  assert.equal(payload.biomarkers.averages.heart_rate_bpm, 84.1);
});
