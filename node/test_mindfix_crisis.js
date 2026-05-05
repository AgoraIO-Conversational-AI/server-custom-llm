// Set env BEFORE requiring the module — these are module-load constants.
process.env.CRISIS_CALL_ENABLED = 'true';
process.env.CRISIS_TRIGGER_LEVEL = '3';
process.env.CRISIS_CALL_GRACE_MS = '0';
delete process.env.LLM_API_KEY;
delete process.env.YOUR_LLM_API_KEY;
delete process.env.OPENAI_API_KEY;

const test = require('node:test');
const assert = require('node:assert/strict');

const crisisModule = require('./integrations/mindfix_crisis/mindfix_crisis');

// ─── Mock builders ───────────────────────────────────────────────────────────

function makeDashboardMock({ initResponse, statusCalls } = {}) {
  const initCalls = [];
  return {
    createDashboardConfig: (params) => ({
      baseUrl: 'http://test-dashboard',
      sharedSecret: 'test-secret',
      clientId: params.client_id || '',
      displayName: params.display_name || 'Test Client',
      meetingId: params.meeting_id || '',
      meetingMode: !!params.meeting_mode,
    }),
    postCrisisEscalateInit: async (_dashboard, payload) => {
      initCalls.push(payload);
      return (
        initResponse || {
          ok: true,
          escalate: true,
          escalation_event_id: 'evt-1',
          channel_name: payload.channel_name || 'chan-1',
          client_display_name: 'Test Client',
          escalation_phone_number: '+447700900000',
          from_phone: '+441234567890',
          sip_gateway: 'sip.example.com',
          region: 'AREA_CODE_NA',
          pstn_uid: '43455',
          rtc_token: 'rtc-token-x',
        }
      );
    },
    postCrisisEscalateStatus: async (_dashboard, payload) => {
      statusCalls.push(payload);
      return { ok: true };
    },
    initCalls,
  };
}

function makeDialMock(result) {
  const calls = [];
  return {
    fn: async (bundle) => {
      calls.push(bundle);
      return result;
    },
    calls,
  };
}

function makeAgentSpeakMocks() {
  const records = [];
  const speaks = [];
  return {
    records,
    speaks,
    recordAssistantUtterance: async (...args) => {
      records.push(args);
    },
    speakWithAgent: async (...args) => {
      speaks.push(args);
      return { ok: true, statusCode: 200 };
    },
  };
}

function setupAgent({ appId, channel, meetingMode = false, deps }) {
  crisisModule.init(null, {
    getGraceMs: () => 0,
    ...deps,
  });
  crisisModule.onAgentRegistered(appId, channel, 'agent-id', 'auth', 'http://endpoint', '', {
    client_id: 'client-1',
    meeting_id: 'meeting-1',
    meeting_mode: meetingMode,
    user_uid: '101',
    session_id: `sess-${channel}`,
  });
}

function safetyAt(level, alert = 'crisis', extras = {}) {
  return {
    level,
    alert,
    turn: 1,
    signature: `sig-${level}-${Date.now()}-${Math.random()}`,
    guidance: 'test guidance',
    concerns: [],
    ...extras,
  };
}

// Always reset module channel state between tests so (appId, channel) collisions
// can't leak across cases.
test.afterEach(() => {
  crisisModule.shutdown();
});

// ─── Tests ───────────────────────────────────────────────────────────────────

