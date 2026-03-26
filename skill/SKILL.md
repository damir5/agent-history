---
name: agent-history
description: CLI tool for querying conversation history across Claude, Gemini, Codex, and OpenCode agents. Use when you need to search past conversations, list sessions, view stats, find user corrections, or analyze agent activity across projects and machines.
type: skill
---

# agent-history

CLI tool that queries conversation history across all agents (Claude, Gemini, Codex, OpenCode) on this machine and remote machines.

## Commands

```bash
# Stats across all agents
agent-history stats
agent-history stats --agent claude --from 7d

# Search user messages
agent-history search --query "refactor" --limit 10
agent-history search --agent gemini --project "*kosarica*" --from 30d

# List sessions
agent-history sessions --from 7d --format text
agent-history sessions --agent codex --project "*fisco*"

# Dump a conversation
agent-history conversation claude:SESSION_ID
agent-history conversation gemini:SESSION_ID

# Find user corrections (where user corrected the agent)
agent-history corrections --from 30d --limit 20
agent-history corrections --agent claude --project "*kosarica*"

# Run on remote machine (destinations from ~/.ade/config/sync.yaml)
agent-history remote damir-tp stats
agent-history remote damir-tp corrections --from 30d
```

## Global Flags

| Flag | Description |
|------|-------------|
| `--agent <name>` | Filter: claude, gemini, codex, opencode, all (default: all) |
| `--project <glob>` | Filter by project path/name glob |
| `--from <date>` | Start date: ISO or relative (7d, 1w, 1m) |
| `--to <date>` | End date |
| `--limit <N>` | Max results |
| `--format <fmt>` | Output: json (default), jsonl, text |

## Output

All commands output JSON by default. Use `--format text` for human-readable output, `--format jsonl` for streaming/piping.

## Data Sources

| Agent | Location |
|-------|----------|
| Claude | `~/.claude/history.jsonl` + `~/.claude/projects/*/*.jsonl` |
| Gemini | `~/.gemini/tmp/*/chats/*.json` |
| Codex | `~/.codex/history.jsonl` + `~/.codex/state_5.sqlite` |
| OpenCode | `~/.local/share/opencode/opencode.db` |
