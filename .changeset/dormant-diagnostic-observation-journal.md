---
"@osstack/core": patch
---

Add a dormant diagnostic observation journal with unregistered DDL and an internal store. Preserve opaque receipt JSON and its raw UTF-8 `receipt_bytes_sha256` hash. This hash is not a canonical `receipt_digest` and creates no repair authority. The journal does not enable intake, register a migration, integrate the shared grant budget, or add scanner, dispatch, public index, or CLI wiring. Timeout observations remain ineligible for repair. A future trusted host reconciler must prove process stop before settlement; this store checks lifecycle constraints and proof references only.
