# Hub agent publishing diagnosis and verification — 2026-09-09

## Finding

The supplied screenshot contains an agent's capability assertion, not an HTTP upload failure response. It incorrectly treats the OSStack Hub publisher as unrelated to OsbornSkillHub. The existing OSStack CLI invokes the Hub companion `tooling/osstack_publish.mjs`, which promotes a catalog-managed skill, commits/pushes the catalog repository, and polls `https://api.osbornhub.com` after the GitHub Actions deployment.

The Hub API source inspected on `origin/main` exposes catalog/read routes and no persistent HTTP upload handler. Live unauthenticated GET health returned 401; authenticated GET health returned 200 with `{ok:true,count:546,host:"api"}`. This proves read access from the investigated local runtime, not maomaobdm's publishing authorization. The live health shape differs from the inspected generated source's marker, so we do not claim exact deployment/source parity or exhaustive live route coverage.

## Changes

- `osstack hub doctor --json` discovers the existing GitOps route, checks local companion/catalog prerequisites and fixed-origin API health. It runs no Git/companion commands, refuses redirects, bounds the request to five seconds and response to 16 KiB, and outputs no credential/path details. Write permission always remains explicitly unverified.
- Publishing preserves companion-reported `committed`, `pushed`, `apiVerified` (`boolean|null`), evidence source, verification scope and partial-delivery state. Exit 0 requires child exit 0, exact requested asset ID and explicit push/API verification success. A push without confirmed API visibility returns nonzero with recovery evidence.
- `--surfaces none/store` is refused before child execution because the companion does not implement these options. Only API publication is supported. Invalid/option-like asset IDs are rejected.
- CLI help, the Hermes skill trigger and an onboarding/recovery guide now name OsbornSkillHub and explain that candidate registration is only a source reference, not an upload or release.

## Verification

- Focused Hub suites: 43 tests passed.
- `pnpm test`: 292 files / 2,611 tests passed; one pre-existing live/network test file/test skipped by default.
- `pnpm build`, `pnpm typecheck:check`: passed; CLI rebuilt after the final response-size guard.
- `pnpm lint`: passed with two existing warnings in unrelated files; no new warnings.
- CLI startup benchmark: version median 27 ms, help median 74 ms (local budgets 150/500 ms).
- Real built-CLI `hub doctor --json` with a fresh isolated `OSSTACK_HOME`, the actual local Hub and catalog checkouts: exit 0, `configured`, all three local prerequisites true, `api_read: reachable`, `publish_permission: unverified`. The existing owner read credential stayed in its secret file/runtime; it was not exported to an agent or repository.
- `git diff --check`: passed. Original user checkouts and their AGENTS.md edits were not modified.
- [Two actual Fable 5.1 design challenges and evaluated responses](2026-09-09-hub-publish-fable-review.md). Model suggestions are distinguished from code/runtime evidence.

## Remaining owner/runtime dependency

The actual runtime host/framework or configuration entry point for maomaobdm has been requested and is not yet known. No account/grant has been provisioned, no shared credential issued, no real catalog asset published, and no production installation updated by this PR. This is the preparatory diagnosis/integration fix, not completed onboarding. Continue with the actual principal, repository/namespace scope and a selected real test asset using the [onboarding acceptance guide](../guides/hub-agent-publishing.md).

The companion reports API version equality; this change does not establish commit/digest-level deployment attestation. A local prerequisite check does not establish tooling trust, branch-policy acceptance, storage readiness or external-agent authorization.
