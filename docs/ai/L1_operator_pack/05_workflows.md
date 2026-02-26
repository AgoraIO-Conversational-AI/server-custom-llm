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
cd go-audio-subscriber && make build

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

## Related Deep Dives

- None
