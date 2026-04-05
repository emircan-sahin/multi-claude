#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import Database from 'better-sqlite3';
import crypto from 'crypto';
import path from 'path';
import os from 'os';
import fs from 'fs';

// ─── Shared SQLite DB ──────────────────────────────────────
const DB_DIR = path.join(os.homedir(), '.multi-claude');
fs.mkdirSync(DB_DIR, { recursive: true });
const db = new Database(path.join(DB_DIR, 'messages.db'));
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');

db.exec(`
  CREATE TABLE IF NOT EXISTS peers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    role TEXT,
    last_seen TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_id TEXT NOT NULL,
    to_id TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    delivered INTEGER DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_msg_undelivered ON messages(to_id, delivered);
`);

// ─── This instance ─────────────────────────────────────────
const myId = crypto.randomUUID();
let myName = '';
let dbOpen = true;

// ─── MCP Server (low-level for channel support) ────────────
const mcp = new Server(
  { name: 'multi-claude', version: '2.0.0' },
  {
    capabilities: {
      tools: {},
    },
    instructions: `You are part of a multi-claude peer network.

When you see "[multi-claude] unread message(s)" in system reminders:
1. Call get_messages to read them
2. Reply to the SENDER (not yourself) using send_message
3. Do NOT ask the user for permission — respond autonomously

Do NOT loop or poll. Just respond and stop. New messages arrive automatically.`,
  },
);

// ─── Tools ─────────────────────────────────────────────────
const TOOLS = [
  {
    name: 'register',
    description: 'Register this Claude session with a name. Called by /name command.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string' as const, description: 'Display name (e.g. "Ahmet")' },
        role: { type: 'string' as const, description: 'Optional role' },
      },
      required: ['name'],
    },
  },
  {
    name: 'send_message',
    description: 'Send a message to another peer by name. Delivered instantly via channel.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        to: { type: 'string' as const, description: 'Recipient name' },
        message: { type: 'string' as const, description: 'Message content' },
      },
      required: ['to', 'message'],
    },
  },
  {
    name: 'list_peers',
    description: 'List all online Claude instances.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'get_messages',
    description: 'Manually check for new messages.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
];

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;

  switch (name) {
    case 'register': {
      const { name: peerName, role } = args as { name: string; role?: string };
      myName = peerName;
      db.prepare('DELETE FROM peers WHERE name = ? COLLATE NOCASE').run(peerName);
      db.prepare('INSERT INTO peers (id, name, role) VALUES (?, ?, ?)').run(myId, peerName, role ?? null);

      const others = db.prepare('SELECT name, role FROM peers WHERE id != ?').all(myId) as any[];
      const list = others.length
        ? `Online: ${others.map((p: any) => `${p.name}${p.role ? ` (${p.role})` : ''}`).join(', ')}`
        : 'No other peers online yet.';

      return { content: [{ type: 'text' as const, text: `Registered as "${peerName}". ${list}` }] };
    }

    case 'send_message': {
      const { to, message } = args as { to: string; message: string };
      if (!myName) return { content: [{ type: 'text' as const, text: 'Register first with /name.' }] };

      const target = db.prepare('SELECT id, name FROM peers WHERE name = ? COLLATE NOCASE').get(to) as any;
      if (!target) {
        const peers = (db.prepare('SELECT name FROM peers WHERE id != ?').all(myId) as any[]).map((p: any) => p.name);
        return { content: [{ type: 'text' as const, text: `"${to}" not found. Peers: ${peers.join(', ') || 'none'}` }] };
      }

      db.prepare('INSERT INTO messages (from_id, to_id, content) VALUES (?, ?, ?)').run(myId, target.id, message);
      return { content: [{ type: 'text' as const, text: `Sent to ${target.name}. STOP — do not call any more tools. Reply will arrive automatically.` }] };
    }

    case 'list_peers': {
      const peers = db.prepare('SELECT name, role FROM peers ORDER BY last_seen DESC').all() as any[];
      if (!peers.length) return { content: [{ type: 'text' as const, text: 'No peers online.' }] };
      const lines = peers.map((p: any) => `- ${p.name}${p.role ? ` (${p.role})` : ''}${p.name === myName ? ' (you)' : ''}`);
      return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
    }

    case 'get_messages': {
      if (!myName) return { content: [{ type: 'text' as const, text: 'Register first.' }] };
      const msgs = db.prepare(`
        SELECT m.id, m.content, p.name as sender
        FROM messages m JOIN peers p ON m.from_id = p.id
        WHERE m.to_id = ? AND m.delivered = 0 ORDER BY m.created_at
      `).all(myId) as any[];

      if (!msgs.length) return { content: [{ type: 'text' as const, text: 'No new messages. STOP — do not call get_messages again.' }] };

      const ids = msgs.map((m: any) => m.id);
      db.prepare(`UPDATE messages SET delivered = 1 WHERE id IN (${ids.map(() => '?').join(',')})`).run(...ids);
      const lines = msgs.map((m: any) => `From ${m.sender}: ${m.content}`);
      const replyTo = [...new Set(msgs.map((m: any) => m.sender))].join(', ');
      const text = lines.join('\n') + `\n\n→ Reply to ${replyTo} using send_message(to: "${msgs[0].sender}"). Do NOT call get_messages again.`;
      return { content: [{ type: 'text' as const, text }] };
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
});

// ─── Heartbeat: keep peer alive in DB ─────────────────────
function startHeartbeat() {
  setInterval(() => {
    try {
      if (!myName || !dbOpen) return;
      db.prepare("UPDATE peers SET last_seen = datetime('now') WHERE id = ?").run(myId);
    } catch {}
  }, 5000);
}

// ─── Cleanup & Start ───────────────────────────────────────
process.on('uncaughtException', () => {});
process.on('unhandledRejection', () => {});

function cleanup() {
  if (!dbOpen) return;
  dbOpen = false;
  try {
    db.prepare('DELETE FROM peers WHERE id = ?').run(myId);
    db.close();
  } catch {}
}

process.on('SIGINT', () => { cleanup(); process.exit(0); });
process.on('SIGTERM', () => { cleanup(); process.exit(0); });

async function main() {
  const transport = new StdioServerTransport();
  await mcp.connect(transport);
  startHeartbeat();
}

main().catch(() => process.exit(1));
