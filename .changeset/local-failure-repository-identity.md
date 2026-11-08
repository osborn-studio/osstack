---
"@osstack/core": patch
"@osstack/cli": patch
---

Share bounded repository identity validation across new V2 grants, local failure data, CI reads and installed profiles. Support dot and underscore prefixes such as `o/.github`, and reject standalone dot components and traversal. Existing V1 grant parsing is unchanged.
