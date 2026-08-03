# Governed Resumable Sessions

`osstack session` keeps a bounded, durable conversation handle for supported
Codex CLI and Claude Code runtimes. It is intended for owner-initiated relay
messages that must survive daemon restarts without exposing the provider's
native session identifier.

## Prerequisites

- Start the local daemon with `osstack serve`.
- Complete the native Codex or Claude login first.
- Use an absolute repository path.
- Treat `request-id` and `message-id` as idempotency keys. Reusing either key
  with different content is rejected.

## Start and inspect a session

```bash
osstack session start \
  --request-id task-123-session \
  --agent codex-cli \
  --repo "$PWD" \
  --title "Task 123 implementation" \
  --text "Inspect the current implementation and report the next safe step" \
  --json

osstack session list --json
osstack session status <session_id> --json
osstack session snapshot <session_id> --json
```

The public response contains the osstack session, runtime, turn, state, and
optimistic version. It never returns the provider-native session identifier.

## Send the next instruction

Use the current `runtime_id`, `turn_id`, and `version` from the snapshot:

```bash
osstack session send <session_id> \
  --runtime codex-cli \
  --turn <turn_id> \
  --message-id task-123-owner-002 \
  --expected-version <version> \
  --requested-by owner \
  --text "Proceed with the approved option" \
  --json
```

An identical replay of an applied message returns `duplicate` without invoking
the runtime again. A stale version, wrong turn, wrong runtime, reused key with
different content, terminal session, or protected metadata leak fails closed.

## Delivery uncertainty

Local reservation, the completed turn, the session version, and message state
are transactional. A provider process is still an external system: if the
daemon stops after the provider may have received an instruction but before a
terminal result is committed, osstack returns `delivery_uncertain` on replay
and does not automatically resend it. Inspect the provider/session outcome,
then use a new `message-id` only when an owner intentionally chooses to retry.

This is deliberate at-most-once automated delivery. osstack does not claim
remote exactly-once semantics that Codex or Claude cannot prove.

## Decision directives

A runtime can request a bounded human choice by returning only this JSON object
as an assistant message:

```json
{
  "ostag_decision": {
    "decision_id": "deployment_path",
    "question": "Which rollout path should be used?",
    "choices": [
      { "choice_id": "canary", "label": "Canary" },
      { "choice_id": "staged", "label": "Staged" }
    ]
  }
}
```

osstack validates the exact shape and records the session as
`awaiting_decision`; extra keys or oversized values are treated as normal text.
