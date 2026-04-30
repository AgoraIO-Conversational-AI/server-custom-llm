const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

function loadStoreWithEnv(customPromptPath) {
  const modulePath = require.resolve('./integrations/thymia/thymia_store');
  const policyModulePath = require.resolve('./integrations/thymia/thymia_policy_config');
  delete require.cache[modulePath];
  delete require.cache[policyModulePath];
  if (customPromptPath) {
    process.env.THYMIA_CUSTOM_POLICY_PROMPT_PATH = customPromptPath;
  } else {
    delete process.env.THYMIA_CUSTOM_POLICY_PROMPT_PATH;
  }
  process.env.THYMIA_CUSTOM_POLICY_NAME = 'mindfix_safety_v1';
  return require('./integrations/thymia/thymia_store');
}

test('default store consumes agora_safety_analysis safety results', () => {
  const store = loadStoreWithEnv('');
  store.updateFromPolicyResult('app-default', 'chan-default', {
    policy: 'safety_analysis',
    policy_name: 'agora_safety_analysis',
    result: {
      level: 2,
      alert: 'professional_referral',
      concerns: ['risk'],
      recommended_actions: ['act'],
    },
  });
  const metrics = store.getMetrics('app-default', 'chan-default');
  assert.equal(metrics.safety.level, 2);
  store.remove('app-default', 'chan-default');
});

test('custom safety policy drives store safety state when configured', () => {
  const promptPath = path.join(__dirname, 'integrations', 'thymia', 'policies', 'mindfix_safety_v1.txt');
  const store = loadStoreWithEnv(promptPath);

  store.updateFromPolicyResult('app-custom', 'chan-custom', {
    policy: 'safety_analysis',
    policy_name: 'agora_safety_analysis',
    result: {
      level: 1,
      alert: 'monitor',
      concerns: ['default-risk'],
      recommended_actions: ['default-action'],
    },
  });
  // When the custom safety policy is active, the default safety policy is no
  // longer authoritative for the live safety state.
  assert.equal(store.getMetrics('app-custom', 'chan-custom').safety.level, null);

  store.updateFromPolicyResult('app-custom', 'chan-custom', {
    policy: 'custom_prompt',
    policy_name: 'mindfix_safety_v1',
    result: {
      classification: {
        level: 3,
        alert: 'crisis',
        concerns: ['custom-risk'],
        recommended_actions: ['custom-action'],
      },
    },
  });
  const metrics = store.getMetrics('app-custom', 'chan-custom');
  assert.equal(metrics.safety.level, 3);
  assert.deepEqual(metrics.safety.concerns, ['custom-risk']);
  store.remove('app-custom', 'chan-custom');
});

test('missing custom prompt file falls back to default agora safety policy in store', () => {
  const store = loadStoreWithEnv('/tmp/this-file-definitely-does-not-exist-123456789.txt');
  store.updateFromPolicyResult('app-missing', 'chan-missing', {
    policy: 'safety_analysis',
    policy_name: 'agora_safety_analysis',
    result: {
      level: 2,
      alert: 'concern',
      concerns: ['fallback-risk'],
      recommended_actions: ['fallback-action'],
    },
  });
  const metrics = store.getMetrics('app-missing', 'chan-missing');
  assert.equal(metrics.safety.level, 2);
  assert.deepEqual(metrics.safety.concerns, ['fallback-risk']);
  store.remove('app-missing', 'chan-missing');
});
