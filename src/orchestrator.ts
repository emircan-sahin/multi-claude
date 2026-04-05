#!/usr/bin/env node

import { spawn } from 'child_process';
import * as readline from 'readline';
import crypto from 'crypto';

// ─── Colors ──────────────────────────────────────────────
const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  agents: ['\x1b[36m', '\x1b[35m', '\x1b[33m', '\x1b[34m', '\x1b[32m'],
};

// ─── Types ───────────────────────────────────────────────
interface Agent {
  name: string;
  role: string;
  sessionId: string;
  color: string;
  turns: number;
}

// ─── Logging ─────────────────────────────────────────────
function agentLog(agent: Agent, text: string) {
  for (const line of text.split('\n')) {
    console.log(`${agent.color}[${agent.name}]${C.reset} ${line}`);
  }
}

function sysLog(msg: string) {
  console.log(`${C.dim}[system]${C.reset} ${msg}`);
}

// ─── Run a single agent turn via `claude -p` ─────────────
function runAgent(agent: Agent, prompt: string, cwd?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const args = ['-p', prompt, '--output-format', 'text', '--dangerously-skip-permissions'];

    if (agent.turns === 0) {
      // First turn: create session
      args.push(
        '--session-id', agent.sessionId,
        '--name', agent.name,
        '--system-prompt',
        [
          `You are "${agent.name}", a ${agent.role}.`,
          `You are part of a multi-agent team. An orchestrator relays messages between you and your teammates.`,
          `Messages from teammates arrive prefixed with [From <Name>].`,
          `Stay focused, be concise, collaborate. Write code when needed.`,
          `When the team's goal is fully achieved, include GOAL_COMPLETE at the end of your message.`,
        ].join(' '),
      );
    } else {
      // Resume existing session
      args.push('--resume', agent.sessionId);
    }

    const proc = spawn('claude', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: cwd || process.cwd(),
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stdout += text;
      // Stream output in real-time with agent prefix
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (i < lines.length - 1) {
          process.stdout.write(`${agent.color}[${agent.name}]${C.reset} ${line}\n`);
        } else if (line) {
          process.stdout.write(`${agent.color}[${agent.name}]${C.reset} ${line}`);
        }
      }
    });

    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    proc.on('close', (code) => {
      agent.turns++;
      process.stdout.write('\n');
      if (code === 0 || code === null) {
        resolve(stdout.trim());
      } else {
        reject(new Error(`${agent.name} exited with code ${code}${stderr ? ': ' + stderr.slice(0, 200) : ''}`));
      }
    });

    proc.on('error', (err) => {
      reject(new Error(`Failed to spawn claude for ${agent.name}: ${err.message}`));
    });

    proc.stdin.end();
  });
}

// ─── Parse CLI args ──────────────────────────────────────
function parseArgs() {
  const argv = process.argv.slice(2);
  const agents: { name: string; role: string }[] = [];
  let goal = '';
  let start = '';
  let maxTurns = 20;
  let cwd: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--goal': case '-g':
        goal = argv[++i]; break;
      case '--start': case '-s':
        start = argv[++i]; break;
      case '--max-turns': case '-t':
        maxTurns = parseInt(argv[++i]); break;
      case '--cwd': case '-C':
        cwd = argv[++i]; break;
      case '--help': case '-h':
        console.log(`
${C.bold}multi-claude orchestrator${C.reset}

Usage:
  npx multi-claude "Name:Role" "Name:Role" [options]

Example:
  npx multi-claude "Frontend:React developer" "Backend:Node.js developer" \\
    --goal "Build a login page with JWT auth" \\
    --start "Discuss the API contract first"

Options:
  --goal, -g <text>       Goal for the team
  --start, -s <text>      Initial prompt to kick off
  --max-turns, -t <n>     Max conversation rounds (default: 20)
  --cwd, -C <path>        Working directory for agents
  --help, -h              Show this help

During orchestration:
  Type a message to send to all agents
  @AgentName message    Send to specific agent
  /goal <text>          Set a new goal
  /status               Show current status
  /quit                 Stop orchestration
`);
        process.exit(0);
      default:
        if (!argv[i].startsWith('-')) {
          const colonIdx = argv[i].indexOf(':');
          if (colonIdx > 0) {
            agents.push({
              name: argv[i].slice(0, colonIdx).trim(),
              role: argv[i].slice(colonIdx + 1).trim(),
            });
          } else {
            agents.push({ name: argv[i].trim(), role: 'developer' });
          }
        }
    }
  }

  if (agents.length < 2) {
    console.error(`${C.red}Error: At least 2 agents required.${C.reset}`);
    console.error(`Example: npx multi-claude "Frontend:React dev" "Backend:Node.js dev" --goal "Build login"`);
    process.exit(1);
  }

  return { agents, goal, start, maxTurns, cwd };
}

// ─── User input handler ──────────────────────────────────
function createInputHandler(): { getLine: () => Promise<string | null>; close: () => void } {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const pending: Array<(line: string | null) => void> = [];
  let closed = false;

  rl.on('line', (line) => {
    if (pending.length > 0) {
      pending.shift()!(line);
    }
  });

  rl.on('close', () => {
    closed = true;
    for (const resolve of pending) resolve(null);
    pending.length = 0;
  });

  return {
    getLine: () => {
      if (closed) return Promise.resolve(null);
      return new Promise((resolve) => {
        pending.push(resolve);
      });
    },
    close: () => rl.close(),
  };
}

