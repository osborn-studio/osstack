---
"@osstack/cli": patch
---

Preserve the committed Session send result when writer lease cleanup fails. Keep uncertain delivery errors and retained admission intact. Database-driven replay does not send the original request again; tests cover a daemon restart in the same process.

Retained-hold visibility across process restart is not verified. Recovery and drain visibility after process death remain pending in DEBT02. This change does not add a recovery API.
