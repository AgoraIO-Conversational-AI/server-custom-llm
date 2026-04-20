const test = require('node:test');
const assert = require('node:assert/strict');

const { AudioSubscriber } = require('./audio_subscriber');

test('audio subscriber emits decoded stream_message payloads from child JSON frames', async () => {
  const subscriber = new AudioSubscriber({ binaryPath: '/tmp/does-not-matter' });
  const session = { appId: 'app', channel: 'room_x', frameBuf: Buffer.alloc(0) };

  const received = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), 1000);
    subscriber.once('stream_message', (_appId, _channel, msg) => {
      clearTimeout(timer);
      resolve(msg);
    });
    const payload = Buffer.from(JSON.stringify({
      type: 'stream_message',
      uid: '104',
      stream_id: 7,
      data: Buffer.from('hello').toString('base64'),
    }));
    const frame = Buffer.alloc(5 + payload.length);
    frame[0] = 0x01;
    frame.writeUInt32BE(payload.length, 1);
    payload.copy(frame, 5);
    subscriber._onChildData(session, frame);
  });

  assert.equal(received.uid, '104');
  assert.equal(received.streamId, 7);
  assert.equal(received.data.toString(), 'hello');
  subscriber.shutdownAll();
});
