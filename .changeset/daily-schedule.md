---
"@osstack/cli": minor
---

R2.3 — `osstack daily` scheduling via the daemon. The read-only portfolio brief
can now run on an interval as a persisted daemon session, alongside (and
modeled on) the existing loop-session pattern.

- `daily-command.ts`: extracted the brief composition into an exported
  `runDailyBrief(deps)` core (registry read → maturity scan → GitHub status →
  stack board → delta → persist dated brief → strict `AgentCommandResult`).
  `handleDailyCommand` is now a thin wrapper (parse flags → `runDailyBrief` →
  render), so a scheduled brief is byte-compatible with a manual `osstack daily`
  run. Bare `osstack daily` is unchanged.
- `daemon.ts`: new session kind `daily` with its own map, `daily-sessions.json`
  persistence (atomic tmp+rename), and restore-on-start — mirroring loop
  sessions. Each tick runs `runDailyBrief` in-process (no shelling out) and
  records the latest result (`lastResultStatus` / `lastBriefPath`). A tick
  failure never crashes the daemon or kills the session: it is counted, and the
  session auto-stops after 5 consecutive failures with a persisted stop reason.
  New RPC methods `daily.schedule` / `daily.list` / `daily.stop`.
- Policy: `daily` is read-only and intentionally **not** observe-gated —
  observing is exactly what `mode: observe` permits (asserted in tests).
- CLI: `osstack daily schedule --interval-ms N [--registry P] [--workspace P]
  [--schedule EXPR]`, `osstack daily sessions [--json]`, and `osstack daily
  unschedule <daily_session_id>` — requiring a running daemon (same refusal
  wording as other daemon-only commands). Interval parsing reuses the exact
  `--interval-ms` / `parseNonNegativeIntegerFlag` convention from `loop start`.