test('SIP-CM OK: announcement, dial, recipient summary, suppression', async () => {
  const statusCalls = [];
  const dashboard = makeDashboardMock({ statusCalls });
  const dial = makeDialMock({ phase: 'answered', outcome: 'OK', ok: true });
  const speak = makeAgentSpeakMocks();

  setupAgent({
    appId: 'app-ok',
    channel: 'chan-ok',
    deps: {
      dashboardClient: dashboard,
      dialOutboundIntoChannel: dial.fn,
      recordAssistantUtterance: speak.recordAssistantUtterance,
      speakWithAgent: speak.speakWithAgent,
    },
  });

  await crisisModule.onSafetyUpdate({
    appId: 'app-ok',
    channel: 'chan-ok',
    safety: safetyAt(3),
  });

  assert.equal(dashboard.initCalls.length, 1, 'init called once');
  assert.equal(dashboard.initCalls[0].channel_name, 'chan-ok');
  assert.equal(dashboard.initCalls[0].session_id, 'sess-chan-ok');
  assert.equal(dial.calls.length, 1, 'dial called once');
  assert.equal(dial.calls[0].toPhone, '+447700900000');

  // Two utterances spoken: announcement + recipient summary, both with skipModuleFanout
  assert.equal(speak.speaks.length, 2);
  assert.equal(speak.records.length, 2);
  for (const args of speak.records) {
    assert.deepEqual(args[4], { skipModuleFanout: true }, 'crisis records bypass module fan-out');
  }

  // Status posted: dialing then answered
  const phases = statusCalls.map((c) => c.phase);
  assert.deepEqual(phases, ['dialing', 'answered']);

  // Suppression on
  assert.equal(crisisModule.shouldSuppressAssistantReply('app-ok', 'chan-ok'), true);
  assert.match(crisisModule.getSuppressionInstruction('app-ok', 'chan-ok'), /Crisis/);
});

test('SIP-CM failure: announcement spoken, no recipient summary, suppression remains on', async () => {
  const statusCalls = [];
  const dashboard = makeDashboardMock({ statusCalls });
  const dial = makeDialMock({ phase: 'failed', outcome: 'busy', ok: true });
  const speak = makeAgentSpeakMocks();

  setupAgent({
    appId: 'app-fail',
    channel: 'chan-fail',
    deps: {
      dashboardClient: dashboard,
      dialOutboundIntoChannel: dial.fn,
      recordAssistantUtterance: speak.recordAssistantUtterance,
      speakWithAgent: speak.speakWithAgent,
    },
  });

  await crisisModule.onSafetyUpdate({
    appId: 'app-fail',
    channel: 'chan-fail',
    safety: safetyAt(3),
  });

  // Only the client announcement is spoken — recipient summary is gated on dial OK
  assert.equal(speak.speaks.length, 1, 'only client announcement spoken');
  assert.equal(speak.records.length, 1);

  // Status: dialing then failed
  const phases = statusCalls.map((c) => c.phase);
  assert.deepEqual(phases, ['dialing', 'failed']);
  assert.equal(statusCalls[1].provider_result, 'busy');

  // Suppression remains on after failure (escalation occurred)
  assert.equal(crisisModule.shouldSuppressAssistantReply('app-fail', 'chan-fail'), true);
});

test('Missing phone (escalate=false from dashboard) → skipped, no dial, no speak', async () => {
  const statusCalls = [];
  const dashboard = makeDashboardMock({
    statusCalls,
    initResponse: {
      ok: true,
      escalate: false,
      reason: 'missing_phone',
      escalation_event_id: 'evt-skipped',
    },
  });
  const dial = makeDialMock({ phase: 'answered', outcome: 'OK' });
  const speak = makeAgentSpeakMocks();

  setupAgent({
    appId: 'app-skip',
    channel: 'chan-skip',
    deps: {
      dashboardClient: dashboard,
      dialOutboundIntoChannel: dial.fn,
      recordAssistantUtterance: speak.recordAssistantUtterance,
      speakWithAgent: speak.speakWithAgent,
    },
  });

  await crisisModule.onSafetyUpdate({
    appId: 'app-skip',
    channel: 'chan-skip',
    safety: safetyAt(3),
  });

  assert.equal(dashboard.initCalls.length, 1);
  assert.equal(dial.calls.length, 0, 'no PSTN dial');
  assert.equal(speak.speaks.length, 0, 'no client speak');
  assert.equal(statusCalls.length, 0, 'no status updates posted on skip path');

  // Suppression NOT enabled when skipped — session continues normally
  assert.equal(crisisModule.shouldSuppressAssistantReply('app-skip', 'chan-skip'), false);
});

