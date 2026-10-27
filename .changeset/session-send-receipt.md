---
"@osstack/cli": patch
---

Preserve the committed Session send result when writer lease cleanup fails. Keep uncertain delivery errors and retained admission intact. Replaying the original request does not send it again, including after daemon restart.
