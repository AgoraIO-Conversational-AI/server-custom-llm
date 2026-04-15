/**
 * Memory store for custom_llm.js
 *
 * Provides encrypted per-user session history. On agent registration,
 * loads previous session summaries from disk and injects them into the
 * system prompt. On agent unregistration, summarizes the conversation
 * via LLM and encrypts+writes the summary to disk.
 *
 * Also accumulates voice biomarker and camera vitals running averages
 * during a session and saves them alongside the summary.
 *
 * Safety: Memory is ONLY read/written when BOTH conditions are met:
 *   1. ENCRYPTION_KEY is set in env
 *   2. user_id received from backend is not "anonymous"
 *
 * If either condition is false, memory is completely skipped.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const OpenAI = require('openai');
const { getMessages } = require('./conversation_store');
const dashboardClient = require('./consultant_dashboard_client');

// Conditionally import biomarker stores (may not be present in all deployments)
let thymiaStore = null;
let shenStore = null;
try { thymiaStore = require('./integrations/thymia/thymia_store'); } catch (e) {}
try { shenStore = require('./integrations/shen/shen_store'); } catch (e) {}

const logger = {
  info: (msg) => console.log(`INFO: [Memory] ${msg}`),
  debug: (msg) => console.log(`DEBUG: [Memory] ${msg}`),
  error: (msg, err) => console.error(`ERROR: [Memory] ${msg}`, err || ''),
};

// Config from env
let ENCRYPTION_KEY = '';   // hex string, 32 bytes = 64 hex chars
let DATA_DIR = './data';
let MAX_HISTORY_SESSIONS = 5;

// Runtime state: channel → { userId, appId, injection, biomarkers: { voice: {}, vitals: {} }, llmApiKey }
const channelState = new Map();

// ─── Encryption helpers ───

function deriveKey(masterKeyHex, userIdHash) {
  const masterKey = Buffer.from(masterKeyHex, 'hex');
  const salt = crypto.randomBytes(16);
  const derived = crypto.hkdfSync('sha256', masterKey, salt, userIdHash, 32);
  return { key: Buffer.from(derived), salt };
}

function deriveKeyWithSalt(masterKeyHex, salt, userIdHash) {
  const masterKey = Buffer.from(masterKeyHex, 'hex');
  const derived = crypto.hkdfSync('sha256', masterKey, salt, userIdHash, 32);
  return Buffer.from(derived);
}

function encryptJSON(data, masterKeyHex, userIdHash) {
  const { key, salt } = deriveKey(masterKeyHex, userIdHash);
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
  const plaintext = JSON.stringify(data);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Format: salt(16) + nonce(12) + tag(16) + ciphertext
  return Buffer.concat([salt, nonce, tag, encrypted]);
}

function decryptJSON(encryptedBuf, masterKeyHex, userIdHash) {
  const salt = encryptedBuf.subarray(0, 16);
  const nonce = encryptedBuf.subarray(16, 28);
  const tag = encryptedBuf.subarray(28, 44);
  const ciphertext = encryptedBuf.subarray(44);
  const key = deriveKeyWithSalt(masterKeyHex, salt, userIdHash);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return JSON.parse(decrypted.toString('utf8'));
}

// ─── Biomarker helpers ───

function updateRunningAvg(bucket, key, value) {
  if (typeof value !== 'number' || isNaN(value)) return;
  if (!bucket[key]) bucket[key] = { sum: 0, count: 0, min: value, max: value };
  bucket[key].sum += value;
  bucket[key].count++;
  bucket[key].min = Math.min(bucket[key].min, value);
  bucket[key].max = Math.max(bucket[key].max, value);
}

function finalizeBiomarkers(bucket) {
  const result = {};
  for (const [key, { sum, count, min, max }] of Object.entries(bucket)) {
    if (count > 0) {
      result[key] = {
        avg: Math.round((sum / count) * 100) / 100,
        count,
        min: Math.round(min * 100) / 100,
        max: Math.round(max * 100) / 100,
      };
    }
  }
  return result;
}

function summarizeSafety(metrics) {
  const safety = metrics?.safety || {};
  return {
    current_level: safety.level ?? null,
    current_alert: safety.alert ?? false,
    current_concerns: safety.concerns || [],
    current_recommended_actions: safety.recommended_actions || [],
    highest_level: safety.highest_level ?? null,
    highest_alert: safety.highest_alert ?? false,
    highest_concerns: safety.highest_concerns || [],
    highest_recommended_actions: safety.highest_recommended_actions || [],
  };
}

function formatBiomarkerLine(biomarkers) {
  if (!biomarkers) return '';
  const parts = [];

  // Voice biomarkers (percentages)
  const voice = biomarkers.voice || {};
  const voiceParts = [];
  for (const [key, val] of Object.entries(voice)) {
    if (val && val.avg != null) {
      voiceParts.push(`${key} ${Math.round(val.avg * 100)}%`);
    }
  }
  if (voiceParts.length) parts.push(voiceParts.join(', '));

  // Vitals (with units)
  const vitals = biomarkers.vitals || {};
  const vitalsParts = [];
  const unitMap = {
    heart_rate_bpm: 'bpm', hrv_sdnn_ms: 'ms', breathing_rate_bpm: 'bpm',
    stress_index: '', systolic_bp: 'mmHg', diastolic_bp: 'mmHg',
    cardiac_workload: '',
  };
  for (const [key, val] of Object.entries(vitals)) {
    if (val && val.avg != null) {
      const label = key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
        .replace('Bpm', '').replace('Ms', '').replace('Bp', 'BP').trim();
      const unit = unitMap[key] || '';
      vitalsParts.push(`${label} ${val.avg}${unit ? ' ' + unit : ''}`);
    }
  }
  if (vitalsParts.length) parts.push(vitalsParts.join(', '));

  return parts.length ? `Biomarkers: ${parts.join(' | ')}` : '';
}

function stripMarkdownCodeFence(text) {
  if (!text) return '';
  const trimmed = text.trim();
  const match = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return match ? match[1].trim() : trimmed;
}

function normalizeSummaryText(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/\s+/g, ' ').trim();
}

function buildSummaryBiomarkerContext(biomarkers) {
  const compact = {
    voice_averages: {},
    vitals_averages: {},
    safety: biomarkers?.safety || {},
  };

  for (const [key, value] of Object.entries(biomarkers?.voice || {})) {
    if (value && typeof value.avg === 'number') {
      compact.voice_averages[key] = value.avg;
    }
  }

  for (const [key, value] of Object.entries(biomarkers?.vitals || {})) {
    if (value && typeof value.avg === 'number') {
      compact.vitals_averages[key] = value.avg;
    }
  }

  return JSON.stringify(compact, null, 2);
}

function buildFallbackSummaries(text, biomarkers) {
  const normalized = normalizeSummaryText(text);
  const highestLevel = biomarkers?.safety?.highest_level;
  const highestConcerns = biomarkers?.safety?.highest_concerns || [];
  const riskOverviewParts = [];

  if (highestLevel !== null && highestLevel !== undefined) {
    riskOverviewParts.push(`Highest safety level reached during the call was ${highestLevel}.`);
  }
  if (highestConcerns.length) {
    riskOverviewParts.push(`Key safety concerns: ${highestConcerns.join(', ')}.`);
  }

  return {
    memorySummary: normalized,
    dashboardSummary: {
      brief_overview: normalized,
      overview: normalized,
      full_summary: normalized,
      biomarker_summary: formatBiomarkerLine(biomarkers).replace(/^Biomarkers:\s*/, ''),
      risk_overview: riskOverviewParts.join(' ').trim(),
      follow_up: '',
      source: 'custom-llm',
    },
  };
}

