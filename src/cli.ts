#!/usr/bin/env node

import { execSync, spawn } from 'child_process';
import path from 'path';
import os from 'os';
import fs from 'fs';

const BOLD = '\x1b[1m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

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
  } catch (err: any) {
    const msg = err.stderr?.toString() || '';
    if (msg.includes('already exists')) {
      console.log(`${GREEN}  OK${RESET} MCP server already registered`);
    } else {
      console.error(`${RED}  FAIL${RESET} ${msg.trim()}`);
      process.exit(1);
    }
  }

  // 3. Configure hooks
  console.log(`${DIM}[2/3]${RESET} Configuring hooks...`);
  const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
  let settings: any = {};

  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  } catch {
    // File doesn't exist or invalid JSON — start fresh
  }

  settings.hooks = settings.hooks || {};
  const hookCommand = inboxCommand;
  const hookEntry = {
    matcher: '',
    hooks: [{ type: 'command', command: hookCommand, statusMessage: 'checking peer messages' }],
  };

  let modified = false;

  for (const event of ['UserPromptSubmit', 'Stop'] as const) {
    settings.hooks[event] = settings.hooks[event] || [];
    const exists = settings.hooks[event].some((h: any) =>
      h.hooks?.some((hh: any) => hh.command === hookCommand)
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

  console.log(`\n${GREEN}${BOLD}Setup complete!${RESET}\n`);
  console.log(`Usage:`);
  console.log(`  ${DIM}# In any Claude Code session:${RESET}`);
  console.log(`  /name alice\n`);
  console.log(`  ${DIM}# Or with auto-delivery:${RESET}`);
  console.log(`  npx multi-claude connect alice\n`);
}

// ─── Inbox (hook script) ──────────────────────────────────
function inbox() {
  const dbPath = path.join(os.homedir(), '.multi-claude', 'messages.db');
  if (!fs.existsSync(dbPath)) process.exit(0);

  try {
    const Database = require('better-sqlite3');
    const db = new Database(dbPath, { readonly: true });

    const msgs = db.prepare(`
      SELECT m.content, p.name as sender, p2.name as recipient
      FROM messages m
      JOIN peers p ON m.from_id = p.id
      JOIN peers p2 ON m.to_id = p2.id
      WHERE m.delivered = 0
      ORDER BY m.created_at ASC
      LIMIT 10
    `).all() as any[];

    db.close();

    if (msgs.length > 0) {
      const lines = msgs.map((m: any) => `  ${m.sender} -> ${m.recipient}: ${m.content}`);
      console.log(
        `[multi-claude] ${msgs.length} unread message(s):\n${lines.join('\n')}\n\nUse get_messages tool to read and respond to these messages.`
      );
    }
  } catch {
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
