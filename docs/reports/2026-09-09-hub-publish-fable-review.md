# Hub publishing: Fable design challenge, 2026-09-09

Two actual tool-less Claude Fable 5.1 calls; both returned `is_error: false` with `claude-fable-5-1` in `modelUsage`. Auxiliary Haiku usage was reported separately. Safe mode, disabled tools/slash commands, empty MCP configuration, temporary working directory and no session persistence. Inputs were newly written generic design text; no repository code, secret, configuration or audit exports were sent. This is design critique, not an independent source-code audit.

## Decisions checked against the local implementation

- Accepted: diagnostics is not provisioning; actual runtime/principal binding remains pending user input. API read credentials do not establish Git publishing rights. The guide specifies the concrete identity/grant information needed and does not claim a per-agent worker exists.
- Accepted: strict booleans, nonzero child exits, exact caller asset-ID match, partial-state reporting, explicit evidence source/version-check scope, unsupported-surface rejection, fixed origin, redirect refusal, bounded request/body and credential-safe output. Covered by focused tests.
- Rejected: default `git push --dry-run` in a read-only doctor. It can invoke hooks and does not prove server-side policy acceptance.
- Corrected: there is no evidence file being reused; the wrapper consumes the fresh child process stdout. The companion already owns its publish lock. A file-nonce protocol or duplicate wrapper lock would require a companion contract change, not fix a demonstrated stale-file bug here.
- Corrected: companion polling checks equality to the locally expected asset version, not just "version changed". Content/commit/digest binding remains a limitation, explicitly disclosed; no stronger attestation is claimed by this patch.
- Rejected: rejecting all unknown JSON fields would break the existing extensible companion contract. Known fields are explicitly type-checked; output uses an allowlist. Duplicate-key parser hardening and a versioned strict companion envelope can be addressed jointly upstream.
- Retained existing CLI exit convention (0/1/2), with stable reasons and partial evidence rather than introducing an incompatible exit-code family. Doctor prerequisite presence is not script trust/version attestation.
- Read bearer remains needed by the trusted companion for online verification. It is never issued to an unbound external agent by this change.

## Round 1

Prompt:

Challenge this generic CLI integration design. Tools are disabled. A user asks to authorize a named external agent to upload to a private skill hub. The inspected architecture is a local publisher that promotes an existing catalog entry, commits and pushes a separate catalog Git repository, then verifies the deployed read-only API. A display name is not an authenticated identity. We will not grant a shared administrator key on that basis. Proposed first fix: a read-only doctor reports local companion scripts and catalog presence, fixed-origin authenticated GET health, and publish permission explicitly unverified. Health credentials never imply write privileges. Redirects are refused, requests time out, errors never echo secrets. Publish wrapper respects child exit status, reports committed/pushed/apiVerified booleans (missing as unknown), only accepts the supported API surface instead of silently ignoring other requested surfaces. Success claims must distinguish local changes from deployed verification; unknown legacy results are not verified uploads. Documentation gives agents the existing GitOps route and identifies the missing host/framework identity before scoped onboarding. Challenge implementation-changing gaps, especially why this does not itself provision the external agent. Keep response under 650 words.

Response (untrusted model critique; evaluated above):

## Verdict

The design is a correct refusal and a reasonable hardening pass, but it is not a fix for the request. It ships observability and safety around the existing publisher while leaving the user's actual ask—authorize a named external agent—entirely undone. The gap is defensible; the way it is deferred is not.

## Why this does not provision the agent, and why that is only half-justified

The refusal rests on one fact: the hub has no per-principal identity. Only a shared admin key exists, and a display name cannot be bound to it. Correct. But "identify the missing host/framework identity" is a documentation task, not a design decision. The design should state what the identity *must* be before onboarding is possible: issuer, subject, audience, and scope shape (publish on which catalog namespaces). Without that, the next request will restart from zero.

More importantly, the GitOps route is itself a provisioning path that does not require the admin key. A deploy key or PR-only credential on the catalog repository, plus branch protection and a CI job that runs the existing publisher, gives a named principal scoped write access with an audit trail. The design mentions this route and then only documents it. If the objection is that a GitHub/Git host identity is still a display name, say so explicitly; otherwise the design is withholding a workable scoped onboarding for no stated reason.

## Implementation-changing gaps

1. **"Publish permission unverified" is a cop-out.** `git push --dry-run` against the catalog remote verifies write access with no side effects. The doctor should run it and report `pushAllowed: true/false/unknown` rather than declaring the question unanswerable.

2. **`apiVerified` is undefined.** Verifying what—entry present, version matches, content hash matches? The read-only API is deployed asynchronously after push, so a single GET produces false negatives. Specify: poll with bounded retries, compare the pushed commit's entry hash, and distinguish `notYetVisible` from `mismatch` from `unreachable`. "Verified" must mean the deployed artifact equals what was pushed.

3. **Partial-state handling is absent.** `committed=true, pushed=false` leaves the local catalog repo ahead of origin. The wrapper must report that state, must not auto-retry the commit, and must be idempotent on rerun (detect existing commit, retry push only). Also treat signal-killed children as failure, not unknown.

