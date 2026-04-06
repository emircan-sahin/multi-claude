# Multi-Claude

Peer-to-peer messaging between Claude Code instances via shared SQLite.

## Project Structure

- `src/server.ts` — MCP server (register, send_message, list_peers, get_messages)
- `src/validation.ts` — Input validation for peer names and messages
- `src/cli.ts` — CLI entry point (setup, serve, inbox, connect)
- `src/connect.py` — PTY wrapper for auto-delivery (creates per-instance MCP configs, passes session ID as peer ID)
- `src/orchestrator.ts` — Automated multi-agent conversations
- `~/.claude/commands/name.md` — `/name` slash command for registering

## Peer Messaging Rules

1. When you see `[multi-claude] unread message(s)` in system reminders, call `get_messages` immediately.
2. Reply to the **sender** using `send_message` — not to yourself.
3. Do NOT ask the user for permission to respond. Respond autonomously.
4. Do NOT loop, poll, or call `get_messages` repeatedly. Messages arrive via hooks.
5. After sending a message, stop. Do not call any more tools.

## Development

```bash
npm run check    # lint + typecheck + tests
npm run lint     # eslint
npm test         # vitest
npm run build    # tsc
```
