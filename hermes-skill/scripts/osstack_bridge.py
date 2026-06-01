#!/usr/bin/env python3
"""osstack_bridge — Hermes ↔ osstack daemon bridge.

Two transports:
  - Spawn: runs the `osstack` CLI binary as a one-shot subprocess. Works
    without a running daemon. Used for `version` and local diagnostics.
  - Unix socket: connects to the running daemon using length-prefixed JSON
    framing (matches Hermes Run Adapter wire format). Used in steady state.

Wire format (Unix socket): [4-byte BE uint32 length][JSON payload bytes]
"""

from __future__ import annotations

import json
import os
import shutil
import socket
import struct
import subprocess
import sys
from typing import Any

OSSTACK_BIN_ENV = "OSSTACK_BIN"
OSSTACK_SOCKET_ENV = "OSSTACK_SOCKET"
DEFAULT_BIN = "osstack"
DEFAULT_SOCKET_PATH = "/tmp/osstack.sock"

MAX_FRAME_BYTES = 16 * 1024 * 1024
SOCKET_CONNECT_TIMEOUT_S = 2.0
SOCKET_READ_TIMEOUT_S = 30.0


# ── subprocess transport ──────────────────────────────────────────────

def _find_osstack() -> str | None:
    env_override = os.environ.get(OSSTACK_BIN_ENV)
    if env_override and os.path.exists(env_override):
        return env_override
    return shutil.which(DEFAULT_BIN)


def _exec(args: list[str]) -> dict[str, Any]:
    binary = _find_osstack()
    if binary is None:
        return {
            "ok": False,
            "error": "osstack_not_found",
            "hint": (
                "osstack binary not on PATH. Install (when published): "
                "`pnpm -g add @osstack/cli`. Or set OSSTACK_BIN env var to "
                "an absolute path."
            ),
        }
    try:
        result = subprocess.run(
            [binary, *args],
            capture_output=True,
            text=True,
            timeout=30,
        )
    except subprocess.TimeoutExpired:
        return {"ok": False, "error": "timeout", "binary": binary}
    except (OSError, FileNotFoundError) as exc:
        return {"ok": False, "error": "spawn_failed", "detail": str(exc)}

    return {
        "ok": result.returncode == 0,
        "binary": binary,
        "exit_code": result.returncode,
        "stdout": result.stdout.strip(),
        "stderr": result.stderr.strip() if result.stderr else None,
    }


# ── socket transport ──────────────────────────────────────────────────

def _socket_path() -> str:
    return os.environ.get(OSSTACK_SOCKET_ENV) or DEFAULT_SOCKET_PATH


def _send_frame(sock: socket.socket, payload: dict[str, Any]) -> None:
    body = json.dumps(payload).encode("utf-8")
    if len(body) > MAX_FRAME_BYTES:
        raise ValueError(f"frame too large: {len(body)} bytes")
    header = struct.pack(">I", len(body))
    sock.sendall(header + body)


def _recv_exact(sock: socket.socket, n: int) -> bytes:
    chunks: list[bytes] = []
    remaining = n
    while remaining > 0:
        chunk = sock.recv(remaining)
        if not chunk:
            raise EOFError("socket closed mid-frame")
        chunks.append(chunk)
        remaining -= len(chunk)
    return b"".join(chunks)


def _recv_frame(sock: socket.socket) -> dict[str, Any]:
    header = _recv_exact(sock, 4)
    (size,) = struct.unpack(">I", header)
    if size > MAX_FRAME_BYTES:
        raise ValueError(f"daemon frame too large: {size} bytes")
    body = _recv_exact(sock, size)
    return json.loads(body.decode("utf-8"))