4. **"Fixed-origin" needs a source.** If the origin comes from config, config tampering redirects credentials. Pin it in code or in a checked-in, integrity-verified manifest, and require TLS verification explicitly—most HTTP clients follow redirects and skip nothing by default, so "refused" and "verified" must be explicit client settings, not assumptions.

5. **Companion script presence is the wrong check.** A present but stale script is worse than a missing one. Report version or content hash against an expected value.

6. **Secret hygiene is stated only for errors.** Verbose/debug output, doctor reports, and structured JSON must also never include token values—only `credentialPresent: true`. The doctor output must be safe to hand to the very external agent that requested access.

7. **Three-state booleans need a schema.** `committed/pushed/apiVerified` as `true|false|null` with a `source: wrapper|legacy` field so consumers cannot mistake a legacy unknown for a wrapper true.

8. **Surface rejection must fail loudly.** Unsupported surface requests exit non-zero and list the supported set. Silent rejection is the same bug as silent acceptance.

## Required before this is accepted

- Add `git push --dry-run` to the doctor.
- Define `apiVerified` as hash equality with bounded polling.
- Specify partial-state reporting and idempotent rerun.
- Pin origin outside mutable config; make TLS and redirect behavior explicit.
- Produce a concrete identity requirement (issuer/subject/audience/scope) and either implement the deploy-key-plus-CI onboarding or state precisely why a Git host identity is insufficient.

Until the last item is resolved, the honest status of the user's request is "declined pending identity," not "fixed."

## Round 2

Prompt:

Second adversarial round on a generic CLI integration. We accept your distinction: diagnostics is preparatory, external-agent provisioning remains pending its actual runtime host and authenticated principal, which we have explicitly asked the user for. For GitOps onboarding require the actual GitHub App installation/repository grant or dedicated machine principal with explicit owner-approved catalog scope; a supplied display name is never a grant. Do not conflate the API read bearer with Git push credentials. We reject adding default git push --dry-run: it may execute pre-push hooks and cannot guarantee branch protection acceptance; doctor stays filesystem checks and fixed-origin GET with redirect:error and bounded timeout, and reports write permissions unverified. Script presence is only prerequisites, never trust/authorization. Wrapper success now requires child exit zero, matching asset id, pushed===true and apiVerified===true. Incomplete or legacy evidence returns nonzero, preserves committed/pushed/apiVerified as boolean|null, evidence_source=hub_companion, and verification_scope=companion_api_version_check. We explicitly do NOT claim content-hash equality: existing companion polls for API version, and strengthening upstream artifact proof is a separate change. The wrapper never retries or creates commits itself. Unsupported surfaces fail before child execution. No external account, upload, publication or host provisioning has happened. What remaining concrete defects should block this bounded fix? Limit to 350 words. Do not assume unmentioned identity or auth implementations exist.

Response (untrusted model critique; evaluated above):

**Remaining blocking defects (bounded scope):**

1. **Stale/replayed evidence.** Wrapper reads companion evidence but nothing binds it to this invocation. Require a per-run nonce/run-id supplied to the child and echoed in evidence, evidence path created fresh (O_EXCL, no symlink follow) and removed before child start. Otherwise a prior run's `pushed:true, apiVerified:true` satisfies the gate.

2. **Asset id comparison source.** "Matching asset id" must compare a caller-supplied expected id against evidence, exact byte equality, no normalization. If expected id is derived from the same evidence or child stdout, the check is tautological. Reject ids beginning with `-` before building child argv.

3. **Type coercion.** `boolean|null` preservation requires strict JSON type checks: `"true"`, `1`, missing key, and duplicate keys must all yield `null`, never `true`. Validate against a fixed schema; unknown top-level keys → treat evidence as incomplete.

4. **Partial-remote-state reporting.** Child exit nonzero with `pushed:true` must still exit nonzero *and* surface that a remote branch/commit exists. Silent nonzero hides the side effect the operator must clean up.

5. **apiVerified semantics.** Companion polling "version changed" is satisfiable by a concurrent unrelated publish. Within scope: require evidence to include the observed version and expected predecessor, and emit `verification_scope` in machine output every time, not only on failure. Defer hash proof as agreed, but don't let a race read as success.

6. **Exit-code and schema stability.** Distinct nonzero codes for unsupported-surface (pre-child), child-failure, evidence-missing, evidence-contradictory; output includes a schema version. Otherwise callers cannot distinguish "never ran" from "ran and pushed."

7. **Doctor hardening gaps.** Bounded timeout must cover connect+read; cap response body size; TLS verification non-optional; classify 3xx (blocked), 4xx, 5xx, network error separately; `write_permissions: "unverified"` must be an explicit field, not absent. Ensure bearer is never forwarded into child env or logged.

8. **Allowlist, not denylist.** "Unsupported surfaces fail" must be an exhaustive allowlist check on surface + argv shape.

9. **Prerequisite check pinning.** Script presence checked at a fixed path, not PATH lookup; never executed.

10. **Concurrency.** Two wrappers in one working tree can interleave evidence; take a per-tree lock or fail fast.

