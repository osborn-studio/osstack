Fixed pstack 0.15.36 method materials can now be exported with checked material hashes and an explicit component adoption candidate. The first five adapted references cover bug fixing, investigation, review, evidence and attribution; other references keep their existing source pins. The exporter rejects material drift and conflicting source hashes before creating output, and retains the exact provenance declaration in both project layouts.

This adds a pure `@osstack/skill-registry/source-adoption` entrypoint for declared fixed-commit components, with shared-file consistency, dependency closure and resource bounds. The candidate explicitly leaves semantic completeness, repository/version authentication and external host/check prerequisites unverified. It performs no fetching, installation, runtime activation or host task execution.

Validation:
- Final source-adoption tests: 35 passed; exporter/provenance: 115 passed.
- Independent fixed vectors plus real Git component checks and fresh Codex/Claude project exports; the audit repair's six vectors changed from 4 pass/2 fail to 6 pass. Original errors and harness corrections are retained.
- Fresh build/typecheck, targeted TypeScript lint, inventory and changeset coverage passed; MJS is not covered by Biome.
- Full regression at pre-audit-fix `2389dcd9`: 22 packages, 7,334 passed/5 skipped/0 failed on Node22 with matching native ABI. Later fixes have targeted validation; this is not relabeled as final-tree full. Original Node26 transform and local native-ABI failures remain in the evidence.
- Actual Sonnet 5.5 static review: PASS_WITH_CONCERNS, then limited repair closure PASS. Documentation validation: 241 passed.

See `docs/implementation/pstack-adoption-bundle/README.md` for exact source bindings, adopted/excluded behavior, raw evidence and remaining first-use work. This also absorbs the prior control updates and PR312 final CI/Ready receipts without changing PR312's candidate.

Stacked on #312; keep Draft until the parent is merged, then retarget to actual main and revalidate. Human approval/merge only. The actual card → compiled method → existing Loop/deliver → same-card receipt path remains P4/P5/P6 work; Firstmate deep runtime remains prohibited.
