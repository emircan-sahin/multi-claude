#!/usr/bin/env node
const path = require('path');
const os = require('os');
const fs = require('fs');

const dbPath = path.join(os.homedir(), '.multi-claude', 'messages.db');
if (!fs.existsSync(dbPath)) process.exit(0);

try {
  const Database = require(path.join(__dirname, '..', 'node_modules', 'better-sqlite3'));
  const db = new Database(dbPath, { readonly: true });

  const msgs = db.prepare(`
    SELECT m.content, p.name as sender, p2.name as recipient
    FROM messages m
    JOIN peers p ON m.from_id = p.id
    JOIN peers p2 ON m.to_id = p2.id
    WHERE m.delivered = 0
    ORDER BY m.created_at ASC
    LIMIT 10
  `).all();

  db.close();

  if (msgs.length > 0) {
    const lines = msgs.map(m => `  ${m.sender} -> ${m.recipient}: ${m.content}`);
    // This output goes to Claude as context - Claude will act on it
    console.log(`[multi-claude] ${msgs.length} unread message(s):\n${lines.join('\n')}\n\nUse get_messages tool to read and respond to these messages.`);
  }
} catch {
  process.exit(0);
}
