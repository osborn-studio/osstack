# Live provider pilot: Fable 5.1 challenge

Two actual tool-less `claude-fable-5-1` invocations completed with `is_error=false` and that model in `modelUsage`. CLI also reports auxiliary Haiku usage; it is not the requested reviewer. Safe mode, slash commands/tools disabled, empty MCP, temporary working directory, no persisted session. Only newly written generic design text was supplied, without private repository/configuration exports.

## Decisions

- Adopt: native Codex thread receipt and positive completion output-token usage; exact-byte gate before review and after reconstruction; one invocation per role; reject binary overrides; report failures and unknown identity/cost without invented values.
- Adopt: count all calls through the delivery transport in addition to adapter invocations and assert no increments on replay. This instruments production entry boundaries, not all host network traffic or child process spawns; no egress-containment claim.
- Adopt: `github_pr_created:false`; public summary omits simulated PR URL. Kimi tool-free profile is enforced by the adapter; no tool activity was observed. This does not attest that the CLI could not perform silent side effects.
- Decline duration floor: latency is not evidence of authenticity. Local CLI trust and reported evidence are explicit assumptions.
- Keep pipeline success dependent on approved review: this pilot verifies the approved-candidate-to-delivery path. A valid rejection would be retained as a delivery failure with structured review evidence, not retried until approval. Transport observations are separate from the overall outcome. The two manual experiments both passed; they are distinct revised smoke definitions, not statistical replicates.
- Track Codex model-binding gap: its profile reports unknown/inferred provider/model. Kimi CLI-reported model identity is not an independent provider response. Actual provider model IDs, Kimi usage, response IDs and dollar cost remain unknown. These results cannot qualify an identity-dependent authorization or improvement claim.

## Round 1 prompt

Challenge a generic live-provider pilot design, no repository content supplied. A CLI candidate-to-draft-PR pipeline already has tests with fake models and simulated GitHub. New explicit opt-in smoke creates a completely synthetic temporary Git repository with one documentation file, fixed exact-path task, deterministic content gate and private disposable control DB. It invokes actual supported Codex CLI Builder once and actual tool-free Kimi Evaluator once through production adapters, discovers runtime identities using production profile routing, captures evidence, verifies patch reconstruction, and replays the same execution to prove zero repeat model calls. GitHub API and push are intercepted by a local bare Git plus strict simulated transport; never claim an actual GitHub PR was produced by the pilot. No private existing repository content is sent to models. One invocation per role, max 120 seconds per stage, no automatic retry; cost reported only when available, not a hard dollar-cap claim. Artifacts and failure denominator retained; cancelled/unknown states cannot become success. Does this expose real adapter defects usefully? What assertions/evidence prevent misleading success? Keep response under 600 words, distinguish reasoned risks from verified facts. Actual model co-design reviewer is Claude Fable 5.1; Kimi is a product-supported evaluator, not a substitute for this review.

## Round 1 raw response

**Scope note.** No repository content was supplied, so nothing below is verified. Every point is a reasoned risk or a recommended assertion, not an observed fact about the implementation. "Verified" would require running the pilot and inspecting artifacts.

## Does it expose real adapter defects usefully?

Yes, for a specific class: request shaping, auth/profile resolution, response parsing, streaming/termination handling, identity discovery, evidence capture, and replay-cache keying against *actual* provider behavior. Fake models cannot catch schema drift, unexpected finish reasons, tool-call fields appearing on a "tool-free" evaluator, or timeout/partial-output edge cases. One live call per role is the minimum that surfaces these.

It does **not** expose: prompt quality, multi-turn behavior, concurrency, rate-limit handling, retry logic (explicitly disabled), or GitHub transport defects (intercepted). Say this plainly in the report so nobody reads "smoke passed" as "pipeline validated."

## Assertions that prevent misleading success

1. **Prove the live call actually happened.** Assert a provider-issued response ID / request ID, non-zero token usage, and a wall-clock duration above a floor. Without this, a misconfigured adapter that silently falls back to a cached or fake path passes. This is the single most important guard.

2. **Prove identity came from routing, not a hardcode.** Assert the resolved model identity string originates from the production profile path and record which profile/rule matched. Store both the *requested* and *provider-reported* model name; flag mismatches.

3. **Prove the Kimi call was tool-free.** Assert the request payload contained no tool definitions and the response contained no tool-call blocks. A "tool-free evaluator" that receives tools is an adapter defect the fake tests would never see.

4. **Content gate must be checked against the reconstructed patch, not the model's claim.** Apply the patch to a fresh clone of the synthetic repo, assert the resulting file matches the deterministic expectation byte-for-byte, and assert only the fixed exact path changed.

5. **Replay proves zero calls by counting, not by absence of errors.** Instrument the adapter with a call counter and network-level interception (e.g., fail-fast on any outbound HTTP during replay). "No new evidence appeared" is weaker than "outbound socket was blocked and nothing tried."

6. **Isolation must be asserted, not assumed.** Diff every model-bound payload against the synthetic repo's file set; assert no bytes outside it. Assert the control DB path is under the temp root and is removed/quarantined afterward.

7. **Terminal-state gating.** Enumerate allowed success states explicitly; `cancelled`, `timeout`, `unknown`, and `partial` map to failure. Assert the failure denominator equals attempts, not successes.

