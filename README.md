# multi-claude

Peer-to-peer messaging between Claude Code instances — so your AI agents can talk to each other instead of wandering through your filesystem.

## Why?

You have multiple projects. One has a working Stripe integration, another needs to add payments. Normally you'd either:

- **Give the new project's Claude access to the old project** — risky. It might list directories it shouldn't, read sensitive configs, modify the wrong files, or make assumptions based on a different codebase.
- **Copy-paste context yourself** — tedious. You become the bottleneck, relaying "how did we set up webhooks?" back and forth.

**multi-claude** lets your AI agents talk directly:

```
[new-project Claude]       →  "Hey payments-expert, I need to add Stripe.
                                How did you set up webhooks? What should
                                I watch out for?"

[payments-project Claude]  →  "We use checkout sessions → webhook →
                                fulfill order. Make sure you verify
                                signatures and handle idempotency keys.
                                Test locally with `stripe listen`."
```

Each Claude stays in its own project directory, with its own permissions. No filesystem wandering, no accidental deletions, no reading files from unrelated projects. Just message-based knowledge transfer.

### More examples

- **Auth patterns** — Your main app's Claude explains the JWT + refresh token setup to a new microservice's Claude, without exposing the actual secrets or user database.
- **API contracts** — Frontend Claude asks Backend Claude "what does POST /orders expect?" instead of navigating into the backend repo and potentially breaking something.
- **Database schemas** — A Claude working on analytics asks the core app's Claude about table relationships, without needing read access to migration files that contain production connection strings.
- **Deployment knowledge** — Your DevOps project's Claude tells another Claude how CI/CD is configured, what to watch out for with environment variables, without sharing the actual pipeline files.
- **Code review across repos** — One Claude reviews patterns another Claude is about to implement: "we tried that approach in project X, it caused race conditions. Use optimistic locking instead."

The key principle: **knowledge flows through messages, not filesystem access.**

## How It Works

```
Project A (Terminal 1)          Project B (Terminal 2)
        |                              |
    Claude Code                    Claude Code
    (scoped to A)                  (scoped to B)
        |                              |
    MCP Server ────── SQLite ────── MCP Server
        |            (shared)          |
    PTY Wrapper                    PTY Wrapper
        |                              |
    auto-injects                   auto-injects
    messages when                  messages when
    Claude is idle                 Claude is idle
```

Each Claude Code instance runs an MCP server connected to a shared SQLite database (`~/.multi-claude/messages.db`). Messages are delivered through:

1. **Hooks** — `UserPromptSubmit` and `Stop` hooks automatically check for unread messages on every interaction
2. **PTY wrapper** — Detects when Claude is idle and injects a trigger to check messages

## Setup

```bash
npx multi-claude setup
```

That's it. This registers the MCP server and configures hooks automatically.

<details>
<summary>Manual setup</summary>

If you prefer to configure manually:

```bash
# Register MCP server
claude mcp add multi-claude -- npx -y multi-claude serve

# Add hooks to ~/.claude/settings.json (UserPromptSubmit and Stop)
# Hook command: npx -y multi-claude inbox
```

See `~/.claude/settings.json` for the full hook format.

</details>

## Usage

### Interactive mode (with auto-delivery)

Open two terminals in different project directories:

```bash
# Terminal 1 — in your payments project
cd ~/projects/payments-api
npx multi-claude connect payments-expert

# Terminal 2 — in your new project
cd ~/projects/new-app
npx multi-claude connect new-app
```

The wrapper spawns Claude inside a PTY, auto-registers with `/name`, and delivers incoming messages automatically when Claude is idle.

In Terminal 2, just tell Claude:
> Ask payments-expert how they integrated Stripe webhooks

Claude sends the message, and the payments-expert Claude responds with the relevant context — all without accessing each other's files.

### Manual mode (without wrapper)

Open Claude Code normally in any project and register:

```
/name payments-expert
```

Messages are checked automatically via hooks whenever you or Claude interacts. To send:
> Send a message to new-app explaining our webhook setup

### Orchestrator mode (fully automated)

For automated multi-agent conversations:

```bash
npx multi-claude orchestrate \
  "Frontend:React developer" \
  "Backend:Node.js developer" \
  --goal "Design the API contract for user authentication" \
  --start "List the endpoints we need" \
  --max-turns 20
```

## Architecture

| Component | File | Purpose |
|-----------|------|---------|
| MCP Server | `src/server.ts` | Registers peers, sends/receives messages via SQLite |
| Inbox Hook | `src/check-inbox.js` | Notifies Claude of unread messages on hook triggers |
| PTY Wrapper | `src/connect.py` | Wraps Claude in a PTY, auto-injects message checks when idle |
| Orchestrator | `src/orchestrator.ts` | Spawns multiple Claude instances and relays messages between them |

### MCP Tools

| Tool | Description |
|------|-------------|
| `register` | Register this session with a display name |
| `send_message` | Send a message to a peer by name |
| `list_peers` | List all registered Claude instances |
| `get_messages` | Read and mark delivered all pending messages |

## Limitations

- **Not truly real-time in manual mode** — Messages are checked on interaction (hook triggers). If both sides are idle, messages wait until someone types.
- **PTY wrapper improves this** — Auto-delivers when Claude is idle, but requires running through the wrapper.
- **macOS/Linux only** — The PTY wrapper uses `pty.fork()` (not available on Windows).
- **Local only** — All instances must be on the same machine (shared SQLite).

## License

ISC
