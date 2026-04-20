const transcriptionSessions = new Map();
const STOPPED_TRANSCRIPTION_TTL_MS = 6 * 60 * 60 * 1000;
const MEETING_TRANSCRIPTION_MAX_IDLE_TIME_SECONDS = 15 * 60;

function pruneTranscriptionSessions(now = Date.now()) {
  for (const [runtimeKey, session] of transcriptionSessions.entries()) {
    if (!session?.endedAt) continue;
    const endedAtMs = Date.parse(session.endedAt);
    if (!Number.isNaN(endedAtMs) && now - endedAtMs > STOPPED_TRANSCRIPTION_TTL_MS) {
      transcriptionSessions.delete(runtimeKey);
    }
  }
}

function getAgoraCredentials() {
  return {
    customerId: process.env.AGORA_CUSTOMER_ID || '',
    customerSecret: process.env.AGORA_CUSTOMER_SECRET || '',
  };
}

function buildBasicAuthHeader(customerId, customerSecret) {
  const raw = Buffer.from(`${customerId}:${customerSecret}`).toString('base64');
  return `Basic ${raw}`;
}

function buildTranscriptSnapshot(session) {
  if (!session) return null;
  return {
    provider: session.provider || '',
    language: session.language || '',
    status: session.status || '',
    started_at: session.startedAt || '',
    ended_at: session.endedAt || '',
    agent_id: session.agentId || '',
    channel_name: session.channel || '',
    subscribed_uids: session.subscribeAudioUids || [],
    warning: session.warning || '',
    text: session.text || '',
    lines: Array.isArray(session.lines) ? session.lines : [],
    metadata: session.metadata || {},
  };
}

function normalizeTranscriptLines(lines) {
  if (!Array.isArray(lines)) return [];
  return lines
    .filter((line) => line && typeof line === 'object')
    .map((line) => ({
      uid: String(line.uid || ''),
      time: String(line.time || ''),
      text: typeof line.text === 'string' ? line.text.trim() : '',
      source_lang: typeof line.source_lang === 'string' ? line.source_lang.trim() : '',
    }))
    .filter((line) => line.text);
}

function normalizeTranscriptText(transcript, lines) {
  if (typeof transcript?.text === 'string' && transcript.text.trim()) {
    return transcript.text.trim();
  }
  if (!Array.isArray(lines) || !lines.length) return '';
  return lines.map((line) => line.text).filter(Boolean).join('\n').trim();
}

async function startMeetingTranscription(params, logger) {
  pruneTranscriptionSessions();
  const {
    runtimeKey,
    appId,
    channel,
    provider,
    language,
    userUid,
    subscribeAudioUids,
    botUid,
    botToken,
  } = params || {};

  if (!runtimeKey || !appId || !channel || !provider) return null;
  if (provider !== 'agora_stt') {
    const unsupported = {
      runtimeKey,
      appId,
      channel,
      provider,
      language,
      status: 'unsupported_provider',
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      warning: `Unsupported transcription provider: ${provider}`,
      subscribeAudioUids: userUid ? [String(userUid)] : [],
      text: '',
      metadata: {},
    };
    transcriptionSessions.set(runtimeKey, unsupported);
    return buildTranscriptSnapshot(unsupported);
  }

  const existing = transcriptionSessions.get(runtimeKey);
  if (existing && existing.status === 'running') {
    return buildTranscriptSnapshot(existing);
  }

  const startedAt = new Date().toISOString();
  const session = {
    runtimeKey,
    appId,
    channel,
    provider,
    language: language || 'en-US',
    botUid: botUid ? String(botUid) : '104',
    subscribeAudioUids: Array.isArray(subscribeAudioUids) && subscribeAudioUids.length
      ? [...new Set(subscribeAudioUids.map((uid) => String(uid || '').trim()).filter(Boolean))]
      : (userUid ? [String(userUid)] : ['101']),
    botToken: botToken || '',
    status: 'starting',
    startedAt,
    endedAt: '',
    warning: '',
    text: '',
    lines: [],
    metadata: {},
    agentId: '',
  };
  transcriptionSessions.set(runtimeKey, session);

  const { customerId, customerSecret } = getAgoraCredentials();
  if (!customerId || !customerSecret) {
    session.status = 'not_configured';
    session.endedAt = new Date().toISOString();
    session.warning = 'Agora STT credentials are not configured.';
    return buildTranscriptSnapshot(session);
  }

  const body = {
    name: `meeting-${runtimeKey.replace(/[^a-zA-Z0-9_-]/g, '_')}`,
    languages: [session.language],
    maxIdleTime: MEETING_TRANSCRIPTION_MAX_IDLE_TIME_SECONDS,
    rtcConfig: {
      channelName: channel,
      subscribeAudioUids: session.subscribeAudioUids,
      pubBotUid: session.botUid,
    },
  };
  if (session.botToken) {
    body.rtcConfig.pubBotToken = session.botToken;
  }

  const url = `https://api.agora.io/api/speech-to-text/v1/projects/${appId}/join`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: buildBasicAuthHeader(customerId, customerSecret),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
  const responseText = await response.text();
  if (!response.ok) {
    session.status = 'failed';
    session.endedAt = new Date().toISOString();
    session.warning = `Agora STT join failed: ${response.status} ${responseText}`;
    if (logger) logger.error(`[MeetingTranscription] ${session.warning}`);
    return buildTranscriptSnapshot(session);
  }

  let payload = {};
  try {
    payload = JSON.parse(responseText || '{}');
  } catch (_err) {
    payload = {};
  }
  session.status = 'running';
  session.agentId = payload.agent_id || payload.agentId || payload.agent_id?.toString?.() || '';
  session.metadata = payload;
  if (logger) {
    logger.info(`[MeetingTranscription] Started Agora STT for runtime=${runtimeKey} channel=${channel} agent=${session.agentId || 'unknown'}`);
  }
  return buildTranscriptSnapshot(session);
}

