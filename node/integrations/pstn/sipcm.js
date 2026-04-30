function normalizeSipcmOutcome(rawBody) {
  const body =
    rawBody && typeof rawBody === 'object'
      ? rawBody
      : (() => {
          try {
            return JSON.parse(String(rawBody || '{}'));
          } catch (_error) {
            return { raw: String(rawBody || '') };
          }
        })();

  if (body && typeof body === 'object') {
    if (body.success === true || body.ok === true) {
      return { phase: 'answered', outcome: String(body.message || body.result || 'OK'), body };
    }
    if (typeof body.code === 'number' && body.code === 0) {
      return { phase: 'answered', outcome: String(body.message || body.result || 'OK'), body };
    }
  }

  const text = String(
    body.status || body.result || body.code || body.message || body.raw || ''
  ).trim();
  const lower = text.toLowerCase();

  if (lower === 'ok' || lower.includes('answered') || lower.includes('connected')) {
    return { phase: 'answered', outcome: text || 'OK', body };
  }
  if (lower.includes('busy')) {
    return { phase: 'failed', outcome: 'busy', body };
  }
  if (lower.includes('reject')) {
    return { phase: 'failed', outcome: 'rejected', body };
  }
  if (lower.includes('no_answer') || lower.includes('no answer')) {
    return { phase: 'failed', outcome: 'no_answer', body };
  }
  return { phase: 'failed', outcome: text || 'failed', body };
}

async function dialOutboundIntoChannel(bundle, options = {}) {
  const logger = options.logger || console;
  const auth = options.auth || process.env.AGORA_SIPCM_AUTH || '';
  const endpoint = options.endpoint || process.env.AGORA_SIPCM_URL || 'https://sipcm.agora.io/v1/api/pstn';
  const regionalGateways = options.regionalGateways ?? 'true';
  const prompt = options.prompt ?? 'false';

  if (!auth) {
    throw new Error('AGORA_SIPCM_AUTH is not configured');
  }
  if (!bundle?.appId || !bundle?.channelName || !bundle?.rtcToken || !bundle?.toPhone) {
    throw new Error('dial bundle missing required fields');
  }

  const payloadObject = {
    action: 'outbound',
    appid: bundle.appId,
    region: bundle.region || 'AREA_CODE_NA',
    uid: String(bundle.pstnUid || '43455'),
    channel: bundle.channelName,
    from: bundle.fromPhone || '',
    to: bundle.toPhone,
    regional_gateways: String(regionalGateways),
    prompt: String(prompt),
    sip: bundle.sipGateway || '',
    token: bundle.rtcToken,
  };
  const payload = JSON.stringify(payloadObject);

  logger.info(
    `[PSTN] outbound dial channel=${payloadObject.channel} uid=${payloadObject.uid} to=${payloadObject.to} region=${payloadObject.region}`
  );

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/json',
    },
    body: payload,
    signal: AbortSignal.timeout(20000),
  });
  const responseText = await response.text();
  const normalized = normalizeSipcmOutcome(responseText);

  logger.info(
    `[PSTN] outbound result http=${response.status} phase=${normalized.phase} outcome=${normalized.outcome} raw=${responseText.substring(0, 300)}`
  );

  return {
    ok: response.ok,
    statusCode: response.status,
    raw: responseText,
    ...normalized,
  };
}

module.exports = {
  dialOutboundIntoChannel,
  normalizeSipcmOutcome,
};
