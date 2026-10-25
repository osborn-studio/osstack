# R4 audit disposition

Snapshot: 395ca614d2e3616e6d5c42e1371b5ab5a1182e74 (plus 42b83a62/fbc3ce44/83f7d35b). Parent-owned migration42 c1d77b7d is locally 0a7b2ba6; parent must not cherry-pick local duplicate.

Claude Code CLI --model claude-haiku-5-5, tool-less static review, hooks/plugins/MCP disabled, no session persistence; JSON reports modelUsage canonicalModel claude-haiku-5-5. CLI emits unrecognized_model warning. Model identity here is request/response metadata, not independent provider certification. No auditor test execution; local Node22 Vitest gives test evidence.

## Round1

| Finding | Disposition |
| --- | --- |
| P1 prefix removal/mutation not checked by last anchor | Reproduced limitation; owner changed contract to complete=false, caught_up only visible watermark; explicit unverified retention/prefix integrity. Prefix delete/mutate regressions. |
| P1 task deletion/tenant/identity invalidates scope but stale run facts survive | Fixed: all scope subjects rewritten unknown, cursors sticky quarantined. Three actual DB mutations tested. |
| Conditional P1 identical run-ID reuse survives | Prerequisite false: migration1 foreign key cascades events, openDb enables foreign keys. Same-identity delete/reinsert test detects missing anchor. Byte-identical recreated history remains indistinguishable; no immutable-incarnation qualification claimed. |
| P1 session-bearing runs excluded | Fixed separate session and run admission/discovery, shared cap100; test confirms two subjects. |
| Pre-existing P1 authority resolution cross-run/terminal overwrite | Fixed exact run+pending CAS with same-terminal-status/choice-or-answer echo exception (no authority timestamp rewrite), status enum validated; two-family tests verify cross-run and conflicting echo rollback. |
| P2 payload lookahead | Fixed separate SELECT1; per-page200*64KiB, aggregate performance remains future. |
| P2 swallowed stale owner | Rethrow; update reasserts owner inside existing owner-fenced transaction. |
| P2 missing-run path before scope check | Scope identity checked first. |
| P2 corrupt facts with gap | Fixed in83f7d35b: explicit validity boolean; preserve original corrupt facts and stall across repeated ticks. |
| P2 invalid inventory JSON | Guard SQL JSON extraction and per-row parse; return degraded invalid marker. |
| P2 sticky gap/admission slots | Intentional conservative contract; explicit release/diagnosis, no automatic eviction/recovery. |
| P2 state union | Generic facts supports objects and unknown/source_missing string markers; existing schema untyped. |
| P2 status event may observe completed without terminal flag | Observation only; no execution/completion authorization and complete always false. |
| P2 null payload label | Schema payload_json NOT NULL; oversized SQL projection only. |

## Round2

Independent report: no P0, all first-round P1 closed or closed with documented residual. Three confirmed P2s fixed in83f7d35b: explicit replay markers on run failure paths; corrupted cursor with preexisting gap stops without overwriting diagnostic bytes; undiscovered query includes runs. Tests78/78.

Other P2 remarks are clarified contracts: terminal echo means authority status, not envelope terminal bit; unknown-authority resolution is intentionally rejected rather than silently accepted, header records compatibility tightening; covered is sampling coverage, not retention proof; state marker union includes unknown. Existing request ID collisions remain fail-closed at projection/resolution and are not silently treated as authority.

## Remaining limitations

No full-history retention/prefix-integrity guarantee, no immutable incarnation token, no performance/latency/soak qualification. Last anchor plus binding detects observed deletion/mutation/reuse, not byte-identical malicious recreation. At most200 rows per run and64KiB per payload, global100 admitted subjects, but aggregate scan is synchronous; RPC p95 requires separate qualification. No adapter execution or automatic authorization added. No public export or daemon/CLI wiring included; parent owns them. One conditional audit caveat about unseen store was resolved by supplying attention-store.ts for final delta review.

## Round3 and final round4

Round3:0P0/0P1. Corrupt cursor and undiscovered-run fixes closed; residual P2 capacity-rejected discovery row lacked replay marker.395ca614 adds marker on INSERT and ONCONFLICT payload update, and101-run test preserves shared admission100. Operator repair test locks intentional explicit DB repair behavior: resume reading with permanent gap, never auto-clear or claimcaught_up/complete.

Round4:0P0/0P1; capacity marker residual P2 closed, no regression identified in delta. Static reviewer explicitly did not execute tests and did not receive setup/projection again for this tiny final delta. Actual local Node22 tests80/80 cover those runtime assertions. Earlier broader rounds supplied full source. Exact finalhead build/typecheck/Biome pass. Raw JSON/context/stderr for all four rounds remain alongside this file. All runtime source changes after full round2 were separately reviewed in rounds3/4.
