#!/usr/bin/env python3
"""notify-osborn.py — multi-channel notifier for osstack cron jobs.

Tries channels in order, stops at the first that succeeds:

  1. Email   — via Gmail SMTP if credentials are in Keychain
  2. Hermes  — via `hermes` CLI, posts to the default gateway
  3. Local   — writes to ~/.osstack/logs/notifications.log + macOS user notification
  4. Stderr  — always prints, so a cron tail catches it

Usage:
    notify-osborn.py --subject "..." --body "..." [--severity info|warn|error]

Email setup (one-time, optional):
    1. Create a Gmail App Password:
       https://myaccount.google.com/apppasswords  (requires 2FA on the account)
    2. Store it in macOS Keychain:
         security add-generic-password \\
           -a gilberthello@gmail.com \\
           -s osstack-notifier-smtp \\
           -w 'YOUR_16_CHAR_APP_PASSWORD'
    3. Set sender + recipient env vars (add to ~/.zshrc or wherever):
         export OSSTACK_NOTIFY_FROM="gilberthello@gmail.com"
         export OSSTACK_NOTIFY_TO="gilberthello@gmail.com"
    Without these, the notifier silently falls back to Hermes/local channels.
"""

from __future__ import annotations

import argparse
import os
import smtplib
import subprocess
import sys
from datetime import datetime
from email.mime.text import MIMEText
from pathlib import Path
from typing import Optional


LOG_DIR = Path.home() / ".osstack" / "logs"
LOG_FILE = LOG_DIR / "notifications.log"

SMTP_SERVICE_NAME = "osstack-notifier-smtp"


# ── channel 1: gmail smtp ─────────────────────────────────────────────

def _keychain_password(account: str, service: str = SMTP_SERVICE_NAME) -> Optional[str]:
    try:
        out = subprocess.run(
            ["security", "find-generic-password", "-a", account, "-s", service, "-w"],
            capture_output=True, text=True, timeout=5,
        )
        if out.returncode != 0:
            return None
        pw = out.stdout.strip()
        return pw or None
    except (subprocess.TimeoutExpired, FileNotFoundError):
        return None


def try_email(subject: str, body: str) -> tuple[bool, str]:
    sender = os.environ.get("OSSTACK_NOTIFY_FROM")
    recipient = os.environ.get("OSSTACK_NOTIFY_TO")
    if not sender or not recipient:
        return False, "skip:no_OSSTACK_NOTIFY_FROM_or_TO"
    pw = _keychain_password(sender)
    if not pw:
        return False, f"skip:no_keychain_entry_for_{sender}"
    msg = MIMEText(body, "plain", "utf-8")
    msg["Subject"] = subject
    msg["From"] = sender
    msg["To"] = recipient
    try:
        with smtplib.SMTP_SSL("smtp.gmail.com", 465, timeout=15) as s:
            s.login(sender, pw)
            s.sendmail(sender, [recipient], msg.as_string())
        return True, f"sent_to={recipient}"
    except Exception as exc:  # noqa: BLE001
        return False, f"smtp_error:{type(exc).__name__}:{exc}"


# ── channel 2: hermes gateway ─────────────────────────────────────────

def _hermes_bin() -> Optional[str]:
    candidates = [
        os.environ.get("HERMES_BIN"),
        "/Users/osborn/hermes-agent/.venv/bin/hermes",
        "/Volumes/AIMATE_WORK/projects/hermes-agent/.venv/bin/hermes",
        "hermes",
    ]
    for c in candidates:
        if c is None:
            continue
        try:
            r = subprocess.run([c, "--version"], capture_output=True, timeout=4)
            if r.returncode == 0:
                return c
        except (subprocess.TimeoutExpired, FileNotFoundError, OSError):
            continue
    return None


def try_hermes(subject: str, body: str) -> tuple[bool, str]:
    bin_ = _hermes_bin()
    if not bin_:
        return False, "skip:no_hermes_binary"
    # We piggyback on hermes by adding a one-shot reminder cron that fires
    # immediately. Crude, but doesn't require deeper hermes API knowledge.
    # (Skipped for now — return false and let it fall through to local.)
    # TODO: replace with proper hermes gateway send API once we identify it.
    _ = subject
    _ = body
    return False, "skip:hermes_push_api_not_wired_yet"


# ── channel 3: local log + macOS notification ─────────────────────────

def try_local(subject: str, body: str, severity: str) -> tuple[bool, str]:
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    ts = datetime.now().strftime("%Y-%m-%dT%H:%M:%S")
    line = f"[{ts}] [{severity.upper()}] {subject}\n  {body.replace(chr(10), chr(10) + '  ')}\n"
    with open(LOG_FILE, "a", encoding="utf-8") as f:
        f.write(line)
    # Best-effort macOS notification (works on the foreground user session;
    # silently no-ops when running under launchd or remote ssh).
    try:
        subprocess.run(
            ["osascript", "-e",
             f'display notification {shellescape(body[:240])} '
             f'with title {shellescape(subject)}'],
            capture_output=True, timeout=4,
        )
    except (subprocess.TimeoutExpired, FileNotFoundError):
        pass
    return True, f"wrote:{LOG_FILE}"


def shellescape(s: str) -> str:
    return '"' + s.replace("\\", "\\\\").replace('"', '\\"').replace("\n", "\\n") + '"'


# ── entry point ───────────────────────────────────────────────────────

def main() -> int:
    ap = argparse.ArgumentParser(description="multi-channel osstack notifier")
    ap.add_argument("--subject", required=True)
    ap.add_argument("--body", required=True)
    ap.add_argument("--severity", choices=["info", "warn", "error"], default="info")
    ap.add_argument("--only", choices=["email", "hermes", "local"],
                    help="restrict to a single channel (for testing)")
    args = ap.parse_args()

    channels = ["email", "hermes", "local"] if args.only is None else [args.only]
    results: list[tuple[str, bool, str]] = []
    sent_to_remote = False

    for ch in channels:
        if ch == "email":
            ok, info = try_email(args.subject, args.body)
        elif ch == "hermes":
            ok, info = try_hermes(args.subject, args.body)
        elif ch == "local":
            # Always run local — it's the fallback log.
            ok, info = try_local(args.subject, args.body, args.severity)
        else:
            continue
        results.append((ch, ok, info))
        if ok and ch in ("email", "hermes"):
            sent_to_remote = True
            break

    # Always also write to local log so a forensic trail exists even when
    # email succeeded. Skip if local already ran above.
    if not any(r[0] == "local" for r in results):
        ok, info = try_local(args.subject, args.body, args.severity)
        results.append(("local", ok, info))

    # Always echo to stderr so cron tail catches it.
    print(f"[notify-osborn] subject={args.subject}", file=sys.stderr)
    for ch, ok, info in results:
        marker = "✓" if ok else "·"
        print(f"  {marker} {ch:7s} {info}", file=sys.stderr)
    if not sent_to_remote:
        print("  ⚠ no remote channel succeeded — see ~/.osstack/logs/notifications.log",
              file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