test('Human-human session: onSafetyUpdate is a no-op', async () => {
  const statusCalls = [];
  const dashboard = makeDashboardMock({ statusCalls });
  const dial = makeDialMock({ phase: 'answered', outcome: 'OK' });
  const speak = makeAgentSpeakMocks();

  setupAgent({
    appId: 'app-mtg',
    channel: 'chan-mtg',
    meetingMode: true, // human-human
    deps: {
      dashboardClient: dashboard,
      dialOutboundIntoChannel: dial.fn,
      recordAssistantUtterance: speak.recordAssistantUtterance,
      speakWithAgent: speak.speakWithAgent,
    },
  });

  await crisisModule.onSafetyUpdate({
    appId: 'app-mtg',
    channel: 'chan-mtg',
    safety: safetyAt(3),
  });

  assert.equal(dashboard.initCalls.length, 0);
  assert.equal(dial.calls.length, 0);
  assert.equal(speak.speaks.length, 0);
  assert.equal(crisisModule.shouldSuppressAssistantReply('app-mtg', 'chan-mtg'), false);
});

test('Level below trigger does not escalate', async () => {
  const statusCalls = [];
  const dashboard = makeDashboardMock({ statusCalls });
  const dial = makeDialMock({ phase: 'answered', outcome: 'OK' });
  const speak = makeAgentSpeakMocks();

  setupAgent({
    appId: 'app-lvl2',
    channel: 'chan-lvl2',
    deps: {
      dashboardClient: dashboard,
      dialOutboundIntoChannel: dial.fn,
      recordAssistantUtterance: speak.recordAssistantUtterance,
      speakWithAgent: speak.speakWithAgent,
    },
  });

  await crisisModule.onSafetyUpdate({
    appId: 'app-lvl2',
    channel: 'chan-lvl2',
    safety: safetyAt(2, 'professional_referral'),
  });

  assert.equal(dashboard.initCalls.length, 0);
  assert.equal(dial.calls.length, 0);
});

test('De-escalation during grace window cancels pending escalation', async () => {
  const statusCalls = [];
  const dashboard = makeDashboardMock({ statusCalls });
  const dial = makeDialMock({ phase: 'answered', outcome: 'OK' });
  const speak = makeAgentSpeakMocks();
  const timers = [];

  setupAgent({
    appId: 'app-grace',
    channel: 'chan-grace',
    deps: {
      dashboardClient: dashboard,
      dialOutboundIntoChannel: dial.fn,
      recordAssistantUtterance: speak.recordAssistantUtterance,
      speakWithAgent: speak.speakWithAgent,
      getGraceMs: () => 20000,
      setTimer: (fn, _ms) => {
        const token = { fn, cleared: false };
        timers.push(token);
        return token;
      },
      clearTimer: (token) => {
        token.cleared = true;
      },
    },
  });

  await crisisModule.onSafetyUpdate({
    appId: 'app-grace',
    channel: 'chan-grace',
    safety: safetyAt(3),
  });
  assert.match(
    crisisModule.getSystemInjection('app-grace', 'chan-grace'),
    /Do not tell the client to contact their escalation person manually/i
  );
  await crisisModule.onSafetyUpdate({
    appId: 'app-grace',
    channel: 'chan-grace',
    safety: safetyAt(0, 'none'),
  });

  assert.equal(timers.length, 1);
  assert.equal(timers[0].cleared, true);
  assert.equal(dashboard.initCalls.length, 0);
  assert.equal(dial.calls.length, 0);
  assert.equal(speak.speaks.length, 0);
  assert.equal(crisisModule.getSystemInjection('app-grace', 'chan-grace'), '');
});

test('Trigger-once: two consecutive level-3 updates produce a single escalation', async () => {
  const statusCalls = [];
  const dashboard = makeDashboardMock({ statusCalls });
  const dial = makeDialMock({ phase: 'answered', outcome: 'OK' });
  const speak = makeAgentSpeakMocks();

  setupAgent({
    appId: 'app-once',
    channel: 'chan-once',
    deps: {
      dashboardClient: dashboard,
      dialOutboundIntoChannel: dial.fn,
      recordAssistantUtterance: speak.recordAssistantUtterance,
      speakWithAgent: speak.speakWithAgent,
    },
  });

  await crisisModule.onSafetyUpdate({
    appId: 'app-once',
    channel: 'chan-once',
    safety: safetyAt(3),
  });
  // Second update arrives after the first completed — `state.suppressed` blocks
  await crisisModule.onSafetyUpdate({
    appId: 'app-once',
    channel: 'chan-once',
    safety: safetyAt(3),
  });

  assert.equal(dashboard.initCalls.length, 1, 'init only fires once');
  assert.equal(dial.calls.length, 1, 'dial only fires once');
});