function stopMeetingTranscription(runtimeKey, logger) {
  pruneTranscriptionSessions();
  const session = transcriptionSessions.get(runtimeKey);
  if (!session) return Promise.resolve(null);

  if (!session.endedAt) {
    session.endedAt = new Date().toISOString();
  }
  if (session.status === 'running') {
    session.status = 'stopping';
  }

  const snapshot = buildTranscriptSnapshot(session);
  const { customerId, customerSecret } = getAgoraCredentials();
  if (!customerId || !customerSecret || !session.agentId) {
    session.status = session.status === 'failed' ? 'failed' : 'stopped';
    return Promise.resolve(snapshot);
  }

  const url = `https://api.agora.io/api/speech-to-text/v1/projects/${session.appId}/agents/${session.agentId}/leave`;
  return fetch(url, {
    method: 'POST',
    headers: {
      Authorization: buildBasicAuthHeader(customerId, customerSecret),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({}),
    signal: AbortSignal.timeout(10000),
  })
    .then(async (response) => {
      const text = await response.text();
      if (!response.ok) {
        session.warning = `Agora STT leave failed: ${response.status} ${text}`;
        if (logger) logger.error(`[MeetingTranscription] ${session.warning}`);
      }
      session.status = 'stopped';
      return buildTranscriptSnapshot(session);
    })
    .catch((error) => {
      session.warning = `Agora STT leave failed: ${error.message}`;
      session.status = 'stopped';
      if (logger) logger.error(`[MeetingTranscription] ${session.warning}`);
      return buildTranscriptSnapshot(session);
    });
}

function getMeetingTranscript(runtimeKey) {
  pruneTranscriptionSessions();
  return buildTranscriptSnapshot(transcriptionSessions.get(runtimeKey));
}

function setMeetingTranscript(runtimeKey, transcript) {
  pruneTranscriptionSessions();
  const session = transcriptionSessions.get(runtimeKey);
  if (!session || !transcript || typeof transcript !== 'object') {
    return buildTranscriptSnapshot(session);
  }

  const normalizedLines = normalizeTranscriptLines(transcript.lines);
  if (normalizedLines.length) {
    session.lines = normalizedLines;
  }
  session.text = normalizeTranscriptText(transcript, normalizedLines.length ? normalizedLines : session.lines);

  if (typeof transcript.warning === 'string' && transcript.warning.trim()) {
    session.warning = transcript.warning.trim();
  }
  if (transcript.metadata && typeof transcript.metadata === 'object') {
    session.metadata = {
      ...(session.metadata || {}),
      ...transcript.metadata,
    };
  }

  return buildTranscriptSnapshot(session);
}

function appendMeetingTranscriptLine(runtimeKey, line) {
  pruneTranscriptionSessions();
  const session = transcriptionSessions.get(runtimeKey);
  if (!session || !line || typeof line !== 'object') {
    return buildTranscriptSnapshot(session);
  }

  const normalized = {
    uid: String(line.uid || '').slice(0, 64),
    time: String(line.time || '').slice(0, 64),
    text: typeof line.text === 'string' ? line.text.trim().slice(0, 2000) : '',
    source_lang: typeof line.source_lang === 'string' ? line.source_lang.trim().slice(0, 32) : '',
  };
  if (!normalized.text) {
    return buildTranscriptSnapshot(session);
  }

  const dedupeKey = `${normalized.uid}:${normalized.time}:${normalized.text}`;
  if (!session.lineKeys) {
    session.lineKeys = new Set();
  }
  if (session.lineKeys.has(dedupeKey)) {
    return buildTranscriptSnapshot(session);
  }
  session.lineKeys.add(dedupeKey);
  session.lines = Array.isArray(session.lines) ? session.lines : [];
  session.lines.push(normalized);
  session.text = normalizeTranscriptText({ text: '' }, session.lines);
  return buildTranscriptSnapshot(session);
}

module.exports = {
  getMeetingTranscript,
  setMeetingTranscript,
  appendMeetingTranscriptLine,
  startMeetingTranscription,
  stopMeetingTranscription,
};
