# Bounded method and packet consumption

This is a new read-only experiment over the six-method material at `d63dbdce7f78c2647ad41576c98b6f2df4d41aaf`, now merged as `70924ee44a478f5ef345307b885bda6b936e6662` with the same tree. It does not test the new code-review method in this delivery. Both hosts receive the same actual PR295 Linux CI packet (run40698994343, artifact12821763009, packet SHA256 `42b903f7f3393923134a51826308a8a088ab7943b51336a9ac1aee22f6f91896`) and exported methods. The machine archive is not copied into their workspace. No new product driver is run; recorded coordinator observations are interpreted.

## Outcomes and their limits

| Attempt | Observed result | Limit |
| --- | --- | --- |
| Codex CLI0.160.1, one user turn | 345-word final; correct healthy and missing-ref rows, expected negative and evidence limits; workspace unchanged | Explicit file reads, not an attested native Skill invocation. Requested `gpt-6.1-sol` came from a separate metadata directory; execution-resolved model is not attested. Overall limited. |
| Claude CLI2.1.291 initial dispatch | Zero user turns: exact catalog gate stopped before sending prompt; workspace unchanged | Historical builtin catalog had57 entries, actual59. Extra `extra-usage` and `usage-credits`; all four OSStack entries present. This was a harness preflight omission, not model interpretation or authentication failure. Original blocked record is unchanged. |
| Claude separately prepared v2 | One actual user turn; native `Skill(osstack-mode)` observed and two rows explained; 515-word result; workspace unchanged | **Fails the unchanged500-word criterion.** No retry or truncation. Native consumption does not make the complete experiment pass. |

The original fifteen criteria were frozen before outputs. The word metric remains the prior Python `len(final.split())`; thirteen boundary fixtures were checked. Codex's final was identified by an independent reading of events: preceding messages were progress notices; all three assistant messages together are410 words. No final-channel attestation is invented. Fields, raw tool reads, interpretation and attribution are assessed separately. Failed/not-run packet variants were offline controls, not additional model calls; broader state understanding remains untested.

## Preparation repair and authority

The first Claude attempt reused an old builtin catalog after the authentication environment changed. Root preserved the blocked zero-turn attempt and explicitly authorized a new preparation. In v2, a zero-user-turn initialize under the final environment/flags observed59 entries; all55 non-target Skill names were denied, the exact same-process catalog gate remained, and the independent reviewer froze new runner/case/guard paths before root dispatched the one remaining Claude model turn. Prompt, packet, materials, criteria,500-word limit and180-second active deadline stayed unchanged. Across this batch there were two actual user/model invocations total: one Codex and one Claude, plus separately recorded zero-turn metadata/preflight processes. Internal tool rounds are not counted as separate user invocations. No failed model answer was retried.

The harness never read, copied or hashed credential contents. Codex used a minimal process environment with existing CLI authentication; Claude inherited its authentication environment without enumerating values because the minimal environment did not retain login. CLI-owned internal authentication is not an isolated credential home. Both restrictions and observed compliance are recorded; Codex read-only sandbox is not a read-path fence, and neither workspace location nor prompt rules prove OS containment. Global host state and descendant termination are not attested. Owned temporary directories were removed; workspace retirement is recorded separately after evidence preservation.

## Evidence and next step

Original and revised preflight records, root guards, raw streams, complete inventories, source bindings, independent criteria/grades and failure records are retained in the [batch evidence archive](../method-code-review/evidence/manifest.json). The earlier Claude507-word and Codex recorded-environment-field failures remain unchanged; this experiment does not repair them retroactively. No J01/J11, provider, independent-principal or autonomous execution qualification is claimed.

The useful follow-up is actual code-review behavior on pinned positive/negative source changes, with a new task-specific protocol and output format; this packet task establishes neither causal productivity benefit nor general review quality. A shorter response target may be tested prospectively, but cannot relax the current failed500-word criterion.