// ─── Main orchestration loop ─────────────────────────────
async function main() {
  const config = parseArgs();

  // Check claude CLI is available
  try {
    const { execSync } = await import('child_process');
    execSync('claude --version', { stdio: 'pipe' });
  } catch {
    console.error(`${C.red}Error: 'claude' CLI not found. Make sure Claude Code is installed.${C.reset}`);
    process.exit(1);
  }

  const agents: Agent[] = config.agents.map((a, i) => ({
    name: a.name,
    role: a.role,
    sessionId: crypto.randomUUID(),
    color: C.agents[i % C.agents.length],
    turns: 0,
  }));

  // ─── Header ─────────────
  console.log(`\n${C.bold}╔════════════════════════════════════════╗${C.reset}`);
  console.log(`${C.bold}║      multi-claude orchestrator         ║${C.reset}`);
  console.log(`${C.bold}╠════════════════════════════════════════╣${C.reset}`);
  console.log(`${C.bold}║${C.reset} Agents: ${agents.map(a => `${a.color}${a.name}${C.reset} (${a.role})`).join(', ')}`);
  if (config.goal) {
    console.log(`${C.bold}║${C.reset} Goal: ${config.goal}`);
  }
  console.log(`${C.bold}║${C.reset} Max turns: ${config.maxTurns}`);
  console.log(`${C.bold}╚════════════════════════════════════════╝${C.reset}\n`);

  // ─── Build initial context ─────────────
  const teamList = agents.map(a => `- ${a.name} (${a.role})`).join('\n');
  const goalLine = config.goal ? `\n\nGoal: ${config.goal}` : '';
  const startLine = config.start || 'Introduce yourself briefly and start working toward the goal with your teammate(s).';

  const initialPrompt = `You are working in a team:\n${teamList}${goalLine}\n\n${startLine}`;

  // ─── Round 0: Initialize agents ─────────────
  const responses = new Map<string, string>();

  // First agent gets the initial prompt
  sysLog(`Initializing ${agents[0].name}...`);
  try {
    const resp = await runAgent(agents[0], initialPrompt, config.cwd);
    responses.set(agents[0].name, resp);
  } catch (err: any) {
    console.error(`${C.red}${err.message}${C.reset}`);
    process.exit(1);
  }

  // Other agents get the initial prompt + first agent's response
  for (let i = 1; i < agents.length; i++) {
    sysLog(`Initializing ${agents[i].name}...`);
    const prevMessages = Array.from(responses.entries())
      .map(([name, text]) => `[From ${name}]:\n${text}`)
      .join('\n\n');

    try {
      const resp = await runAgent(agents[i], `${initialPrompt}\n\n${prevMessages}`, config.cwd);
      responses.set(agents[i].name, resp);
    } catch (err: any) {
      console.error(`${C.red}${err.message}${C.reset}`);
    }
  }

  // ─── Main conversation loop ─────────────
  let round = 1;
  let goalComplete = false;
  let userMessage: string | null = null as string | null;

  // Set up non-blocking user input
  sysLog('Type a message to intervene, @Name to target an agent, /quit to stop.\n');

  while (round <= config.maxTurns && !goalComplete) {
    for (const agent of agents) {
      // Build message from other agents
      const fromOthers = Array.from(responses.entries())
        .filter(([name]) => name !== agent.name)
        .map(([name, text]) => `[From ${name}]:\n${text}`)
        .join('\n\n');

      // Check for user interjection (non-blocking poll via stdin)
      let userContext = '';
      if (userMessage) {
        if (userMessage.startsWith('@')) {
          const spaceIdx = userMessage.indexOf(' ');
          const targetName = userMessage.slice(1, spaceIdx > 0 ? spaceIdx : undefined);
          const msg = spaceIdx > 0 ? userMessage.slice(spaceIdx + 1) : '';
          if (targetName.toLowerCase() === agent.name.toLowerCase() && msg) {
            userContext = `\n\n[From User]: ${msg}`;
          }
        } else {
          userContext = `\n\n[From User]: ${userMessage}`;
        }
        if (userContext) userMessage = null; // consumed
      }

      if (!fromOthers && !userContext) continue;

      sysLog(`Round ${round} - ${agent.name}'s turn...`);

      try {
        const resp = await runAgent(agent, `${fromOthers}${userContext}`, config.cwd);
        responses.set(agent.name, resp);

        if (resp.includes('GOAL_COMPLETE')) {
          goalComplete = true;
          break;
        }
      } catch (err: any) {
        sysLog(`${C.red}Error from ${agent.name}: ${err.message}${C.reset}`);
      }
    }

    round++;
  }

  // ─── Summary ─────────────
  if (goalComplete) {
    console.log(`\n${C.green}${C.bold}✓ Goal completed in ${round - 1} rounds!${C.reset}\n`);
  } else {
    console.log(`\n${C.yellow}${C.bold}⚠ Reached max turns (${config.maxTurns}). Use --max-turns to increase.${C.reset}\n`);
  }

  // Print session IDs for resuming
  sysLog('Agent sessions (resume with: claude --resume <id>):');
  for (const agent of agents) {
    console.log(`  ${agent.color}${agent.name}${C.reset}: ${agent.sessionId}`);
  }
  console.log();

  process.exit(0);
}

main().catch((err) => {
  console.error(`${C.red}Fatal: ${err.message}${C.reset}`);
  process.exit(1);
});
