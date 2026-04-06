#!/usr/bin/env python3
"""
multi-claude connect — PTY wrapper that auto-injects peer messages into Claude Code.

Usage:
  mcc <name>                  Start new session as <name>
  mcc <name> --resume <id>    Resume session as <name>
  mcc --resume <id>           Resume session (name looked up from saved sessions)
"""

import pty
import tty
import os
import sys
import json
import select
import signal
import fcntl
import termios
import sqlite3
import time
import shutil
import uuid

# ─── Config ────────────────────────────────────────────────
DATA_DIR = os.path.expanduser("~/.multi-claude")
DB_PATH = os.path.join(DATA_DIR, "messages.db")
SESSIONS_PATH = os.path.join(DATA_DIR, "sessions.json")
CLAUDE_BIN = shutil.which("claude") or "claude"

IDLE_THRESHOLD_S = 2.0
POLL_INTERVAL_S = 2.0
INJECT_COOLDOWN_S = 5.0
AUTO_REGISTER_DELAY_S = 3.0

# ─── Session store ─────────────────────────────────────────
def load_sessions():
    try:
        with open(SESSIONS_PATH, "r") as f:
            return json.load(f)
    except Exception:
        return {}

def save_session(session_id, peer_name):
    sessions = load_sessions()
    sessions[session_id] = peer_name
    os.makedirs(DATA_DIR, exist_ok=True)
    with open(SESSIONS_PATH, "w") as f:
        json.dump(sessions, f, indent=2)

# ─── Parse args ────────────────────────────────────────────
def parse_args():
    args = sys.argv[1:]
    peer_name = None
    claude_args = []
    session_id = None

    # Collect all positional args (before any --flag) as the peer name
    name_parts = []
    rest = args
    for i, arg in enumerate(args):
        if arg.startswith('-'):
            rest = args[i:]
            break
        name_parts.append(arg)
    else:
        rest = []

    if name_parts:
        peer_name = ' '.join(name_parts)
        claude_args = rest
    else:
        claude_args = args

    # Extract --resume session ID from claude args
    for i, arg in enumerate(claude_args):
        if arg == '--resume' and i + 1 < len(claude_args):
            session_id = claude_args[i + 1]
            break

    # If no peer name but we have a session ID, look it up
    if not peer_name and session_id:
        sessions = load_sessions()
        peer_name = sessions.get(session_id)
        if peer_name:
            print(f"[mcc] Reconnecting as '{peer_name}' from saved session", file=sys.stderr)

    # If new session (no --resume) and we have a name, generate session ID
    if peer_name and not session_id:
        session_id = str(uuid.uuid4())
        claude_args = ['--session-id', session_id] + claude_args

    # Save session → name mapping
    if peer_name and session_id:
        save_session(session_id, peer_name)

    return peer_name, claude_args

PEER_NAME, CLAUDE_EXTRA_ARGS = parse_args()

# ─── State ─────────────────────────────────────────────────
master_fd = -1
child_pid = -1
last_output_time = 0.0
injecting = False
registered = False
old_termios = None

# ─── DB helpers ────────────────────────────────────────────
def check_registered():
    if not PEER_NAME:
        return False
    try:
        conn = sqlite3.connect(DB_PATH, timeout=2)
        conn.execute("PRAGMA journal_mode=WAL")
        row = conn.execute(
            "SELECT id FROM peers WHERE name = ? COLLATE NOCASE", (PEER_NAME,)
        ).fetchone()
        conn.close()
        return row is not None
    except Exception:
        return False

def check_pending_messages():
    if not PEER_NAME:
        return False
    try:
        conn = sqlite3.connect(DB_PATH, timeout=2)
        conn.execute("PRAGMA journal_mode=WAL")
        row = conn.execute(
            """SELECT COUNT(*) FROM messages m
               JOIN peers p ON m.to_id = p.id
               WHERE p.name = ? COLLATE NOCASE AND m.delivered = 0""",
            (PEER_NAME,),
        ).fetchone()
        conn.close()
        return (row[0] if row else 0) > 0
    except Exception:
        return False

# ─── Terminal helpers ──────────────────────────────────────
def set_winsize(fd):
    try:
        size = fcntl.ioctl(sys.stdout.fileno(), termios.TIOCGWINSZ, b'\x00' * 8)
        fcntl.ioctl(fd, termios.TIOCSWINSZ, size)
    except Exception:
        pass

def handle_sigwinch(signum, frame):
    if master_fd >= 0:
        set_winsize(master_fd)
        os.kill(child_pid, signal.SIGWINCH)

# ─── Main ──────────────────────────────────────────────────
def main():
    global master_fd, child_pid, last_output_time, injecting, registered, old_termios

    child_pid, master_fd = pty.fork()

    if child_pid == 0:
        os.execvp(CLAUDE_BIN, [CLAUDE_BIN] + CLAUDE_EXTRA_ARGS)
        sys.exit(1)

    old_termios = termios.tcgetattr(sys.stdin.fileno())
    try:
        tty.setraw(sys.stdin.fileno(), termios.TCSANOW)
        set_winsize(master_fd)
        signal.signal(signal.SIGWINCH, handle_sigwinch)

        register_time = time.time() + AUTO_REGISTER_DELAY_S
        register_sent = False
        last_output_time = time.time()
        last_check_time = time.time()

        while True:
            try:
                rlist, _, _ = select.select([sys.stdin.fileno(), master_fd], [], [], 0.5)
            except (select.error, ValueError):
                break

            now = time.time()

            if sys.stdin.fileno() in rlist:
                try:
                    data = os.read(sys.stdin.fileno(), 4096)
                    if not data:
                        break
                    os.write(master_fd, data)
                except OSError:
                    break

            if master_fd in rlist:
                try:
                    data = os.read(master_fd, 4096)
                    if not data:
                        break
                    os.write(sys.stdout.fileno(), data)
                    last_output_time = now
                except OSError:
                    break

            # Auto-register
            if PEER_NAME and not register_sent and now >= register_time:
                register_sent = True
                os.write(master_fd, f"/name {PEER_NAME}\r".encode())

            # Check registration
            if PEER_NAME and not registered and register_sent and now - register_time > 5:
                registered = check_registered()

            # Check for pending messages
            if registered and not injecting and (now - last_check_time) >= POLL_INTERVAL_S:
                last_check_time = now
                idle_duration = now - last_output_time

                if idle_duration >= IDLE_THRESHOLD_S and check_pending_messages():
                    injecting = True
                    os.write(master_fd, b"check messages\r")
                    time.sleep(0.1)
                    last_output_time = now

            if injecting and (now - last_output_time) >= INJECT_COOLDOWN_S:
                injecting = False

    except KeyboardInterrupt:
        pass
    finally:
        if old_termios:
            termios.tcsetattr(sys.stdin.fileno(), termios.TCSADRAIN, old_termios)
        try:
            os.kill(child_pid, signal.SIGTERM)
            os.waitpid(child_pid, 0)
        except Exception:
            pass

if __name__ == "__main__":
    main()
