/**
 * Generic RTC audio capture via Go child process.
 * No Thymia or other module references — emits events for consumers.
 *
 * Each channel gets one Go child process (joins Agora, pipes PCM to stdout).
 * Consumers listen to 'audio', 'status', 'error', and 'stopped' events.
 */

const { spawn } = require('child_process');
const path = require('path');
const EventEmitter = require('events');

const logger = {
  info: (message) => console.log(`INFO: [AudioSubscriber] ${message}`),
  debug: (message) => console.log(`DEBUG: [AudioSubscriber] ${message}`),
  error: (message, error) => console.error(`ERROR: [AudioSubscriber] ${message}`, error),
};

// Default path to Go binary
const DEFAULT_BINARY_PATH = path.resolve(__dirname, '../go-audio-subscriber/bin/audio_subscriber');

// Restart backoff
const RESTART_BASE_DELAY = 2000;
const RESTART_MAX_DELAY = 30000;
const RESTART_MAX_ATTEMPTS = 5;

class AudioSession {
  constructor(appId, channel, targetUid) {
    this.appId = appId;
    this.channel = channel;
    this.targetUid = targetUid;
    this.child = null;

    // Framing state for parsing child stdout
    this.frameBuf = Buffer.alloc(0);

    // Restart state
    this.restartAttempts = 0;
    this.restartTimer = null;
    this.stopped = false;
  }
}

class AudioSubscriber extends EventEmitter {
  constructor(options = {}) {
    super();
    this.binaryPath = options.binaryPath || process.env.AUDIO_SUBSCRIBER_PATH || DEFAULT_BINARY_PATH;
    this.botUid = options.botUid || process.env.AUDIO_SUBSCRIBER_BOT_UID || '5000';
    this.sessions = new Map(); // key: "appId:channel"

    // Clean up all children on process exit
    const cleanup = () => this.shutdownAll();
    process.on('exit', cleanup);
    process.on('SIGINT', () => { cleanup(); process.exit(0); });
    process.on('SIGTERM', () => { cleanup(); process.exit(0); });

    logger.info(`Initialized (binary=${this.binaryPath}, botUid=${this.botUid})`);
  }

  _key(appId, channel) {
    return `${appId}:${channel}`;
  }

  /**
   * Start an audio session for this channel. Idempotent.
   * Spawns Go child process if not already running.
   */
  startSession(appId, channel, targetUid, token = '') {
    const key = this._key(appId, channel);

    if (this.sessions.has(key)) {
      logger.debug(`Session already exists: ${key}`);
      return;
    }

    const session = new AudioSession(appId, channel, targetUid);
    this.sessions.set(key, session);

    this._spawnChild(session, token);

    logger.info(`Audio session started for channel ${channel} (target UID ${targetUid})`);
  }

  /**
   * Spawn the Go audio subscriber child process.
   */
  _spawnChild(session, token = '') {
    const key = this._key(session.appId, session.channel);

    // Set up dynamic library path
    const sdkDir = path.resolve(__dirname, '../go-audio-subscriber/sdk');
    const env = { ...process.env };
    if (process.platform === 'darwin') {
      const macSdkDir = path.join(sdkDir, 'agora_sdk_mac');
      env.DYLD_LIBRARY_PATH = [macSdkDir, env.DYLD_LIBRARY_PATH].filter(Boolean).join(':');
    } else {
      const linuxSdkDir = path.resolve(__dirname, '../go-audio-subscriber/sdk/agora_sdk');
      env.LD_LIBRARY_PATH = [linuxSdkDir, env.LD_LIBRARY_PATH].filter(Boolean).join(':');
    }

    logger.info(`Spawning child: ${this.binaryPath} for ${key}`);

    const child = spawn(this.binaryPath, [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
    });

    session.child = child;

    // Handle stdout (framed binary protocol)
    child.stdout.on('data', (chunk) => {
      this._onChildData(session, chunk);
    });

    // Handle stderr (logs)
    child.stderr.on('data', (chunk) => {
      const lines = chunk.toString().trim().split('\n');
      for (const line of lines) {
        logger.debug(`[child:${session.channel}] ${line}`);
      }
    });

    // Handle child exit
    child.on('exit', (code, signal) => {
      logger.info(`Child exited: ${key} code=${code} signal=${signal}`);
      session.child = null;

      if (!session.stopped) {
        this._scheduleRestart(session, token);
      } else {
        this.emit('stopped', session.appId, session.channel);
      }
    });

    child.on('error', (err) => {
      logger.error(`Child spawn error: ${key}`, err);
      session.child = null;
      this.emit('error', session.appId, session.channel, err);

      if (!session.stopped) {
        this._scheduleRestart(session, token);
      }
    });

    // Send start command
    const startCmd = {
      type: 'start',
      appId: session.appId,
      channel: session.channel,
      botUid: this.botUid,
      token: token,
      targetUid: session.targetUid,
    };

    child.stdin.write(JSON.stringify(startCmd) + '\n');
    logger.info(`Sent start command to child for ${key}`);
  }

