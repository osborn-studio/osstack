# Publication artifact dispositions

No original evidence was modified. This record distinguishes local retention from public-package membership.

## Retained initial settings

- **claude-v2-absent**: original `runs/claude-v2-absent/state/settings-before-builtin-deny.json` exists (2306 bytes), SHA256 `2a2815a3fd86adc76f595af1794875c27a9ebe62aa4c20c6aff2ec1498e74938`. It exactly matches `claude-v2-prepared.json`.
  Final `runs/claude-v2-absent/state/settings.json`: 3705 bytes, SHA256 `84314f44d515211687c589883076c59e02a65d6be3bf09aaa5ad76dd4bcb7da0`; dispatch binding matches. Only the deny array changed: 53 observed native Skill names added, none removed; all other settings are equal.
- **claude-v2-present**: original `runs/claude-v2-present/state/settings-before-builtin-deny.json` exists (2318 bytes), SHA256 `77297e966fe1df7638f3e9c86aa3ed01b6889be90b128bd053601ccf50ea1ccf`. It exactly matches `claude-v2-prepared.json`.
  Final `runs/claude-v2-present/state/settings.json`: 3717 bytes, SHA256 `9c492842d620b5b2bed83350b715f9b608e564ada65625488b14282a722f2184`; dispatch binding matches. Only the deny array changed: 53 observed native Skill names added, none removed; all other settings are equal.

The prepared record is historical, not an incorrect final-runtime declaration. The original files were saved before the 53-deny refinement. Include both original settings files in the public archive; preserve the prepared record and identify final settings as superseding it for actual user turns.

## Vendor implementation excerpts retained locally

- `harness/catalog-semantics.json`: 7403 bytes; SHA256 `140e9efd8e6b3dc9307d422292b6fc012617d76b87b4655174a55bfc12b6e9b2`. Local file exists and remains unchanged. Public omission avoids redistributing proprietary vendor implementation excerpts; retain this hash/disposition and public paraphrase.
- `harness/claude-v2-permission-source.json`: 7911 bytes; SHA256 `225f68a89bbdd837283c8dd3401601fc78d065d042dc74b73dc6bfddf62be109`. Local file exists and remains unchanged. Public omission avoids redistributing proprietary vendor implementation excerpts; retain this hash/disposition and public paraphrase.
- `harness/claude-v2-permission-followup.json`: 4383 bytes; SHA256 `d3c233adae22ad37ac8bd16c1f65e965991ad7cd0bf950ef49002cc8c9f8a0c8`. Local file exists and remains unchanged. Public omission avoids redistributing proprietary vendor implementation excerpts; retain this hash/disposition and public paraphrase.

These omissions limit archive-only replay of `v2-check-prefreeze.py`; the public archive must not imply that every original local checker can run using its members alone. CLI help evidence is separately captured in `public-help-evidence.json`; this is help-text-derived evidence, not another model experiment.
