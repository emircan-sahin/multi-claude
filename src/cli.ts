#!/usr/bin/env node

import { execSync, spawn } from 'child_process';
import path from 'path';
import os from 'os';
import fs from 'fs';

// ─── Types ────────────────────────────────────────────────
interface HookDef {
  type: string;
  command: string;
  statusMessage?: string;
}

interface HookEntry {
  matcher: string;
  hooks: HookDef[];
}

interface ClaudeSettings {
  hooks?: Record<string, HookEntry[]>;
  [key: string]: unknown;
}

interface InboxRow {
  content: string;
  sender: string;
  recipient: string;
}

// ─── Colors ───────────────────────────────────────────────
const BOLD = '\x1b[1m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

// ─── Main ─────────────────────────────────────────────────
const command = process.argv[2];
const args = process.argv.slice(3);

switch (command) {
  case 'setup':
    setup();
    break;
  case 'serve':
    require('./server');
    break;
  case 'inbox':
    inbox();
    break;
  case 'connect':
    connect(args[0]);
    break;
  default:
    help();
}

// ─── Setup ────────────────────────────────────────────────
function setup() {
  console.log(`\n${BOLD}multi-claude setup${RESET}\n`);

  // 1. Check claude CLI exists
  try {
    execSync('claude --version', { stdio: 'pipe' });
  } catch {
    console.error(`${RED}Error: 'claude' CLI not found. Install Claude Code first.${RESET}`);
    process.exit(1);
  }

  // Detect if running from local clone or npx
  const cliDir = path.resolve(__dirname);
  const localServerJs = path.join(cliDir, 'server.js');
  const localCliJs = path.join(cliDir, 'cli.js');
  const isLocal = fs.existsSync(localServerJs) && !cliDir.includes('.npm');

  const serveCommand = isLocal
    ? `node ${localServerJs}`
    : 'npx -y multi-claude serve';
  const inboxCommand = isLocal
    ? `node ${localCliJs} inbox`
    : 'npx -y multi-claude inbox';

  if (isLocal) {
    console.log(`${DIM}Detected local install: ${path.resolve(cliDir, '..')}${RESET}\n`);
  }

  // 2. Add MCP server
  console.log(`${DIM}[1/3]${RESET} Registering MCP server...`);
  try {
    execSync(`claude mcp add multi-claude -- ${serveCommand}`, { stdio: 'pipe' });
    console.log(`${GREEN}  OK${RESET} MCP server registered`);
  } catch (err: unknown) {
    const msg = (err as { stderr?: Buffer })?.stderr?.toString() ?? '';
    if (msg.includes('already exists')) {
      console.log(`${GREEN}  OK${RESET} MCP server already registered`);
    } else {
      console.error(`${RED}  FAIL${RESET} ${msg.trim() || 'Unknown error'}`);
      process.exit(1);
    }
  }

  // 3. Configure hooks
  console.log(`${DIM}[2/3]${RESET} Configuring hooks...`);
  const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
  let settings: ClaudeSettings = {};

  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as ClaudeSettings;
  } catch {
    // File doesn't exist or invalid JSON — start fresh
  }

  settings.hooks = settings.hooks ?? {};
  const hookEntry: HookEntry = {
    matcher: '',
    hooks: [{ type: 'command', command: inboxCommand, statusMessage: 'checking peer messages' }],
  };

  let modified = false;

  for (const event of ['UserPromptSubmit', 'Stop']) {
    settings.hooks[event] = settings.hooks[event] ?? [];
    const exists = settings.hooks[event].some(h =>
      h.hooks?.some(hh => hh.command === inboxCommand)
    );
    if (!exists) {
      settings.hooks[event].push(hookEntry);
      modified = true;
    }
  }

  if (modified) {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
    console.log(`${GREEN}  OK${RESET} Hooks added to ${settingsPath}`);
  } else {
    console.log(`${GREEN}  OK${RESET} Hooks already configured`);
  }

  // 4. Create data directory
  console.log(`${DIM}[3/3]${RESET} Creating data directory...`);
  const dataDir = path.join(os.homedir(), '.multi-claude');
  fs.mkdirSync(dataDir, { recursive: true });
  console.log(`${GREEN}  OK${RESET} ${dataDir}`);

  const connectPyPath = path.resolve(__dirname, '..', 'src', 'connect.py');

  console.log(`\n${GREEN}${BOLD}Setup complete!${RESET}\n`);
  console.log(`${BOLD}Quick start:${RESET}`);
  console.log(`  Open Claude Code anywhere and type: /name alice\n`);
  console.log(`${BOLD}Auto-delivery (recommended):${RESET}`);
  console.log(`  Add this alias to ~/.zshrc or ~/.bashrc:`);
  console.log(`  ${DIM}alias mcc='python3 ${connectPyPath}'${RESET}\n`);
  console.log(`  Then run: mcc alice\n`);
}