function parseStructuredSummary(content, biomarkers) {
  const raw = stripMarkdownCodeFence(content);
  try {
    const parsed = JSON.parse(raw);
    const fullSummary = normalizeSummaryText(
      parsed?.consultant_summary?.full_summary || parsed?.memory_summary
    );
    const briefOverview = normalizeSummaryText(
      parsed?.consultant_summary?.brief_overview || parsed?.consultant_summary?.overview
    );
    const dashboardSummary = {
      brief_overview: briefOverview,
      overview: briefOverview,
      full_summary: fullSummary,
      biomarker_summary: normalizeSummaryText(parsed?.consultant_summary?.biomarker_summary),
      risk_overview: normalizeSummaryText(parsed?.consultant_summary?.risk_overview),
      follow_up: normalizeSummaryText(parsed?.consultant_summary?.follow_up),
      source: 'custom-llm',
    };

    if (!fullSummary || !dashboardSummary.overview) {
      return buildFallbackSummaries(content, biomarkers);
    }

    return { memorySummary: fullSummary, dashboardSummary };
  } catch (_err) {
    return buildFallbackSummaries(content, biomarkers);
  }
}

// ─── Disk operations ───

function getSessionsDir(userIdHash) {
  return path.join(DATA_DIR, 'users', userIdHash, 'sessions');
}

