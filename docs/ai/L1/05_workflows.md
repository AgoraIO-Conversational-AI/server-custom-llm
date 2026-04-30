# 05 Workflows

> Step-by-step instructions for common development tasks.

## Add a New Tool

1. Open `node/tools.js`
2. Add tool schema to `TOOL_DEFINITIONS` array (OpenAI function calling format)
3. Write handler function: `function myTool(appId, userId, channel, args) { return "result"; }`
4. Add to `TOOL_MAP`: `my_tool: myTool`
5. Test: the LLM will automatically discover and use the tool

## Add a Thymia-Specific Tool

1. Add schema to `THYMIA_TOOL_DEFINITIONS` in `node/tools.js`
2. Write handler function (same signature as above)
3. Add to `THYMIA_TOOL_MAP`
4. Tool is only available when `THYMIA_ENABLED=true`

## Add an Audio Processor

To process audio between the Go subscriber and Thymia:

1. In `audio_manager.js`, modify `_onChildPCM(session, pcmData)`
2. Transform the PCM buffer before forwarding to `session.thymiaClient.sendAudio()`
3. Audio is 16kHz, mono, 16-bit signed little-endian PCM

## Build and Run Locally

```bash
# 1. Build Go binary
cd server-custom-llm/go-audio-subscriber && make build

# 2. Install Node dependencies
cd ../node && npm install

# 3. Configure environment
cp .env.example .env   # Edit with your credentials

# 4. Start server
npm start
```

## Deploy with Docker

1. Build Go binary for linux-amd64: `make build-linux`
2. Copy `bin/audio_subscriber` and `agora_sdk/*.so` to Docker image
3. Set `LD_LIBRARY_PATH` to the SDK directory
4. Set `AUDIO_SUBSCRIBER_PATH` to the binary location
5. Run Node.js server with `node custom_llm.js`

## Debug Audio Pipeline

1. Check Go child logs: look for `[audio_sub]` prefix in Node.js stderr
2. Verify PCM flow: add `logger.debug` in `_onChildPCM` to log frame sizes
3. Check Thymia connection: look for `[ThymiaClient]` log lines
4. Verify PolicyResults: check `thymia_store.js` via `get_wellness_metrics` tool

## Update Thymia Safety Policy

1. Put the prompt under `node/integrations/thymia/policies/`
2. Set `THYMIA_CUSTOM_POLICY_PROMPT_PATH`
3. Optionally set `THYMIA_REPLACE_DEFAULT_POLICY=true`
4. Run:
   - `node --test test_thymia_policy_config.js test_thymia_store_custom_policy.js`
5. Verify both:
   - Sentinel CONFIG shape is correct
   - store safety still updates when the custom prompt path is missing or unreadable

## Prepare AI-Human Crisis Escalation

1. Ensure `node/.env` contains:
   - `CRISIS_CALL_ENABLED=true`
   - `AGORA_SIPCM_AUTH`
   - `THYMIA_ENABLED=true`
   - `SHEN_ENABLED=true`
   - `ENABLE_MEMORY=true`
   - `ENCRYPTION_KEY`
2. Ensure dashboard `.env` contains:
   - `AGORA_APP_ID`
   - `AGORA_APP_CERTIFICATE`
   - `CRISIS_CALL_FROM_NUMBER`
   - `CRISIS_CALL_SIP_GATEWAY`
   - `CRISIS_CALL_REGION`
   - `CRISIS_CALL_PSTN_UID`
3. Restart:
   - `pm2 restart consultant-dashboard --update-env`
   - `pm2 restart server-custom-llm --update-env`
4. Confirm startup logs show:
   - `Thymia module initialized`
   - `Memory module initialized`
   - `MindFix crisis module initialized enabled=true`
5. Run targeted tests before manual dialing:
   - `cd server-custom-llm/node && node --test test_mindfix_crisis.js test_thymia_store_custom_policy.js test_thymia_policy_config.js test_consultant_dashboard_client.js test_pstn_sipcm.js`
   - `cd consultant_dashboard && ./venv/bin/python -m unittest tests.test_internal_api -v`

## Validate AI-Human Continuation Memory

1. Confirm `ENABLE_MEMORY=true` and `ENCRYPTION_KEY` are both set
2. End one AI-human session normally
3. Check logs for:
   - `Generated session summaries for channel=...`
   - `Saved session memory to ...`
4. Start the next AI-human session for the same user/client
5. Check logs for:
   - `Loaded N session(s) for user_id=...`

## Stage Manual PSTN Validation

1. AI-human session with no escalation phone:
   - trigger the crisis threshold
   - confirm dashboard records `skipped`
   - confirm normal custom-LLM replies continue
2. AI-human session with a real escalation phone:
   - trigger the crisis threshold
   - confirm the client hears the announcement
   - confirm the phone rings and answer bridges into the same Agora channel
   - confirm the recipient summary is spoken once
   - confirm normal custom-LLM replies remain suppressed after escalation
3. End the session and verify:
   - final `sessions` row exists in dashboard
   - `escalation_events.session_id` matches the final session id
   - biomarkers and summary still ingest normally

## Related Deep Dives

- [mindfix_crisis_escalation](L2/mindfix_crisis_escalation.md)