// ─── Inbox (hook script) ──────────────────────────────────
function inbox() {
  const dbPath = path.join(os.homedir(), '.multi-claude', 'messages.db');
  if (!fs.existsSync(dbPath)) process.exit(0);

  try {
    const Database = require('better-sqlite3');
    const db = new Database(dbPath);

    const msgs = db.prepare(`
      SELECT m.id, m.content, p.name as sender, p2.name as recipient
      FROM messages m
      JOIN peers p ON m.from_id = p.id
      JOIN peers p2 ON m.to_id = p2.id
      WHERE m.delivered = 0
      ORDER BY m.created_at ASC
      LIMIT 10
    `).all() as (InboxRow & { id: number })[];

    if (msgs.length > 0) {
      // Mark as delivered
      const ids = msgs.map(m => m.id);
      db.prepare(`UPDATE messages SET delivered = 1 WHERE id IN (${ids.map(() => '?').join(',')})`).run(...ids);

      const senders = [...new Set(msgs.map(m => m.sender))];
      const lines = msgs.map(m => `  [${m.sender}]: ${m.content}`);
      console.log(
        `[multi-claude] ${msgs.length} new message(s):\n${lines.join('\n')}\n\nReply using send_message(to: "${senders[0]}"). Do NOT call get_messages.`
      );
    }

    db.close();
  } catch (err) {
    console.error('[multi-claude] inbox error:', err);
    process.exit(0);
  }
}

// ─── Connect (PTY wrapper) ────────────────────────────────
function connect(name?: string) {
  if (!name) {
    console.error(`${RED}Usage: multi-claude connect <name>${RESET}`);
    console.error(`Example: multi-claude connect alice`);
    process.exit(1);
  }

  const connectPy = path.join(__dirname, '..', 'src', 'connect.py');
  if (!fs.existsSync(connectPy)) {
    console.error(`${RED}Error: connect.py not found at ${connectPy}${RESET}`);
    process.exit(1);
  }

  const child = spawn('python3', [connectPy, name], {
    stdio: 'inherit',
    cwd: process.cwd(),
  });

  child.on('exit', (code) => process.exit(code ?? 0));
}

// ─── Help ─────────────────────────────────────────────────
function help() {
  console.log(`
${BOLD}multi-claude${RESET} — peer-to-peer messaging between Claude Code instances

${BOLD}Commands:${RESET}
  ${GREEN}setup${RESET}            Configure MCP server and hooks (run once)
  ${GREEN}connect <name>${RESET}   Start Claude with auto-delivery via PTY wrapper
  ${GREEN}serve${RESET}            Run MCP server (called by Claude Code)
  ${GREEN}inbox${RESET}            Check for unread messages (called by hooks)

${BOLD}Quick start:${RESET}
  npx multi-claude setup
  npx multi-claude connect alice

${BOLD}Manual mode:${RESET}
  ${DIM}Open Claude Code in any project and type:${RESET}
  /name alice
`);
}
