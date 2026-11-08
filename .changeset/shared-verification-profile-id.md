---
"@osstack/core": patch
"@osstack/cli": patch
---

Share the installed verification profile ID grammar across V2 local-failure grants, receipt bindings and profile loading. Reject new V2 opt-ins whose profile IDs cannot identify an installed profile, while preserving V1 grant validation and signing.
