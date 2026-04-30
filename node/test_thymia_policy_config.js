// thymia.js reads policy env vars at module load (`const`s), so each case
// runs in its own subprocess with the env it needs.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawnSync } = require('child_process');

const PROMPT_PATH = path.resolve(__dirname, 'integrations/thymia/policies/mindfix_safety_v1.txt');
const THYMIA_MODULE = path.resolve(__dirname, 'integrations/thymia/thymia');

const SENTINEL = '__POLICY_CFG_JSON__::';

function runGetPoliciesConfig(env) {
  const script = `
    const t = require(${JSON.stringify(THYMIA_MODULE)});
    const out = t.getPoliciesConfig();
    process.stdout.write('\\n${SENTINEL}' + JSON.stringify(out) + '\\n');
  `;
  const childEnv = { ...process.env, ...env };
  // Wipe any inherited values so the child sees exactly what each test sets.
  for (const k of [
    'THYMIA_CUSTOM_POLICY_PROMPT_PATH',
    'THYMIA_CUSTOM_POLICY_NAME',
    'THYMIA_CUSTOM_POLICY_TRIGGER_TURNS',
    'THYMIA_REPLACE_DEFAULT_POLICY',
  ]) {
    if (!(k in env)) delete childEnv[k];
  }
  const result = spawnSync('node', ['-e', script], {
    env: childEnv,
    encoding: 'utf-8',
  });
  if (result.status !== 0) {
    throw new Error(`subprocess failed (exit ${result.status}): ${result.stderr || result.stdout}`);
  }
  const idx = result.stdout.lastIndexOf(SENTINEL);
  if (idx === -1) {
    throw new Error(`sentinel not found in subprocess stdout: ${result.stdout}`);
  }
  const tail = result.stdout.slice(idx + SENTINEL.length).trim();
  return JSON.parse(tail.split('\n')[0]);
}

test('getPoliciesConfig: no custom prompt path → defaults only', () => {
  const cfg = runGetPoliciesConfig({});
  assert.deepEqual(cfg.policies, ['passthrough', 'agora_safety_analysis']);
  assert.equal(cfg.customPolicies, undefined, 'no customPolicies when prompt path unset');
});

test('getPoliciesConfig: custom prompt path → custom policy alongside default', () => {
  const cfg = runGetPoliciesConfig({
    THYMIA_CUSTOM_POLICY_PROMPT_PATH: PROMPT_PATH,
    THYMIA_CUSTOM_POLICY_NAME: 'mindfix_safety_v1',
  });
  assert.deepEqual(
    cfg.policies,
    ['passthrough', 'agora_safety_analysis'],
    'default policies remain when REPLACE_DEFAULT_POLICY is not set'
  );
  assert.ok(Array.isArray(cfg.customPolicies));
  assert.equal(cfg.customPolicies.length, 1);
  const custom = cfg.customPolicies[0];
  assert.equal(custom.policy_name, 'mindfix_safety_v1');
  assert.equal(custom.executor, 'custom_prompt');
  assert.equal(typeof custom.config_json.prompt, 'string');
  assert.ok(custom.config_json.prompt.length > 1000, 'prompt loaded from disk');
  assert.equal(custom.config_json.trigger_turns, 1);
});

test('getPoliciesConfig: replace mode → default safety policy dropped', () => {
  const cfg = runGetPoliciesConfig({
    THYMIA_CUSTOM_POLICY_PROMPT_PATH: PROMPT_PATH,
    THYMIA_REPLACE_DEFAULT_POLICY: 'true',
  });
  assert.deepEqual(
    cfg.policies,
    ['passthrough'],
    'agora_safety_analysis dropped when REPLACE_DEFAULT_POLICY=true'
  );
  assert.equal(cfg.customPolicies.length, 1);
  assert.equal(cfg.customPolicies[0].policy_name, 'mindfix_safety_v1');
});

test('getPoliciesConfig: trigger_turns env override flows through', () => {
  const cfg = runGetPoliciesConfig({
    THYMIA_CUSTOM_POLICY_PROMPT_PATH: PROMPT_PATH,
    THYMIA_CUSTOM_POLICY_TRIGGER_TURNS: '3',
  });
  assert.equal(cfg.customPolicies[0].config_json.trigger_turns, 3);
});

test('getPoliciesConfig: missing prompt file → falls back to defaults, no custom policy', () => {
  const cfg = runGetPoliciesConfig({
    THYMIA_CUSTOM_POLICY_PROMPT_PATH: '/tmp/this-file-definitely-does-not-exist-123456789.txt',
  });
  assert.deepEqual(cfg.policies, ['passthrough', 'agora_safety_analysis']);
  assert.equal(cfg.customPolicies, undefined);
});