function loadSessionSummaries(userIdHash) {
  const dir = getSessionsDir(userIdHash);
  if (!fs.existsSync(dir)) return [];

  const files = fs.readdirSync(dir)
    .filter(f => f.endsWith('.enc'))
    .sort(); // chronological by filename (ISO timestamp)

  const summaries = [];
  for (const file of files.slice(-MAX_HISTORY_SESSIONS)) {
    try {
      const buf = fs.readFileSync(path.join(dir, file));
      const data = decryptJSON(buf, ENCRYPTION_KEY, userIdHash);
      summaries.push({
        date: file.replace('.enc', '').replace(/T/, ' ').replace(/Z$/, ' UTC'),
        summary: data.summary || data,
        biomarkers: data.biomarkers || null,
      });
    } catch (err) {
      logger.error(`Failed to decrypt session ${file}: ${err.message}`);
    }
  }
  return summaries;
}

function saveSessionSummary(userIdHash, sessionData) {
  const dir = getSessionsDir(userIdHash);
  fs.mkdirSync(dir, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `${timestamp}.enc`;
  const data = { ...sessionData, savedAt: new Date().toISOString() };
  const encrypted = encryptJSON(data, ENCRYPTION_KEY, userIdHash);

  fs.writeFileSync(path.join(dir, filename), encrypted);
  const voiceCount = Object.values(sessionData.biomarkers?.voice || {}).reduce((n, v) => n + (v.count || 0), 0);
  const vitalsCount = Object.values(sessionData.biomarkers?.vitals || {}).reduce((n, v) => n + (v.count || 0), 0);
  logger.info(`Saved session summary for user ${userIdHash.substring(0, 8)}... (${sessionData.summary.length} chars) with ${voiceCount} voice samples, ${vitalsCount} vitals samples`);
  return `users/${userIdHash}/sessions/${filename}`;
}

// ─── Injection builder ───

function buildInjection(summaries) {
  const lines = [`## Previous Session History (${summaries.length} sessions)\n`];
  summaries.forEach((s) => {
    lines.push(`### ${s.date}:`);
    lines.push(s.summary);
    const bioLine = formatBiomarkerLine(s.biomarkers);
    if (bioLine) lines.push(bioLine);
    lines.push('');
  });
  return lines.join('\n');
}

// ─── Summarization ───

async function summarizeConversation(messages, cachedApiKey, biomarkers) {
  const apiKey = cachedApiKey || process.env.LLM_API_KEY || process.env.YOUR_LLM_API_KEY || process.env.OPENAI_API_KEY || '';
  const baseURL = process.env.LLM_BASE_URL || 'https://api.openai.com/v1';
  const model = process.env.LLM_MODEL || 'gpt-4o-mini';

  if (!apiKey) {
    logger.error('No LLM API key for summarization');
    return null;
  }

  const client = new OpenAI({ apiKey, baseURL });

  // Filter to user/assistant messages and biomarker system messages
  const conversationText = messages
    .filter(m => m.role === 'user' || m.role === 'assistant'
      || (m.role === 'system' && (m.content?.includes('[Voice Biomarker') || m.content?.includes('[Camera Vitals'))))
    .map(m => {
      if (m.role === 'system') return `[Biomarker Data]: ${m.content}`;
      return `${m.role === 'user' ? 'Client' : 'Therapist'}: ${m.content}`;
    })
    .join('\n');

  if (conversationText.length < 50) {
    logger.info('Conversation too short to summarize');
    return null;
  }

  try {
    const response = await client.chat.completions.create({
      model,
      messages: [
        {
          role: 'system',
          content:
            'You are generating two different summaries for the same session. '
            + 'Return valid JSON only with this exact shape: '
            + '{"consultant_summary":{"brief_overview":"...","full_summary":"...","biomarker_summary":"...","risk_overview":"...","follow_up":"..."}}. '
            + 'Rules: '
            + '1) consultant_summary.brief_overview is a short consultant-facing summary for quick scanning, 1-2 sentences. '
            + '2) consultant_summary.full_summary is a fuller consultant-facing summary and will also be reused as AI continuity for future sessions; include broad themes, what helped, unresolved threads, and follow-up needs, while avoiding unnecessary identifying event detail. '
            + '3) consultant_summary.biomarker_summary should mention the main biomarker takeaways only when supported by the provided biomarker context. '
            + '4) consultant_summary.risk_overview must mention the worst safety state reached during the call when safety data is present, even if the session later de-escalated. '
            + '5) consultant_summary.follow_up should say what a consultant should monitor or revisit next. '
            + 'Keep each field concise. Do not mention internal systems or dashboards.',
        },
        {
          role: 'user',
          content: `Conversation:\n${conversationText}\n\nFinal biomarker context:\n${buildSummaryBiomarkerContext(biomarkers)}`,
        },
      ],
      response_format: { type: 'json_object' },
      max_tokens: 700,
    });
    const content = response.choices[0]?.message?.content || null;
    if (!content) return null;
    return parseStructuredSummary(content, biomarkers);
  } catch (err) {
    logger.error('Structured summarization failed; retrying with text fallback:', err);
  }

  try {
    const fallbackResponse = await client.chat.completions.create({
      model,
      messages: [
        {
          role: 'system',
          content: 'Summarize this therapy session concisely. Note key topics discussed, '
            + 'emotional themes, any breakthroughs or concerns, and anything to follow up '
            + 'on in the next session. If biomarker data is present, note any significant '
            + 'patterns and the highest safety risk reached during the call. Keep it under 300 words.',
        },
        {
          role: 'user',
          content: `Conversation:\n${conversationText}\n\nFinal biomarker context:\n${buildSummaryBiomarkerContext(biomarkers)}`,
        },
      ],
      max_tokens: 500,
    });
    const fallbackContent = fallbackResponse.choices[0]?.message?.content || null;
    if (!fallbackContent) return null;
    return buildFallbackSummaries(fallbackContent, biomarkers);
  } catch (fallbackErr) {
    logger.error('Summarization failed:', fallbackErr);
    return null;
  }
}

// ─── Module Interface ───

module.exports = {
  name: 'memory',

  init(_audioSubscriber, _options) {
    ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || '';
    DATA_DIR = process.env.DATA_DIR || './data';
    MAX_HISTORY_SESSIONS = parseInt(process.env.MAX_HISTORY_SESSIONS || '5', 10);

    if (ENCRYPTION_KEY) {
      logger.info(`Memory module initialized (data_dir=${DATA_DIR}, max_sessions=${MAX_HISTORY_SESSIONS})`);
    } else {
      logger.info('Memory module initialized (ENCRYPTION_KEY not set — memory disabled)');
    }
  },

  onAgentRegistered(appId, channel, agentId, authHeader, agentEndpoint, prompt, earlyParams) {
    const userId = earlyParams?.user_id;
    const shouldPersistMemory = !!(ENCRYPTION_KEY && userId && userId !== 'anonymous');
    const dashboard = dashboardClient.createDashboardConfig(earlyParams);
    const shouldPostDashboard = !!dashboard;

    if (!shouldPersistMemory && !shouldPostDashboard) {
      logger.debug(`Memory/dashboard skipped for channel=${channel} (memory=${shouldPersistMemory} dashboard=${shouldPostDashboard})`);
      return;
    }

    let injection = null;
    if (shouldPersistMemory) {
      logger.info(`Registering memory for channel=${channel} user_id=${userId} appId=${appId}`);
      const dir = getSessionsDir(userId);
      const summaries = loadSessionSummaries(userId);
      if (summaries.length === 0) {
        logger.info(`No previous sessions for user_id=${userId} (dir=${dir})`);
      } else {
        injection = buildInjection(summaries);
        logger.info(`Loaded ${summaries.length} session(s) for user_id=${userId} (${injection.length} chars)`);
      }
    }

    if (shouldPostDashboard) {
      logger.info(`Dashboard posting enabled for channel=${channel} client_id=${dashboard.clientId}`);
    }

    channelState.set(channel, {
      userId,
      appId,
      channel,
      injection,
      biomarkers: { voice: {}, vitals: {} },
      startedAt: new Date().toISOString(),
      startedAtMs: Date.now(),
      sessionId: crypto.randomUUID(),
      shouldPersistMemory,
      dashboard,
    });
  },

  getSystemInjection(appId, channel) {
    const state = channelState.get(channel);
    return state?.injection || null;
  },

  onRequest(ctx) {
    if (!ctx || !ctx.channel) return;

    const existing = channelState.get(ctx.channel);

    // Late binding — user_id came via chat/completions params
    if (!existing && ctx.userId && ctx.userId !== 'anonymous' && ENCRYPTION_KEY) {
      const userId = ctx.userId;
      const summaries = loadSessionSummaries(userId);
      const injection = summaries.length > 0 ? buildInjection(summaries) : null;
      channelState.set(ctx.channel, { userId, appId: ctx.appId, injection, biomarkers: { voice: {}, vitals: {} } });
    }

    // Cache LLM API key from request headers (needed for post-session summarization)
    const state = channelState.get(ctx.channel);
    if (!state) return;

    if (!state.llmApiKey && ctx.req) {
      const authHeader = ctx.req.headers?.['authorization'] || '';
      const bearerKey = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
      if (bearerKey) {
        state.llmApiKey = bearerKey;
        logger.debug(`Cached LLM API key for channel=${ctx.channel}`);
      }
    }

    const aid = state.appId || ctx.appId;

    // Voice biomarkers from Thymia
    if (thymiaStore) {
      const metrics = thymiaStore.getMetrics(aid, ctx.channel);
      if (metrics) {
        // Accumulate all numeric biomarkers (wellness + clinical + emotions)
        for (const [key, value] of Object.entries(metrics.biomarkers || {})) {
          if (typeof value === 'number' && !isNaN(value)) {
            updateRunningAvg(state.biomarkers.voice, key, value);
          }
        }
        // Also accumulate structured wellness/clinical
        for (const [key, value] of Object.entries(metrics.wellness || {})) {
          if (typeof value === 'number' && !isNaN(value)) {
            updateRunningAvg(state.biomarkers.voice, key, value);
          }
        }
        for (const [key, value] of Object.entries(metrics.clinical || {})) {
          if (typeof value === 'number' && !isNaN(value)) {
            updateRunningAvg(state.biomarkers.voice, key, value);
          }
        }
      }
    }

    // Camera vitals from Shen
    if (shenStore) {
      const vitals = shenStore.getVitals(aid, ctx.channel);
      if (vitals) {
        for (const [key, value] of Object.entries(vitals)) {
          if (typeof value === 'number' && !isNaN(value) && key !== 'progress' && key !== 'lastUpdated') {
            updateRunningAvg(state.biomarkers.vitals, key, value);
          }
        }
      }
    }
  },

  onResponse(_ctx) {},

  async onAgentUnregistered(appId, channel, agentId) {
    logger.info(`onAgentUnregistered called: appId=${appId} channel=${channel} agentId=${agentId}`);
    const state = channelState.get(channel);
    channelState.delete(channel);

    const shouldPersistMemory = !!(state?.shouldPersistMemory && ENCRYPTION_KEY && state?.userId && state.userId !== 'anonymous');
    const shouldPostDashboard = !!state?.dashboard;

    if (!shouldPersistMemory && !shouldPostDashboard) {
      logger.info(`Memory/dashboard save skipped: user_id=${state?.userId || 'none'} dashboard=${shouldPostDashboard}`);
      return;
    }

    const userId = state.userId;
    logger.info(`Summarizing session for user_id=${userId || 'none'} on channel=${channel}`);

    // Get conversation from store
    // The conversation_store keys by appId:userId:channel
    // For ConvoAI, the userId in conversation_store is the user_uid (RTC UID like "101")
    // Try multiple possible keys
    const possibleUserIds = ['101', userId, ''];
    let messages = [];
    let matchedUid = '';
    for (const uid of possibleUserIds) {
      const msgs = getMessages(appId, uid, channel);
      if (msgs.length > messages.length) {
        messages = msgs;
        matchedUid = uid;
      }
    }

    logger.info(`Found ${messages.length} messages (matched uid='${matchedUid}') for appId=${appId} channel=${channel}`);

    if (messages.length === 0) {
      logger.info('No conversation messages to summarize — skipping save');
      return;
    }

    // Summarize via LLM (use cached API key from session requests)
    const biomarkers = {
      voice: finalizeBiomarkers(state.biomarkers?.voice || {}),
      vitals: finalizeBiomarkers(state.biomarkers?.vitals || {}),
      safety: summarizeSafety(thymiaStore ? thymiaStore.getMetrics(appId, channel) : null),
    };

    const summaries = await summarizeConversation(messages, state.llmApiKey, biomarkers);
    if (!summaries) return;
    logger.info(
      `Generated session summaries for channel=${channel} session_id=${state.sessionId} ` +
      `memory_len=${(summaries.memorySummary || '').length} ` +
      `dashboard_overview_len=${(summaries.dashboardSummary?.overview || '').length}`
    );

    let memoryStorageKey = '';
    if (shouldPersistMemory) {
      try {
        memoryStorageKey = saveSessionSummary(userId, { summary: summaries.memorySummary, biomarkers });
        logger.info(`Saved session memory to ${memoryStorageKey} for user_id=${userId}`);
      } catch (err) {
        logger.error(`Failed to save session summary: ${err.message}`);
      }
    }

    if (shouldPostDashboard) {
      try {
        await dashboardClient.postSessionComplete(
          state,
          summaries.dashboardSummary,
          biomarkers,
          memoryStorageKey,
          logger
        );
      } catch (err) {
        logger.error(`Failed to post session-complete to dashboard: ${err.message}`);
      }
    }
  },

  getToolDefinitions() { return []; },
  getToolHandlers() { return {}; },

  shutdown() {
    channelState.clear();
    logger.info('Memory module shut down');
  },
};
