# AI Skills Collection

Personal collection of AI agent skills — reusable procedures, CLI tools, and workflows for coding agents (Claude Code, Cursor, OpenCode, Codex, etc.).

## Skills

| Skill | Description | Runtime |
|-------|-------------|---------|
| [X-Search](./x-search/) | AI-powered deep search via Grok with 6-phase planning workflow | Node.js |

## Install

Each skill follows the standard [skill directory structure](https://github.com/anysearch-ai/anysearch-skill). After cloning:

```bash
# Example: install x-search
cp -r x-search ~/.agents/skills/x-search
cd ~/.agents/skills/x-search
cp .env.example .env   # edit with your API keys
```

## Usage

Skills are auto-discovered by AI agents. The agent reads `SKILL.md` for instructions and uses `runtime.conf` (generated on first run) for the configured CLI path.
