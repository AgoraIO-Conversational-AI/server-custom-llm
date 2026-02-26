# Server Custom LLM — Repo Card

> OpenAI-compatible Custom LLM proxy for Agora ConvoAI with server-side tool execution, RAG, RTM integration, and real-time Thymia voice biomarker analysis via a Go audio subscriber child process.

## Identity

| Field | Value |
|-------|-------|
| Repo | `AgoraIO-Conversational-AI/server-custom-llm` |
| Type | `api-service` |
| Language | Node.js (Express) + Go (CGO) |
| Deploy Target | Docker / bare metal |
| Owner | Agora ConvoAI |
| Last Reviewed | 2026-02-25 |

## L1 Operator Pack

| File | Purpose |
|------|---------|
| [01_setup](L1_operator_pack/01_setup.md) | Environment setup, build Go binary, npm install, env vars |
| [02_architecture](L1_operator_pack/02_architecture.md) | Node.js + Go child process + Thymia WebSocket diagram |
| [03_code_map](L1_operator_pack/03_code_map.md) | Directory tree, module responsibilities, core files |
| [04_conventions](L1_operator_pack/04_conventions.md) | Tool handler signatures, IPC protocol, naming patterns |
| [05_workflows](L1_operator_pack/05_workflows.md) | Add a tool, add an audio processor, deploy |
| [06_interfaces](L1_operator_pack/06_interfaces.md) | LLM API contract, Thymia Sentinel protocol, IPC protocol |
| [07_gotchas](L1_operator_pack/07_gotchas.md) | CGO build, DYLD_LIBRARY_PATH, process isolation, SDK crashes |
