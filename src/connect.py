#!/usr/bin/env python3
"""
multi-claude connect — PTY wrapper that auto-injects peer messages into Claude Code.

Usage: python3 connect.py <name>
Example: python3 connect.py selim
"""

import pty
import tty
import os
import sys
import select
import signal
import fcntl
import termios
import sqlite3
import time
import shutil

# ─── Args ──────────────────────────────────────────────────
if len(sys.argv) < 2:
    print("Usage: python3 connect.py <name>", file=sys.stderr)
    print("Example: python3 connect.py selim", file=sys.stderr)
    sys.exit(1)

PEER_NAME = sys.argv[1]
DB_PATH = os.path.expanduser("~/.multi-claude/messages.db")
CLAUDE_BIN = shutil.which("claude") or "claude"

# ─── State ─────────────────────────────────────────────────
master_fd = -1
child_pid = -1
last_output_time = 0.0
injecting = False
registered = False
old_termios = None

# ─── DB helpers ────────────────────────────────────────────
def check_registered():
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
    """Copy current terminal size to the PTY."""
    try:
        size = fcntl.ioctl(sys.stdout.fileno(), termios.TIOCGWINSZ, b'\x00' * 8)
        fcntl.ioctl(fd, termios.TIOCSWINSZ, size)
    except Exception:
        pass

def handle_sigwinch(signum, frame):
    """Forward window resize to the PTY."""
    if master_fd >= 0:
        set_winsize(master_fd)
        os.kill(child_pid, signal.SIGWINCH)

# ─── Main ──────────────────────────────────────────────────
def main():
    global master_fd, child_pid, last_output_time, injecting, registered, old_termios

    # Fork a PTY and exec Claude
    child_pid, master_fd = pty.fork()

    if child_pid == 0:
        # Child: exec Claude
        os.execvp(CLAUDE_BIN, [CLAUDE_BIN])
        sys.exit(1)

    # Parent: set up terminal
    old_termios = termios.tcgetattr(sys.stdin.fileno())
    try:
        tty.setraw(sys.stdin.fileno(), termios.TCSANOW)

        set_winsize(master_fd)
        signal.signal(signal.SIGWINCH, handle_sigwinch)

        # Schedule auto-register after 3 seconds
        register_time = time.time() + 3.0
        register_sent = False

        last_output_time = time.time()
        last_check_time = time.time()

        while True:
            try:
                rlist, _, _ = select.select([sys.stdin.fileno(), master_fd], [], [], 0.5)
            except (select.error, ValueError):
                break

            now = time.time()

            # Forward stdin → PTY
            if sys.stdin.fileno() in rlist:
                try:
                    data = os.read(sys.stdin.fileno(), 4096)
                    if not data:
                        break
                    os.write(master_fd, data)
                except OSError:
                    break

            # Forward PTY → stdout
            if master_fd in rlist:
                try:
                    data = os.read(master_fd, 4096)
                    if not data:
                        break
                    os.write(sys.stdout.fileno(), data)
                    last_output_time = now
                except OSError:
                    break

            # Auto-register: send /name command once
            if not register_sent and now >= register_time:
                register_sent = True
                cmd = f"/name {PEER_NAME}\r"
                os.write(master_fd, cmd.encode())

            # Check registration
            if not registered and register_sent and now - register_time > 5:
                registered = check_registered()

            # Check for pending messages every 2 seconds
            if registered and not injecting and (now - last_check_time) >= 2.0:
                last_check_time = now
                idle_duration = now - last_output_time

                # Only inject if Claude has been idle for 2+ seconds
                if idle_duration >= 2.0 and check_pending_messages():
                    injecting = True
                    # Type trigger into Claude's input
                    os.write(master_fd, b"check messages\r")
                    # Cooldown
                    time.sleep(0.1)
                    last_output_time = now

            # Reset injection lock after cooldown
            if injecting and (now - last_output_time) >= 5.0:
                injecting = False

    except KeyboardInterrupt:
        pass
    finally:
        # Restore terminal
        if old_termios:
            termios.tcsetattr(sys.stdin.fileno(), termios.TCSADRAIN, old_termios)
        try:
            os.kill(child_pid, signal.SIGTERM)
            os.waitpid(child_pid, 0)
        except Exception:
            pass

if __name__ == "__main__":
    main()
