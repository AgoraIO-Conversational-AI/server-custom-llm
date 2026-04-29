# AI Agent Instructions

This repository uses progressive disclosure documentation to help AI coding
agents work efficiently. Documentation is structured in three levels under
`docs/ai/`.

## How to Load

1. Read [docs/ai/L0_repo_card.md](docs/ai/L0_repo_card.md) to identify the repo.
2. Load ALL 8 files in `docs/ai/L1/`. They are small — load all upfront.
   This gives you setup, architecture, code map, conventions, workflows,
   interfaces, and gotchas.
3. Follow L2 deep-dive links only when L1 isn't detailed enough.

## Levels

- **L0 (Repo Card):** Identity and L1 index. Table of contents.
- **L1 (Summaries):** Structured summaries. Load all at session start.
- **L2 (Deep Dives):** Full specifications. Load only when L1 isn't detailed enough.

## Git Conventions

### Commit messages

- Format: `type: description` or `type(scope): description`
- Types: `feat:`, `fix:`, `chore:`, `test:`, `docs:`
- Lowercase after prefix
- Present tense
- PR number appended
- No AI tool names
- No `Co-Authored-By` trailers
- Do not use `--no-verify`
- Do not change `git config` identity settings

### Branch names

- Format: `type/short-description`
- Lowercase, hyphen-separated
- Examples: `feat/audio-pipeline`, `fix/rtm-reconnect`, `docs/progressive-disclosure`

## Doc Commands

| Command | When to use |
| --- | --- |
| `generate docs` | `docs/ai/` does not exist yet |
| `update docs` | code changed and docs need refresh |
| `test docs` | verify docs still match repo behavior |
