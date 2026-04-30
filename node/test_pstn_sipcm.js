const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeSipcmOutcome } = require('./integrations/pstn/sipcm');

test('normalizeSipcmOutcome treats OK as answered', () => {
  const result = normalizeSipcmOutcome('OK');
  assert.equal(result.phase, 'answered');
  assert.equal(result.outcome, 'OK');
});

test('normalizeSipcmOutcome recognizes busy and rejected outcomes', () => {
  assert.equal(normalizeSipcmOutcome('busy').outcome, 'busy');
  assert.equal(normalizeSipcmOutcome('rejected').outcome, 'rejected');
  assert.equal(normalizeSipcmOutcome('busy').phase, 'failed');
});