test('Trigger-once under race: concurrent safety updates produce a single escalation', async () => {
  const statusCalls = [];
  const dashboard = makeDashboardMock({ statusCalls });
  const dial = makeDialMock({ phase: 'answered', outcome: 'OK' });
  const speak = makeAgentSpeakMocks();

  setupAgent({
    appId: 'app-race',
    channel: 'chan-race',
    deps: {
      dashboardClient: dashboard,
      dialOutboundIntoChannel: dial.fn,
      recordAssistantUtterance: speak.recordAssistantUtterance,
      speakWithAgent: speak.speakWithAgent,
    },
  });

  // Fire both without awaiting in between — second must see inFlight=true and bail
  const p1 = crisisModule.onSafetyUpdate({
    appId: 'app-race',
    channel: 'chan-race',
    safety: safetyAt(3),
  });
  const p2 = crisisModule.onSafetyUpdate({
    appId: 'app-race',
    channel: 'chan-race',
    safety: safetyAt(3),
  });
  await Promise.all([p1, p2]);

  assert.equal(dashboard.initCalls.length, 1);
  assert.equal(dial.calls.length, 1);
});

test('Dashboard init failure sets failed phase and does not retry on later safety updates', async () => {
  const statusCalls = [];
  const dashboard = {
    ...makeDashboardMock({ statusCalls }),
    postCrisisEscalateInit: async () => {
      throw new Error('dashboard unavailable');
    },
  };
  const dial = makeDialMock({ phase: 'answered', outcome: 'OK' });
  const speak = makeAgentSpeakMocks();

  setupAgent({
    appId: 'app-init-fail',
    channel: 'chan-init-fail',
    deps: {
      dashboardClient: dashboard,
      dialOutboundIntoChannel: dial.fn,
      recordAssistantUtterance: speak.recordAssistantUtterance,
      speakWithAgent: speak.speakWithAgent,
    },
  });

  await crisisModule.onSafetyUpdate({
    appId: 'app-init-fail',
    channel: 'chan-init-fail',
    safety: safetyAt(3),
  });
  await crisisModule.onSafetyUpdate({
    appId: 'app-init-fail',
    channel: 'chan-init-fail',
    safety: safetyAt(3),
  });

  assert.equal(dial.calls.length, 0, 'never dials when init fails');
  assert.equal(speak.speaks.length, 0, 'never speaks when init fails');
  assert.equal(crisisModule.shouldSuppressAssistantReply('app-init-fail', 'chan-init-fail'), false);
});

test('Unregister during dialing marks escalation failed with session_ended_during_dial', async () => {
  const statusCalls = [];
  let releaseDial;
  const dashboard = makeDashboardMock({ statusCalls });
  const dial = {
    calls: [],
    fn: async (bundle) => {
      dial.calls.push(bundle);
      await new Promise((resolve) => {
        releaseDial = resolve;
      });
      return { phase: 'failed', outcome: 'busy', ok: true };
    },
  };
  const speak = makeAgentSpeakMocks();

  setupAgent({
    appId: 'app-unreg',
    channel: 'chan-unreg',
    deps: {
      dashboardClient: dashboard,
      dialOutboundIntoChannel: dial.fn,
      recordAssistantUtterance: speak.recordAssistantUtterance,
      speakWithAgent: speak.speakWithAgent,
    },
  });

  const escalationPromise = crisisModule.onSafetyUpdate({
    appId: 'app-unreg',
    channel: 'chan-unreg',
    safety: safetyAt(3),
  });

  // Let the async flow reach the in-flight dial.
  await new Promise((resolve) => setImmediate(resolve));
  await crisisModule.onAgentUnregistered('app-unreg', 'chan-unreg');
  releaseDial();
  await escalationPromise;

  const terminalStatuses = statusCalls.filter((c) => c.phase === 'failed');
  assert.ok(
    terminalStatuses.some((c) => c.reason === 'session_ended_during_dial'),
    'unregister posts a terminal failed status for an in-flight dial'
  );
});
