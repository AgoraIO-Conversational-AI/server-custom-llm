const test = require('node:test');
const assert = require('node:assert/strict');
const { Root } = require('protobufjs/light');

const { extractTranscriptLine, extractFinalTranscriptLine } = require('./agora_stt_proto');

const root = Root.fromJSON({
  nested: {
    agora: {
      nested: {
        audio2text: {
          nested: {
            Text: {
              fields: {
                uid: { type: 'uint32', id: 4 },
                time: { type: 'int64', id: 6 },
                lang: { type: 'int32', id: 7 },
                words: { rule: 'repeated', type: 'Word', id: 10 },
                end_of_segment: { type: 'bool', id: 11 },
                data_type: { type: 'string', id: 13 },
              },
            },
            Word: {
              fields: {
                text: { type: 'string', id: 1 },
                isFinal: { type: 'bool', id: 4 },
              },
            },
          },
        },
      },
    },
  },
});

const Text = root.lookupType('agora.audio2text.Text');

test('extractFinalTranscriptLine decodes final STT stream messages', () => {
  const payload = Text.encode({
    uid: 101,
    time: 1776633311000,
    lang: 1033,
    data_type: 'transcribe',
    end_of_segment: true,
    words: [
      { text: 'Hello', isFinal: true },
      { text: ' world', isFinal: true },
    ],
  }).finish();

  const line = extractFinalTranscriptLine(payload);
  assert.ok(line);
  assert.equal(line.uid, '101');
  assert.equal(line.text, 'Hello world');
});

test('extractTranscriptLine decodes partial STT stream messages with is_final false', () => {
  const payload = Text.encode({
    uid: 103,
    time: 1776633312000,
    lang: 1033,
    data_type: 'transcribe',
    end_of_segment: false,
    words: [
      { text: 'How', isFinal: false },
      { text: ' are', isFinal: false },
    ],
  }).finish();

  const line = extractTranscriptLine(payload);
  assert.ok(line);
  assert.equal(line.uid, '103');
  assert.equal(line.text, 'How are');
  assert.equal(line.is_final, false);
  assert.equal(extractFinalTranscriptLine(payload), null);
});
