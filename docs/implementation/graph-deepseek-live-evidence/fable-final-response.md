**Verdict: changes_requested** (narrow; adapter and RPC wiring are sound, the harness overclaims in two places).

**Adapter and provider (accept as-is)**

- Stop receipt handling is correct in every path I traced. Pre-dispatch failures and generator early-return yield a `no-request-dispatched` receipt. Transport abort, timeout, non-JSON body, oversize body, model mismatch, and schema rejection all leave `stopped:false`. A complete provider message followed by cancel, parse failure, or write-authority denial correctly yields `stopped:true` with both digests, since inference did finish. Documented 4xx rejections bind `http-<status>` plus both digests.
- `finish_reason` handling matches the current DeepSeek enum. Non-`stop` reasons are stopped failures with retained usage, which is the right accounting for a paid but unusable completion. `tool_calls:null` accepted, non-empty rejected, `index` must be 0, exactly one choice.
- Base URL validation now rejects bare `?`/`#`, userinfo, non-https except loopback http, and control characters. Anthropic still refuses any base URL.
- Token accounting comment is correct: DeepSeek `prompt_tokens` already includes cache hits and `completion_tokens` includes reasoning tokens.
- One cosmetic issue: `rejected()` calls `JSON.parse` on the raw body before `safeParse`, so a non-JSON 4xx body surfaces as `BOUNDED_INTERNAL` rather than `BOUNDED_HTTP_ERROR`. The receipt stays unknown either way, so this is a diagnostic label problem only.

**RPC wiring (accept)**

`loadLocalGraphRegistration` derives the credential name from the provider, forces the writer and reviewer identities to match the provider prefix, and spreads `baseUrl` through so the anthropic profile rejects it at load. The candidate path the harness reads matches the driver's `writer-<epoch>` workspace under the service root, and acceptance commands run through a shell (existing tests use `$(...)`), so the single-quoted `node -e` form is fine.

**Harness: assertion honesty (change requested)**

1. **Cancellation check overclaims.** The third check is named "no freeze or forced release of unknown inference", but the only assertions are that the final status is one of `cancel_pending`, `cancelled`, or `reconciliation_required` and that no freeze row exists. Accepting `cancelled` alongside the other two means the harness cannot detect a forced release. It records the action rows but never inspects the implement outcome. Tighten it: read the `e0.implement` outcome and assert that if it is not confirmed-stopped, the run status is not `cancelled`. Conversely, if the writer's response landed before the abort and the outcome is confirmed, `cancelled` is legitimate and the freeze-count assertion becomes a race rather than a property. Branch on the outcome instead of accepting all three statuses unconditionally.

2. **First check name lists nodes it never asserts.** "writer/freeze/reviewer/acceptance/join ready" is inferred from `status === 'ready'` alone. The `actions` rows are captured but not checked. Either assert confirmed outcomes for `e0.freeze`, the review node, the acceptance node, and the join, or shorten the check name to what is actually proved.

3. **Ready timeout is shorter than the work it waits for.** The ready wait uses the default of 180 seconds. The writer and reviewer each carry a 120 second adapter timeout and run sequentially, with acceptance in between, so a legitimately running paid graph can be killed mid-flight with `PILOT_TIMEOUT` and reported as a pilot failure. Raise it toward the run deadline of 600 seconds.

**Harness: minor**

- The report persists `baseUrl` straight from the environment before any validation. The redactor only strips the API key. Validate through `createBoundedProvider` first, or omit the raw value from the report.
- The negative-review assertion runs before the review payload is saved, so a wrong verdict leaves no evidence in the report. Save first, then assert.
- The cancel request uses a revision captured 200ms earlier. A concurrent projection produces a spurious `REVISION_CONFLICT`. Retry once on that error code.

Credential handling in the harness is otherwise correct: the key is never printed, daemon output and the report pass through the redactor, and the report file is mode 0600.

**Recap.** Adapter, provider profile, and RPC wiring are correct on stop receipts, finish reasons, and URL hardening, with one cosmetic error-code label. The live pilot script needs its cancellation and readiness checks to assert what their names claim, and a longer ready timeout, before its report can be cited as acceptance evidence. I did not run the pilot and make no claim about its outcome.