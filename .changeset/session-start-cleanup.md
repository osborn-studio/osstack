---
"@osstack/cli": patch
---

Preserve completed Session start responses when writer lease cleanup fails. Clear the settled active-run marker while keeping retained admission visible to drain in the current daemon instance. Database-driven replay of the original start request does not start another Session.

Retained-hold visibility across process restart is not verified. Recovery and drain visibility after process death remain pending in DEBT02. This change does not add a recovery API.

Replay is a lookup of the stored Session state. A failed initial start returns `agent_failed`; replay returns `ok: true` with `state: failed` and never repeats the adapter invocation. Callers must inspect the stored state. Terminal producer fencing remains a separate change in #279.
