# Integrations

Optional modules that plug into `custom_llm.js` via the module system. Each module implements lifecycle hooks that the server calls at key points during request processing.

## Available Integrations

| Integration         | Description                                                               | Guide                                  |
| ------------------- | ------------------------------------------------------------------------- | -------------------------------------- |
| [Thymia](./thymia/) | Real-time voice biomarker analysis (emotions, wellness, clinical markers) | [thymia/README.md](./thymia/README.md) |
| [Shen](./shen/)     | Camera-based vitals (heart rate, HRV, BP, stress) via browser WASM SDK    | See shen.js                            |

## Module Interface

Each integration module exports:

| Export                                                                          | Description                                         |
| ------------------------------------------------------------------------------- | --------------------------------------------------- |
| `init(audioSubscriber, options)`                                                | Initialize the module                               |
| `getToolDefinitions()`                                                          | Return tool schemas to merge into the LLM tool list |
| `getToolHandlers()`                                                             | Return tool handler map for dispatch                |
| `onRequest(ctx)`                                                                | Called on each `/chat/completions` request          |
| `onResponse(ctx)`                                                               | Called after the LLM produces a response            |
| `onAgentRegistered(appId, channel, agentId, authHeader, agentEndpoint, prompt)` | Called when an agent is registered                  |
| `onAgentUnregistered(appId, channel, agentId)`                                  | Called when an agent is unregistered                |
| `shutdown()`                                                                    | Clean up on server exit                             |
