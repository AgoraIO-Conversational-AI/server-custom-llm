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
| Last Reviewed | 2026-04-28 |

## L1 — Summaries

| File | Purpose |
|------|---------|
| [01_setup](L1/01_setup.md) | Environment setup, build Go binary, npm install, env vars |
| [02_architecture](L1/02_architecture.md) | Node.js + Go child process + Thymia WebSocket diagram |
| [03_code_map](L1/03_code_map.md) | Directory tree, module responsibilities, core files |
| [04_conventions](L1/04_conventions.md) | Tool handler signatures, IPC protocol, naming patterns |
| [05_workflows](L1/05_workflows.md) | Add a tool, add an audio processor, deploy |
| [06_interfaces](L1/06_interfaces.md) | LLM API contract, Thymia Sentinel protocol, IPC protocol |
| [07_gotchas](L1/07_gotchas.md) | CGO build, DYLD_LIBRARY_PATH, process isolation, SDK crashes |
| [08_security](L1/08_security.md) | Trust boundaries, agent registration auth, secrets, RTM/data risks |

## L2 — Deep Dives

- [Deep Dive Index](L1/L2/_index.md)