def _daemon_call(method: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
    path = _socket_path()
    if not os.path.exists(path):
        return {
            "ok": False,
            "error": "daemon_not_running",
            "hint": f"socket not found at {path}. Start the daemon: `osstack serve`.",
        }
    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    sock.settimeout(SOCKET_CONNECT_TIMEOUT_S)
    try:
        sock.connect(path)
    except OSError as exc:
        return {"ok": False, "error": "connect_failed", "detail": str(exc), "socket": path}
    sock.settimeout(SOCKET_READ_TIMEOUT_S)
    try:
        req: dict[str, Any] = {"id": 1, "method": method}
        if params is not None:
            req["params"] = params
        _send_frame(sock, req)
        resp = _recv_frame(sock)
        return {"ok": True, "response": resp}
    except (OSError, EOFError, ValueError) as exc:
        return {"ok": False, "error": "io_error", "detail": str(exc)}
    finally:
        try:
            sock.close()
        except OSError:
            pass


# ── commands ──────────────────────────────────────────────────────────

def cmd_version() -> dict[str, Any]:
    """Spawn the binary as a one-shot. Works without a running daemon."""
    return _exec(["version"])


def cmd_health() -> dict[str, Any]:
    """Local-only diagnostic. Does NOT require the daemon."""
    binary = _find_osstack()
    path = _socket_path()
    return {
        "ok": True,
        "skill_version": "0.0.0",
        "skill_phase": "S1-scaffold",
        "osstack_binary": binary,
        "osstack_binary_found": binary is not None,
        "daemon_socket_path": path,
        "daemon_socket_present": os.path.exists(path),
        "hermes_home": os.environ.get("HERMES_HOME", os.path.expanduser("~/.hermes")),
    }


def cmd_daemon_version() -> dict[str, Any]:
    """Talk to the running daemon and ask its version."""
    return _daemon_call("version")


def cmd_daemon_health() -> dict[str, Any]:
    """Talk to the running daemon and ask for its health snapshot."""
    return _daemon_call("health")


# ── kanban commands (the Telegram-facing surface) ─────────────────────
#
# These are what Hermes invokes when a Telegram user asks about the osstack
# board. Each maps to a daemon RPC. Args come positionally from sys.argv so
# the Hermes skill can shell them straight from a parsed chat command.

def cmd_kanban_board() -> dict[str, Any]:
    """Show the board. Optional: argv[2] = board slug, argv[3] = 'archived'."""
    params: dict[str, Any] = {}
    if len(sys.argv) > 2 and sys.argv[2]:
        params["board"] = sys.argv[2]
    if len(sys.argv) > 3 and sys.argv[3] == "archived":
        params["include_archived"] = True
    return _daemon_call("kanban.board", params)


def cmd_kanban_create() -> dict[str, Any]:
    """Create a card. argv[2] = title (required), argv[3] = priority, argv[4] = assignee."""
    if len(sys.argv) < 3 or not sys.argv[2].strip():
        return {"ok": False, "error": "missing_title", "usage": "kanban-create <title> [priority] [assignee]"}
    params: dict[str, Any] = {"title": sys.argv[2]}
    if len(sys.argv) > 3 and sys.argv[3]:
        try:
            params["priority"] = int(sys.argv[3])
        except ValueError:
            pass
    if len(sys.argv) > 4 and sys.argv[4]:
        params["assignee"] = sys.argv[4]
    return _daemon_call("kanban.create", params)


def cmd_kanban_move() -> dict[str, Any]:
    """Move a card. argv[2] = card_id, argv[3] = status, argv[4] = reason (optional)."""
    if len(sys.argv) < 4:
        return {"ok": False, "error": "bad_args", "usage": "kanban-move <card_id> <status> [reason]"}
    params: dict[str, Any] = {"card_id": sys.argv[2], "status": sys.argv[3], "actor": "telegram"}
    if len(sys.argv) > 4 and sys.argv[4]:
        params["blocked_reason"] = sys.argv[4]
    return _daemon_call("kanban.move", params)


def cmd_kanban_comment() -> dict[str, Any]:
    """Comment on a card. argv[2] = card_id, argv[3] = text, argv[4] = author (optional)."""
    if len(sys.argv) < 4:
        return {"ok": False, "error": "bad_args", "usage": "kanban-comment <card_id> <text> [author]"}
    params: dict[str, Any] = {"card_id": sys.argv[2], "body": sys.argv[3]}
    params["author"] = sys.argv[4] if len(sys.argv) > 4 and sys.argv[4] else "telegram"
    return _daemon_call("kanban.comment", params)


def cmd_kanban_subscribe() -> dict[str, Any]:
    """Subscribe a chat to a card's progress.

    argv[2] = card_id, argv[3] = chat_id, argv[4] = thread_id (optional).
    platform defaults to 'telegram'. This is the key call: after it, the
    notifier drain (kanban-events) yields messages destined for this chat.
    """
    if len(sys.argv) < 4:
        return {"ok": False, "error": "bad_args", "usage": "kanban-subscribe <card_id> <chat_id> [thread_id]"}
    params: dict[str, Any] = {
        "card_id": sys.argv[2],
        "platform": "telegram",
        "chat_id": sys.argv[3],
    }
    if len(sys.argv) > 4 and sys.argv[4]:
        params["thread_id"] = sys.argv[4]
    return _daemon_call("kanban.subscribe", params)


def cmd_kanban_events() -> dict[str, Any]:
    """Drain pending card events. argv[2] = since (event id, optional).

    Hermes calls this on a cron tick; for each returned event it formats a
    Telegram message and delivers to the subscribed chats. The daemon tracks
    delivery cursors per subscription so this is at-least-once safe.
    """
    params: dict[str, Any] = {}
    if len(sys.argv) > 2 and sys.argv[2]:
        try:
            params["since"] = int(sys.argv[2])
        except ValueError:
            pass
    return _daemon_call("kanban.events", params)


def cmd_kanban_subscriptions() -> dict[str, Any]:
    """List notify subscriptions. argv[2] = card_id (optional filter)."""
    params: dict[str, Any] = {}
    if len(sys.argv) > 2 and sys.argv[2]:
        params["card_id"] = sys.argv[2]
    return _daemon_call("kanban.subscriptions", params)


def cmd_kanban_drain() -> dict[str, Any]:
    """Drain per-subscription messages (THE relay tick).

    Returns a list of {platform, chat_id, thread_id, card_id, text} the
    caller should deliver. The daemon advances each subscription's cursor,
    so already-delivered events are not re-emitted. Run this on a Hermes
    cron tick; for each message, send `text` to `chat_id`/`thread_id`.
    """
    return _daemon_call("kanban.drain")


COMMANDS = {
    "version": cmd_version,
    "health": cmd_health,
    "daemon-version": cmd_daemon_version,
    "daemon-health": cmd_daemon_health,
    "kanban-board": cmd_kanban_board,
    "kanban-create": cmd_kanban_create,
    "kanban-move": cmd_kanban_move,
    "kanban-comment": cmd_kanban_comment,
    "kanban-subscribe": cmd_kanban_subscribe,
    "kanban-events": cmd_kanban_events,
    "kanban-subscriptions": cmd_kanban_subscriptions,
    "kanban-drain": cmd_kanban_drain,
}


def main() -> int:
    if len(sys.argv) < 2:
        print(json.dumps({"ok": False, "error": "no_command", "available": list(COMMANDS)}, indent=2))
        return 1
    cmd = sys.argv[1]
    fn = COMMANDS.get(cmd)
    if fn is None:
        print(json.dumps({"ok": False, "error": "unknown_command", "given": cmd, "available": list(COMMANDS)}, indent=2))
        return 1
    result = fn()
    print(json.dumps(result, indent=2))
    return 0 if result.get("ok") else 1


if __name__ == "__main__":
    sys.exit(main())
