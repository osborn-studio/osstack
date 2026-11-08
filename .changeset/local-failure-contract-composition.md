---
"@osstack/core": patch
"@osstack/cli": patch
---

Add composable, unwired local-failure contracts: explicit V2 grant parsing and signature verification, canonical intake IDs and receipt bindings, epoch-millisecond CI hints, typed feedback references and pinned installed profile loading. Existing V1 parsers and authority call sites remain unchanged. This does not enable diagnostic execution, child dispatch or a production scanner.
