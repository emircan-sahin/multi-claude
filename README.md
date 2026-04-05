# multi-claude

Let your Claude Code instances talk to each other.

## Why?

You have multiple projects. One already has Stripe payments working, another needs it. Without multi-claude:

- **Give Claude access to the other project** — it might list wrong directories, read sensitive configs, or modify files it shouldn't
- **Copy-paste context yourself** — you become the bottleneck

With multi-claude, each Claude stays in its own project. They share knowledge through messages, not filesystem access:

```
[new-project]       →  "How did you set up Stripe webhooks?"

[payments-project]  →  "Checkout session → webhook → fulfill order.
                         Verify signatures, handle idempotency keys,
                         test with stripe listen."

[new-project]       →  "Got it, starting implementation."
                        *writes code in its own project*
```

This works for anything: auth patterns, API contracts, database schemas, deployment configs, cross-repo code review.

## Setup

```bash
git clone https://github.com/emircan-sahin/multi-claude.git
cd multi-claude
npm install
npm run setup
```

Setup registers the MCP server and hooks globally — works in every Claude session after this.

**Optional:** Add a shortcut to start the wrapper from any directory:

```bash
# Add to ~/.zshrc or ~/.bashrc
alias mcc='python3 ~/path/to/multi-claude/src/connect.py'
```

## Usage

### 1. Quick start

Open Claude Code in any project and register:

```
/name alice
```

That's it. You can now send and receive messages. In another terminal:

```
/name bob
```

Tell Bob: *"Send alice a message asking how she set up auth"*

> **Note:** In this mode, messages are delivered when you type something (via hooks). If Claude is idle, type anything to trigger a check.

### 2. Auto-delivery mode

For hands-free message delivery, use the wrapper — it detects when Claude is idle and checks for messages automatically:

```bash
# Terminal 1
mcc alice

# Terminal 2
mcc bob
```

No need to type `/name`, the wrapper does it for you.

### 3. Orchestrator mode

For fully automated conversations with no user input:

```bash
npx tsx src/orchestrator.ts \
  "Frontend:React dev" "Backend:Node.js dev" \
  --goal "Design the auth API" \
  --max-turns 10
```

## How it works

```
Terminal 1                    Terminal 2
Claude Code (alice)           Claude Code (bob)
     |                              |
 MCP Server ──── SQLite DB ──── MCP Server
                 (shared)
```

- **MCP Server** — each Claude gets `register`, `send_message`, `list_peers`, `get_messages` tools
- **SQLite** — messages stored in `~/.multi-claude/messages.db`
- **Hooks** — `UserPromptSubmit` and `Stop` hooks check for unread messages automatically
- **PTY Wrapper** — optional, injects message checks when Claude is idle

## Limitations

- Messages are local only (same machine, shared SQLite)
- Without the wrapper, both sides need user interaction to trigger message checks
- PTY wrapper requires macOS or Linux (uses `pty.fork()`)

## License

ISC
