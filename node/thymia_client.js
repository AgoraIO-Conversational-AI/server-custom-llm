/**
 * Thymia Sentinel WebSocket client for real-time voice biomarker analysis.
 *
 * Connects to wss://ws.thymia.ai and streams audio + transcripts
 * using the Sentinel protocol. Receives PolicyResult messages with
 * biomarker scores (stress, burnout, fatigue, depression, anxiety).
 *
 * Port of the Python sentinel_client.py to Node.js using the `ws` package.
 */

const WebSocket = require('ws');

const logger = {
  info: (message) => console.log(`INFO: [ThymiaClient] ${message}`),
  debug: (message) => console.log(`DEBUG: [ThymiaClient] ${message}`),
  error: (message, error) => console.error(`ERROR: [ThymiaClient] ${message}`, error),
};

// Reconnect settings
const RECONNECT_BASE_DELAY = 1000;
const RECONNECT_MAX_DELAY = 30000;
const RECONNECT_MAX_ATTEMPTS = 10;

class ThymiaClient {
  constructor(options = {}) {
    this.wsUrl = options.wsUrl || process.env.THYMIA_WS_URL || 'wss://ws.thymia.ai';
    this.apiKey = options.apiKey || process.env.THYMIA_API_KEY || '';

    this.ws = null;
    this.connected = false;
    this.configSent = false;
    this.reconnectAttempts = 0;
    this.reconnectTimer = null;
    this.shouldReconnect = false;
    this.lastConfig = null;

    // Callbacks
    this.onPolicyResult = options.onPolicyResult || null;
    this.onProgress = options.onProgress || null;
    this.onStatus = options.onStatus || null;
    this.onError = options.onError || null;
  }

  /**
   * Connect to the Thymia Sentinel WebSocket and send configuration.
   *
   * @param {Object} config - Sentinel session configuration
   * @param {string} config.user_label - User identifier
   * @param {string} [config.date_of_birth] - ISO date (YYYY-MM-DD)
   * @param {string} [config.birth_sex] - "male" or "female"
   * @param {string} [config.language] - BCP 47 language code, default "en"
   * @param {string[]} [config.biomarkers] - e.g. ["helios", "apollo"]
   * @param {string[]} [config.policies] - e.g. ["passthrough", "safety_analysis"]
   * @param {number} [config.sample_rate] - Audio sample rate, default 16000
   * @param {string} [config.format] - Audio format, default "pcm16"
   * @param {number} [config.channels] - Audio channels, default 1
   */
  connect(config) {
    if (this.connected) {
      logger.info('Already connected, disconnecting first');
      this.disconnect();
    }

    // Sentinel requires birth_sex as uppercase MALE/FEMALE
    let birthSex = config.birth_sex || undefined;
    if (birthSex) {
      birthSex = birthSex.toUpperCase();
    }

    const sentinelConfig = {
      type: 'CONFIG',
      api_key: this.apiKey,
      user_label: config.user_label || 'user',
      date_of_birth: config.date_of_birth || undefined,
      birth_sex: birthSex,
      language: config.language || 'en',
      biomarkers: config.biomarkers || (process.env.THYMIA_BIOMARKERS || 'helios,apollo').split(','),
      policies: config.policies || (process.env.THYMIA_POLICIES || 'passthrough,safety_analysis').split(','),
      sample_rate: config.sample_rate || 16000,
      format: config.format || 'pcm16',
      channels: config.channels || 1,
      progress_updates: {
        enabled: true,
        interval_seconds: 1.0,
      },
    };

    // Remove undefined fields
    Object.keys(sentinelConfig).forEach((k) => {
      if (sentinelConfig[k] === undefined) delete sentinelConfig[k];
    });

    this.lastConfig = sentinelConfig;
    this.shouldReconnect = true;
    this.reconnectAttempts = 0;

    this._connect(sentinelConfig);
  }

  _connect(config) {
    logger.info(`Connecting to ${this.wsUrl}`);

    try {
      this.ws = new WebSocket(this.wsUrl);
    } catch (err) {
      logger.error('WebSocket creation failed:', err);
      this._scheduleReconnect();
      return;
    }

    this.ws.on('open', () => {
      logger.info('WebSocket connected');
      this.connected = true;
      this.reconnectAttempts = 0;

      // Send SentinelConfig as first message
      const configJson = JSON.stringify(config);
      this.ws.send(configJson);
      this.configSent = true;
      logger.info(`Sent SentinelConfig: ${configJson}`);

      if (this.onStatus) {
        this.onStatus('connected');
      }
    });

    this.ws.on('message', (data) => {
      this._handleMessage(data);
    });

    this.ws.on('error', (err) => {
      logger.error('WebSocket error:', err);
      if (this.onError) {
        this.onError(err);
      }
    });

    this.ws.on('close', (code, reason) => {
      logger.info(`WebSocket closed: code=${code} reason=${reason}`);
      this.connected = false;
      this.configSent = false;

      if (this.onStatus) {
        this.onStatus('disconnected');
      }

      if (this.shouldReconnect) {
        this._scheduleReconnect();
      }
    });
  }

