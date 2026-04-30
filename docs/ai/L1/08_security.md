# 08 Security

> Trust boundaries, authentication, secret handling, and data risks for the custom LLM server.

## Trust Boundaries

- Agora ConvoAI calls the public HTTP endpoints.
- The Node server may call:
  - upstream LLM providers
  - Thymia Sentinel
  - Agora RTM / RTC helpers
  - consultant-dashboard internal APIs
- The Go audio subscriber is a child process with direct access to RTC audio for the joined channel.

## Primary Controls

- shared-secret protection on `/register-agent` and `/unregister-agent` when configured
- optional encrypted session memory with filesystem storage
- bounded in-memory conversation history per session key
- explicit agent registration lifecycle for Thymia / RTC capture

## Secrets

Treat these as sensitive:

- `LLM_API_KEY`
- `AGORA_CUSTOMER_ID`
- `AGORA_CUSTOMER_SECRET`
- `AGORA_APP_ID`
- `THYMIA_API_KEY`
- `ENCRYPTION_KEY`
- `AGORA_SIPCM_AUTH`
- any dashboard shared-secret env vars

Do not log raw secrets, bearer tokens, or full signed headers.

## Data Risks

- transcripts may contain sensitive user content
- Thymia biomarker payloads are sensitive wellness/clinical signal data
- RTM biomarker messages are visible to channel participants that subscribe to them
- local encrypted memory is only protected if `ENCRYPTION_KEY` is configured correctly
- crisis escalation metadata includes trusted-contact phone numbers and generated escalation text

## Operational Risks

- child-process crashes can silently break audio biomarker capture
- stale agent registration can leave channel-specific state behind if unregister is skipped
- public custom-LLM endpoints should not be exposed without rate limiting / perimeter controls in production
- diagnostic logging around STT / biomarkers should stay concise to avoid oversharing sensitive content

## Current Gaps

- no full CSRF-style concept is relevant here because this is not browser-form driven
- auth on public LLM proxy routes is limited to the surrounding deployment model and caller contract
- security posture relies on correct env / secret provisioning and private deployment topology

## Related Deep Dives

- [thymia_sentinel](L2/thymia_sentinel.md) — Sentinel message flow and biomarker protocol
- [go_audio_ipc](L2/go_audio_ipc.md) — Child-process IPC and audio capture boundaries
- [mindfix_crisis_escalation](L2/mindfix_crisis_escalation.md) — AI-human PSTN escalation boundaries
