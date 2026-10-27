---
"@osstack/cli": patch
---

Preserve completed Session start responses when writer lease cleanup fails. Clear the settled active-run marker while keeping retained admission visible to drain. Repeating the original start request does not start another Session.
