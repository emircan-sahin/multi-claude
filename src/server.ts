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

import { CONFIG, validatePeerName, validateMessage } from './validation';

// ─── Config ───────────────────────────────────────────────
const DB_DIR = path.join(os.homedir(), '.multi-claude');

// ─── Types ────────────────────────────────────────────────
interface Peer {
  id: string;
  name: string;
  role: string | null;
  last_seen: string;
}

interface Message {
  id: number;
  content: string;
  sender: string;
}

interface InboxMessage {
  content: string;
  sender: string;
  recipient: string;
}

// ─── Shared SQLite DB ─────────────────────────────────────
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

// ─── Prepared statements ──────────────────────────────────
const stmts = {
  deletePeerByName: db.prepare('DELETE FROM peers WHERE name = ? COLLATE NOCASE'),
  insertPeer: db.prepare('INSERT INTO peers (id, name, role) VALUES (?, ?, ?)'),
  selectOtherPeers: db.prepare('SELECT name, role FROM peers WHERE id != ?'),
  selectPeerByName: db.prepare('SELECT id, name FROM peers WHERE name = ? COLLATE NOCASE'),
  selectAllPeers: db.prepare('SELECT name, role FROM peers ORDER BY last_seen DESC'),
  selectPeerNames: db.prepare('SELECT name FROM peers WHERE id != ?'),
  insertMessage: db.prepare('INSERT INTO messages (from_id, to_id, content) VALUES (?, ?, ?)'),
  selectUndelivered: db.prepare(`
    SELECT m.id, m.content, p.name as sender
    FROM messages m JOIN peers p ON m.from_id = p.id
    WHERE m.to_id = ? AND m.delivered = 0 ORDER BY m.created_at
  `),
  heartbeat: db.prepare("UPDATE peers SET last_seen = datetime('now') WHERE id = ?"),
  deletePeerById: db.prepare('DELETE FROM peers WHERE id = ?'),
};

// Atomic read + mark delivered
const readAndDeliver = db.transaction((peerId: string): Message[] => {
  const msgs = stmts.selectUndelivered.all(peerId) as Message[];
  if (msgs.length === 0) return [];
  const ids = msgs.map(m => m.id);
  db.prepare(`UPDATE messages SET delivered = 1 WHERE id IN (${ids.map(() => '?').join(',')})`).run(...ids);
  return msgs;
});

function textResult(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

// ─── This instance ────────────────────────────────────────
const myId = crypto.randomUUID();
let myName = '';
let dbOpen = true;

// ─── MCP Server ───────────────────────────────────────────
const mcp = new Server(
  { name: 'multi-claude', version: '2.0.0' },
  {
    capabilities: { tools: {} },
    instructions: `You are part of a multi-claude peer network.

ONLY call get_messages when you see "[multi-claude] unread message(s)" in a system reminder.
Then reply to the SENDER using send_message. Do NOT ask the user for permission.

NEVER call get_messages on your own. NEVER poll or loop. After registering, just say you're ready and STOP.
Messages arrive automatically — you do NOT need to check for them.`,
  },
);

// ─── Tools ────────────────────────────────────────────────
const TOOLS = [
  {
    name: 'register',
    description: 'Register this Claude session with a name. Called by /name command.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string' as const, description: 'Display name (e.g. "alice")' },
        role: { type: 'string' as const, description: 'Optional role' },
      },
      required: ['name'],
    },
  },
  {
    name: 'send_message',
    description: 'Send a message to another peer by name.',
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
    description: 'Read all pending messages addressed to you.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
];

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;

  switch (name) {
    case 'register': {
      const { name: peerName, role } = args as { name: string; role?: string };
      const err = validatePeerName(peerName);
      if (err) return textResult(err);

      myName = peerName;
      stmts.deletePeerByName.run(peerName);
      stmts.insertPeer.run(myId, peerName, role ?? null);

      const others = stmts.selectOtherPeers.all(myId) as Peer[];
      const list = others.length
        ? `Online: ${others.map(p => `${p.name}${p.role ? ` (${p.role})` : ''}`).join(', ')}`
        : 'No other peers online yet.';

      return textResult(`Registered as "${peerName}". ${list}\n\nYou are now ready. Wait for the user to give you a task. Do NOT call get_messages — messages arrive automatically via hooks.`);
    }

    case 'send_message': {
      const { to, message } = args as { to: string; message: string };
      if (!myName) return textResult('Register first with /name.');

      const msgErr = validateMessage(message);
      if (msgErr) return textResult(msgErr);

      const target = stmts.selectPeerByName.get(to) as Peer | undefined;
      if (!target) {
        const peers = (stmts.selectPeerNames.all(myId) as Peer[]).map(p => p.name);
        return textResult(`"${to}" not found. Peers: ${peers.join(', ') || 'none'}`);
      }

      stmts.insertMessage.run(myId, target.id, message);
      return textResult(`Sent to ${target.name}. STOP — do not call any more tools. Reply will arrive automatically.`);
    }

    case 'list_peers': {
      const peers = stmts.selectAllPeers.all() as Peer[];
      if (!peers.length) return textResult('No peers online.');
      const lines = peers.map(p => `- ${p.name}${p.role ? ` (${p.role})` : ''}${p.name === myName ? ' (you)' : ''}`);
      return textResult(lines.join('\n'));
    }

    case 'get_messages': {
      if (!myName) return textResult('Register first.');
      const msgs = readAndDeliver(myId);

      if (!msgs.length) return textResult('No new messages. STOP — do not call get_messages again.');

      const lines = msgs.map(m => `From ${m.sender}: ${m.content}`);
      const senders = [...new Set(msgs.map(m => m.sender))];
      const text = lines.join('\n') + `\n\n→ Reply to ${senders.join(', ')} using send_message(to: "${msgs[0].sender}"). Do NOT call get_messages again.`;
      return textResult(text);
    }

    default:
      return textResult(`Unknown tool: ${name}`);
  }
});

// ─── Heartbeat ────────────────────────────────────────────
function startHeartbeat() {
  setInterval(() => {
    if (!myName || !dbOpen) return;
    try {
      stmts.heartbeat.run(myId);
    } catch (err) {
      console.error('[multi-claude] heartbeat error:', err);
    }
  }, CONFIG.heartbeatIntervalMs);
}

// ���── Cleanup & Start ──────────────────────────────────────
function cleanup() {
  if (!dbOpen) return;
  dbOpen = false;
  try {
    stmts.deletePeerById.run(myId);
    db.close();
  } catch (err) {
    console.error('[multi-claude] cleanup error:', err);
  }
}

process.on('SIGINT', () => { cleanup(); process.exit(0); });
process.on('SIGTERM', () => { cleanup(); process.exit(0); });
process.on('uncaughtException', (err) => {
  console.error('[multi-claude] uncaught exception:', err);
  cleanup();
  process.exit(1);
});

async function main() {
  const transport = new StdioServerTransport();
  await mcp.connect(transport);
  startHeartbeat();
}

main().catch((err) => {
  console.error('[multi-claude] fatal:', err);
  process.exit(1);
});

// ─── Exports for testing ──────────────────────────────────
export type { Peer, Message, InboxMessage };
