const test = require('node:test');
const assert = require('node:assert/strict');

const {
  getMeetingTranscript,
  setMeetingTranscript,
  appendMeetingTranscriptLine,
  startMeetingTranscription,
  stopMeetingTranscription,
} = require('./meeting_transcription');

test('startMeetingTranscription records not_configured when Agora credentials are missing', async () => {
  const originalCustomerId = process.env.AGORA_CUSTOMER_ID;
  const originalCustomerSecret = process.env.AGORA_CUSTOMER_SECRET;
  delete process.env.AGORA_CUSTOMER_ID;
  delete process.env.AGORA_CUSTOMER_SECRET;

  try {
    const snapshot = await startMeetingTranscription({
      runtimeKey: 'runtime:test',
      appId: 'test-app',
      channel: 'room_abc123',
      provider: 'agora_stt',
      language: 'en-US',
      userUid: '101',
      botUid: '104',
      botToken: 'bot-token',
    });
    assert.equal(snapshot.status, 'not_configured');
    assert.equal(snapshot.language, 'en-US');
    assert.deepEqual(snapshot.subscribed_uids, ['101']);
    assert.ok(getMeetingTranscript('runtime:test'));
  } finally {
    process.env.AGORA_CUSTOMER_ID = originalCustomerId;
    process.env.AGORA_CUSTOMER_SECRET = originalCustomerSecret;
  }
});

test('stopMeetingTranscription returns snapshot even when session is already local-only', async () => {
  const originalCustomerId = process.env.AGORA_CUSTOMER_ID;
  const originalCustomerSecret = process.env.AGORA_CUSTOMER_SECRET;
  delete process.env.AGORA_CUSTOMER_ID;
  delete process.env.AGORA_CUSTOMER_SECRET;

  try {
    await startMeetingTranscription({
      runtimeKey: 'runtime:stop',
      appId: 'test-app',
      channel: 'room_stop',
      provider: 'agora_stt',
      language: 'en-US',
      userUid: '101',
      botUid: '104',
      botToken: 'bot-token',
    });
    const snapshot = await stopMeetingTranscription('runtime:stop');
    assert.equal(snapshot.provider, 'agora_stt');
    assert.ok(snapshot.ended_at);
  } finally {
    process.env.AGORA_CUSTOMER_ID = originalCustomerId;
    process.env.AGORA_CUSTOMER_SECRET = originalCustomerSecret;
  }
});

test('setMeetingTranscript stores normalized text and lines for a running meeting transcription', async () => {
  const originalCustomerId = process.env.AGORA_CUSTOMER_ID;
  const originalCustomerSecret = process.env.AGORA_CUSTOMER_SECRET;
  delete process.env.AGORA_CUSTOMER_ID;
  delete process.env.AGORA_CUSTOMER_SECRET;

  try {
    await startMeetingTranscription({
      runtimeKey: 'runtime:lines',
      appId: 'test-app',
      channel: 'room_lines',
      provider: 'agora_stt',
      language: 'en-US',
      userUid: '101',
      botUid: '104',
      botToken: 'bot-token',
    });
    const snapshot = setMeetingTranscript('runtime:lines', {
      lines: [
        { uid: '101', time: '2026-04-18T12:00:00Z', text: 'Hello there', source_lang: '' },
        { uid: '101', time: '2026-04-18T12:00:02Z', text: 'How are you?', source_lang: '' },
      ],
    });
    assert.equal(snapshot.lines.length, 2);
    assert.equal(snapshot.text, 'Hello there\nHow are you?');
  } finally {
    process.env.AGORA_CUSTOMER_ID = originalCustomerId;
    process.env.AGORA_CUSTOMER_SECRET = originalCustomerSecret;
  }
});

test('appendMeetingTranscriptLine incrementally stores unique transcript lines', async () => {
  const originalCustomerId = process.env.AGORA_CUSTOMER_ID;
  const originalCustomerSecret = process.env.AGORA_CUSTOMER_SECRET;
  delete process.env.AGORA_CUSTOMER_ID;
  delete process.env.AGORA_CUSTOMER_SECRET;

  try {
    await startMeetingTranscription({
      runtimeKey: 'runtime:append',
      appId: 'test-app',
      channel: 'room_append',
      provider: 'agora_stt',
      language: 'en-US',
      userUid: '101',
      botUid: '104',
      botToken: 'bot-token',
    });
    appendMeetingTranscriptLine('runtime:append', {
      uid: '101',
      time: '2026-04-19T21:40:00Z',
      text: 'Hello there',
      source_lang: 'en-US',
    });
    appendMeetingTranscriptLine('runtime:append', {
      uid: '101',
      time: '2026-04-19T21:40:01Z',
      text: 'How are you?',
      source_lang: 'en-US',
    });
    appendMeetingTranscriptLine('runtime:append', {
      uid: '101',
      time: '2026-04-19T21:40:01Z',
      text: 'How are you?',
      source_lang: 'en-US',
    });
    const snapshot = getMeetingTranscript('runtime:append');
    assert.equal(snapshot.lines.length, 2);
    assert.equal(snapshot.text, 'Hello there\nHow are you?');
  } finally {
    process.env.AGORA_CUSTOMER_ID = originalCustomerId;
    process.env.AGORA_CUSTOMER_SECRET = originalCustomerSecret;
  }
});
