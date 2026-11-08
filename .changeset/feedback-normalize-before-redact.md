---
"@osstack/cli": patch
---

Strip unsafe control and format characters before secret redaction in review and local verification feedback. This prevents normalization from reconstructing an obfuscated credential after the redaction pass.
