const fs = require('fs');
const path = require('path');

const CUSTOM_POLICY_NAME = (process.env.THYMIA_CUSTOM_POLICY_NAME || 'mindfix_safety_v1').trim();
const CUSTOM_POLICY_PROMPT_PATH = (process.env.THYMIA_CUSTOM_POLICY_PROMPT_PATH || '').trim();
const CUSTOM_POLICY_TRIGGER_TURNS = Number(process.env.THYMIA_CUSTOM_POLICY_TRIGGER_TURNS || 1);
const REPLACE_DEFAULT_POLICY = process.env.THYMIA_REPLACE_DEFAULT_POLICY === 'true';
const DEFAULT_POLICIES = ['passthrough', 'agora_safety_analysis'];

let _customPolicyPromptCache;

function resolvePromptPath() {
  if (!CUSTOM_POLICY_PROMPT_PATH) return '';
  return path.isAbsolute(CUSTOM_POLICY_PROMPT_PATH)
    ? CUSTOM_POLICY_PROMPT_PATH
    : path.resolve(process.cwd(), CUSTOM_POLICY_PROMPT_PATH);
}

function loadCustomPolicyPrompt(logger = console) {
  if (!CUSTOM_POLICY_PROMPT_PATH) return '';
  if (typeof _customPolicyPromptCache === 'string') return _customPolicyPromptCache;
  const resolved = resolvePromptPath();
  try {
    const text = fs.readFileSync(resolved, 'utf8');
    _customPolicyPromptCache = text;
    if (logger?.info) {
      logger.info(
        `Loaded custom policy prompt name=${CUSTOM_POLICY_NAME} path=${resolved} chars=${text.length} replace_default=${REPLACE_DEFAULT_POLICY}`
      );
    }
    return text;
  } catch (err) {
    if (logger?.error) {
      logger.error(`Failed to load custom policy prompt at ${CUSTOM_POLICY_PROMPT_PATH}: ${err.message}`);
    }
    return '';
  }
}

function getPoliciesConfig(logger = console) {
  const prompt = loadCustomPolicyPrompt(logger);
  if (!prompt) {
    return { policies: DEFAULT_POLICIES, customPolicies: undefined };
  }
  const customPolicies = [
    {
      policy_name: CUSTOM_POLICY_NAME,
      executor: 'custom_prompt',
      config_json: {
        prompt,
        trigger_turns: CUSTOM_POLICY_TRIGGER_TURNS,
      },
    },
  ];
  const policies = REPLACE_DEFAULT_POLICY
    ? DEFAULT_POLICIES.filter((p) => p !== 'agora_safety_analysis')
    : DEFAULT_POLICIES;
  return { policies, customPolicies };
}

function isDefaultSafetyPolicy(policyName) {
  return policyName === 'agora_safety_analysis' || policyName === 'safety_analysis';
}

function isConfiguredCustomSafetyPolicy(policyName) {
  return !!CUSTOM_POLICY_PROMPT_PATH && policyName === CUSTOM_POLICY_NAME;
}

function getActiveSafetyPolicies(logger = console) {
  const { policies, customPolicies } = getPoliciesConfig(logger);
  const active = new Set();
  if (Array.isArray(policies) && policies.includes('agora_safety_analysis')) {
    active.add('agora_safety_analysis');
    active.add('safety_analysis');
  }
  if (Array.isArray(customPolicies) && customPolicies.length > 0) {
    active.add(CUSTOM_POLICY_NAME);
  }
  return active;
}

function hasActiveCustomSafetyPolicy(logger = console) {
  const { customPolicies } = getPoliciesConfig(logger);
  return Array.isArray(customPolicies) && customPolicies.length > 0;
}

module.exports = {
  CUSTOM_POLICY_NAME,
  CUSTOM_POLICY_PROMPT_PATH,
  CUSTOM_POLICY_TRIGGER_TURNS,
  REPLACE_DEFAULT_POLICY,
  DEFAULT_POLICIES,
  getPoliciesConfig,
  getActiveSafetyPolicies,
  hasActiveCustomSafetyPolicy,
  isConfiguredCustomSafetyPolicy,
  isDefaultSafetyPolicy,
  loadCustomPolicyPrompt,
};
