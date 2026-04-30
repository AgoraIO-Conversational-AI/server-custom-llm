# MindFix Crisis Escalation

AI-human sessions can trigger same-channel PSTN escalation from `server-custom-llm`.

## Scope

- AI-human only
- human-human never escalates
- no scheduled meeting row is required
- runtime identity is:
  - `client_id`
  - `session_id`
  - `channel_name`

## Runtime Owners

- `node/integrations/mindfix_crisis/mindfix_crisis.js`
  - one-shot crisis trigger
  - client announcement + recipient summary generation
  - same-channel reply suppression after escalation
- `node/integrations/pstn/sipcm.js`
  - generic SIP-CM outbound dial helper
- `consultant_dashboard`
  - escalation event persistence
  - trusted-contact lookup
  - RTC token minting for the PSTN leg

## Session Identity

`session_id` stays aligned across:

- `register-agent`
- `memory_store`
- `mindfix_crisis`
- dashboard `escalation_events`
- final `/internal/session-complete`

## Storage / Transcript Behavior

- crisis utterances are stored in conversation history
- they use `skipModuleFanout: true`, so they do not feed back into Thymia
- AI-human transcript and biomarker collection continue after escalation
- normal custom-LLM replies are suppressed after escalation starts
- AI-human continuation memory stays enabled for the rest of the session if memory is configured

## Live Runtime Notes

- PM2 service name: `server-custom-llm`
- runtime env file: `server-custom-llm/node/.env`
- live crisis dialing depends on:
  - `AGORA_SIPCM_AUTH`
  - matching Agora `app_id` / `rtc_token`
  - dashboard-provided `from_phone`, `sip_gateway`, `region`, and `pstn_uid`

## Required Environment

`server-custom-llm/node/.env`:

- `CRISIS_CALL_ENABLED=true`
- `AGORA_SIPCM_AUTH=...`
- `THYMIA_ENABLED=true`
- `SHEN_ENABLED=true`
- `ENABLE_MEMORY=true`
- `ENCRYPTION_KEY=...`

`consultant_dashboard/.env`:

- `AGORA_APP_ID`
- `AGORA_APP_CERTIFICATE`
- `CRISIS_CALL_FROM_NUMBER`
- `CRISIS_CALL_SIP_GATEWAY`
- `CRISIS_CALL_REGION`
- `CRISIS_CALL_PSTN_UID`

Do not put real keys or tokens into docs or tracked example files.