8. **PR claim guard.** The final report should carry an explicit `github_pr_created: false, transport: simulated` field. Never emit a PR URL.

## Reasoned risks

- **Silent fallback** (risk 1 above) is the most likely way this pilot lies. Fake-model infrastructure already exists; one env-var bug routes live calls there.
- **120s ceilings without retry** are correct for honesty but will produce flaky failures under provider load. Report timeout as a *distinct* failure class so it isn't conflated with adapter bugs.
- **Nondeterministic Builder output** may fail the content gate even when the adapter is healthy. Separate "adapter transported correctly" from "model met the gate" — a gate failure with valid evidence is still informative.
- **Cost reporting** conditional on availability is fine; assert it's absent-vs-zero distinguishable.
- **One invocation** means zero statistical power. This is a smoke, not a benchmark. Label accordingly.

## Verdict

Useful, provided assertion 1 and 5 exist. Without them, the pilot can pass while never touching a real provider, which is worse than no pilot.

## Round 2 prompt

Second round. One real pilot passed through production Codex CLI and Kimi adapters in 51 seconds with one call each, deterministic gates and synthetic PR reconstruction; replay caused no calls. Codex model identity is currently unknown/inferred; Kimi CLI reports configured identity. We will not infer actual provider model or invent response IDs. This discovers a model-binding gap tracked separately. Refined smoke requires Codex native thread ID plus positive completion output-token usage; captures Kimi structured approved review and CLI runtime identity. Kimi adapter does not expose provider response ID or token usage; record unavailable/null. Reject binary overrides, invoke installed commands; local PATH trust remains an assumption, not cryptographic provider proof. Tool-free Kimi profile enforced by adapter; smoke rejects emitted tool activity. Count adapter invocations and all simulated Git transport calls; assert zero increment on replay. Exact-byte gate runs before review and after reconstruction; source HEAD/tree unchanged. Result summaries say github_pr_created:false and omit simulated PR URL. Fresh fixture content only is deliberately supplied, but native CLI may load normal user config; no OS isolation or account-context exclusion claim. Failure artifacts retained, outcomes start/fail/pass; each manually revised experiment has new root, no automatic retry. Cost and Kimi provider IDs stay null. No duration floor: latency cannot prove authenticity. Any blocker invalidating this scoped transport pilot? Under 450 words; separate reasoning from reported evidence. No private source/config supplied.

## Round 2 raw response

## Reported evidence (as stated by you; I have no tools or repository access and have not verified any of it)

- One pilot, production Codex CLI and Kimi adapters, 51 s, one call each; replay produced zero calls.
- Codex: native thread ID captured, positive completion output-token usage required; model identity unknown/inferred, not asserted.
- Kimi: structured approved review and CLI-configured runtime identity captured; provider response ID and token usage unavailable, recorded null; tool-free profile enforced, emitted tool activity rejected.
- Installed commands invoked, binary overrides rejected; PATH trust acknowledged as an assumption.
- Adapter invocations and all simulated Git transport calls counted; zero increment asserted on replay.
- Exact-byte gate before review and after reconstruction; source HEAD/tree unchanged.
- Summaries: `github_pr_created:false`, no simulated PR URL.
- Fresh fixture content only; native CLIs may load user config; no isolation claim.
- Failure artifacts retained; start/fail/pass outcomes; each manual revision gets a new root; no automatic retry. Cost null. No duration floor.

## Reasoning

**Blocker test:** a blocker exists only if the pilot's claims exceed what its checks can support, or if a check can pass without the claimed event occurring.

1. **Transport occurred.** Codex thread ID plus positive output tokens is a reasonable local-binary attestation; Kimi's structured review plus null provenance is weaker but honestly labeled. Both rest on PATH trust, which you scope as an assumption. Consistent with a *transport* pilot; not consistent with any "provider proof" claim, which you don't make.

2. **Replay isolation.** Zero-increment counters are sound only if instrumented at the actual egress boundary (process spawn / network), not at adapter method level where a bypass path could go uncounted. Verify the counter sits at the outermost boundary. This is a design check, not a known defect.

3. **Kimi tool-free enforcement.** Rejecting *emitted* tool activity cannot detect silent tool use inside the CLI. Acceptable as long as the claim is "no tool activity observed," not "no tools executed."

4. **Approval as pass criterion.** Requiring an *approved* review couples smoke success to reviewer verdict, which can bias toward passing configurations. Prefer: require a valid structured verdict; record approved/rejected separately.

5. **Byte gate ordering.** Pre-review and post-reconstruction gates against the same original digest bracket both mutation windows. Sufficient.

6. **Config leakage and identity.** Model-binding gap and user-config loading are correctly disclosed and excluded from claims; tracked separately. n=1 supports a smoke, not a reliability statement.

## Verdict

No blocker invalidates the pilot **as scoped**: it demonstrates that the two adapters completed one real round-trip each, that replay made no calls, and that no source or remote state changed. It does not demonstrate provider identity, model identity, or sandbox isolation, and your summaries already refrain from those claims.

Non-blocking follow-ups before widening scope: confirm counters at process/network egress; decouple pass criterion from review verdict; label Kimi tool-free as "none observed"; keep model-binding gap tracked before any identity-dependent claim.