  /**
   * Handle incoming WebSocket messages from Thymia.
   */
  _handleMessage(data) {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch (e) {
      logger.debug(`Non-JSON message received (${data.length} bytes)`);
      return;
    }

    logger.debug(`Received: ${JSON.stringify(msg).slice(0, 200)}`);

    switch (msg.type) {
      case 'POLICY_RESULT':
        logger.info(
          `PolicyResult: policy=${msg.policy}, result=${JSON.stringify(msg.result || {}).slice(0, 500)}`
        );
        if (this.onPolicyResult) {
          this.onPolicyResult(msg);
        }
        break;

      case 'PROGRESS':
        logger.debug(
          `Progress: ${JSON.stringify(msg.biomarkers || {}).slice(0, 150)}`
        );
        if (this.onProgress) {
          this.onProgress(msg);
        }
        break;

      case 'STATUS':
        logger.info(`Sentinel status: ${msg.message || JSON.stringify(msg)}`);
        if (this.onStatus) {
          this.onStatus('sentinel_status', msg);
        }
        break;

      case 'ERROR':
        logger.error(`Sentinel error: ${msg.message || JSON.stringify(msg)}`);
        if (this.onError) {
          this.onError(new Error(msg.message || 'Sentinel error'));
        }
        break;

      default:
        logger.debug(`Unknown message type: ${msg.type}`);
    }
  }

  /**
   * Send audio data to Thymia.
   *
   * @param {Buffer} pcmBuffer - Raw PCM audio bytes
   * @param {string} [track="user"] - Audio track identifier
   */
  sendAudio(pcmBuffer, track = 'user') {
    if (!this.connected || !this.configSent) {
      return false;
    }

    // Send JSON audio header
    const header = {
      type: 'AUDIO_HEADER',
      track,
      bytes: pcmBuffer.length,
      format: 'pcm16',
      sample_rate: 16000,
      channels: 1,
    };

    try {
      this.ws.send(JSON.stringify(header));
      this.ws.send(pcmBuffer);
      return true;
    } catch (err) {
      logger.error('Error sending audio:', err);
      return false;
    }
  }

  /**
   * Send a transcript to Thymia for context.
   *
   * @param {string} speaker - "user" or "agent"
   * @param {string} text - Transcript text
   * @param {boolean} [isFinal=true] - Whether this is a final transcript
   */
  sendTranscript(speaker, text, isFinal = true) {
    if (!this.connected || !this.configSent) {
      return false;
    }

    const msg = {
      type: 'TRANSCRIPT',
      speaker,
      text,
      is_final: isFinal,
    };

    try {
      this.ws.send(JSON.stringify(msg));
      return true;
    } catch (err) {
      logger.error('Error sending transcript:', err);
      return false;
    }
  }

  /**
   * Disconnect from Thymia.
   */
  disconnect() {
    this.shouldReconnect = false;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.ws) {
      try {
        this.ws.close(1000, 'Client disconnect');
      } catch (e) {
        // Ignore close errors
      }
      this.ws = null;
    }

    this.connected = false;
    this.configSent = false;
    logger.info('Disconnected');
  }

  /**
   * Schedule a reconnection with exponential backoff.
   */
  _scheduleReconnect() {
    if (!this.shouldReconnect) return;

    this.reconnectAttempts++;
    if (this.reconnectAttempts > RECONNECT_MAX_ATTEMPTS) {
      logger.error(`Max reconnect attempts (${RECONNECT_MAX_ATTEMPTS}) reached`);
      this.shouldReconnect = false;
      if (this.onError) {
        this.onError(new Error('Max reconnect attempts reached'));
      }
      return;
    }

    const delay = Math.min(
      RECONNECT_BASE_DELAY * Math.pow(2, this.reconnectAttempts - 1),
      RECONNECT_MAX_DELAY
    );
    logger.info(
      `Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${RECONNECT_MAX_ATTEMPTS})`
    );

    this.reconnectTimer = setTimeout(() => {
      if (this.shouldReconnect && this.lastConfig) {
        this._connect(this.lastConfig);
      }
    }, delay);
  }

  /**
   * Whether the client is connected and config has been sent.
   */
  isReady() {
    return this.connected && this.configSent;
  }
}

module.exports = { ThymiaClient };
