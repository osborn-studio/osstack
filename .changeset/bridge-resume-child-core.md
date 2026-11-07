---
"@osstack/core": patch
"@osstack/cli": patch
---

Guard same-child revision resumes and recovered landed-round confirmation in the core chain store. Keep a re-granted child stopped until its decision is acknowledged.

At the runner decision entry, acknowledge an eligible child decision before advancing it, and admit a confirmed landed round for publication recovery. Refuse changed facts, disabled live mode, invalid grants, and store precondition failures with stable `resume_refused` codes. Keep new-PR Missions on their existing decision path.

Allow the grant CLI to renew every stop reason accepted by the core store, including `child_halted`. In 5-E, replace the duplicated resumable-code list in `contained-mission-revision-publication.ts` with the core export.

The §3.8 confirm-only deliver path (resumeLanded caller) lands with receipt recovery.