  /**
   * Parse framed binary data from child stdout.
   * Protocol: [1-byte type][4-byte BE length][payload]
   */
  _onChildData(session, chunk) {
    session.frameBuf = Buffer.concat([session.frameBuf, chunk]);

    while (session.frameBuf.length >= 5) {
      const frameType = session.frameBuf[0];
      const payloadLen = session.frameBuf.readUInt32BE(1);

      if (session.frameBuf.length < 5 + payloadLen) {
        break; // Wait for more data
      }

      const payload = session.frameBuf.slice(5, 5 + payloadLen);
      session.frameBuf = session.frameBuf.slice(5 + payloadLen);

      if (frameType === 0x01) {
        // JSON status
        this._onChildStatus(session, payload);
      } else if (frameType === 0x02) {
        // PCM audio — emit event
        this.emit('audio', session.appId, session.channel, payload);
      }
    }
  }

  /**
   * Handle a JSON status message from the child.
   */
  _onChildStatus(session, payload) {
    try {
      const msg = JSON.parse(payload.toString());
      logger.info(`[child:${session.channel}] ${msg.type}: ${msg.status || msg.error || msg.message}`);
      this.emit('status', session.appId, session.channel, msg);

      // Auto-cleanup when child reports target left or subscriber stopped
      if (msg.status === 'target_left' || (msg.status === 'stopped' && !session.stopped)) {
        logger.info(`Auto-stopping session for ${session.channel} (child reported: ${msg.status})`);
        this.stopSession(session.appId, session.channel);
      }
    } catch (e) {
      logger.error('Failed to parse child status JSON:', e);
    }
  }

  /**
   * Schedule a child process restart with backoff.
   */
  _scheduleRestart(session, token) {
    session.restartAttempts++;
    if (session.restartAttempts > RESTART_MAX_ATTEMPTS) {
      logger.error(
        `Max restart attempts (${RESTART_MAX_ATTEMPTS}) reached for ${session.channel}`
      );
      return;
    }

    const delay = Math.min(
      RESTART_BASE_DELAY * Math.pow(2, session.restartAttempts - 1),
      RESTART_MAX_DELAY
    );
    logger.info(
      `Restarting child for ${session.channel} in ${delay}ms (attempt ${session.restartAttempts})`
    );

    session.restartTimer = setTimeout(() => {
      if (!session.stopped) {
        this._spawnChild(session, token);
      }
    }, delay);
  }

  /**
   * Stop a specific session.
   */
  stopSession(appId, channel) {
    const key = this._key(appId, channel);
    const session = this.sessions.get(key);
    if (!session) return;

    session.stopped = true;

    if (session.restartTimer) {
      clearTimeout(session.restartTimer);
      session.restartTimer = null;
    }

    if (session.child) {
      try {
        session.child.stdin.write(JSON.stringify({ type: 'stop' }) + '\n');
      } catch (e) {
        // stdin may already be closed
      }
      // Force kill after 5 seconds
      setTimeout(() => {
        if (session.child) {
          session.child.kill('SIGKILL');
        }
      }, 5000);
    }

    this.sessions.delete(key);
    logger.info(`Session stopped: ${key}`);
  }

  /**
   * Check if a session exists for this channel.
   */
  hasSession(appId, channel) {
    return this.sessions.has(this._key(appId, channel));
  }

  /**
   * Shut down all sessions (called on process exit).
   */
  shutdownAll() {
    for (const [key, session] of this.sessions) {
      session.stopped = true;

      if (session.restartTimer) {
        clearTimeout(session.restartTimer);
      }

      if (session.child) {
        try {
          session.child.kill('SIGTERM');
        } catch (e) {
          // Ignore
        }
      }
    }
    this.sessions.clear();
    logger.info('All sessions shut down');
  }
}

module.exports = { AudioSubscriber };
