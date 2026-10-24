# Worker state views audit disposition

Branch codex/firstmate-worker-view, base16f37b07. This slice owns only service, CLI handler, tests and guide. Root integrates daemon/bin lazy registrations; end-to-end daemon qualification and full repository suite belong to that integration. No Graph, rawtext/logtail, control, remotehome or tenant-selection qualification is claimed.

## Independent CLI audit provenance

Invoked Claude Code CLI with requested model claude-haiku-5-5; tools empty, slash commands disabled, settings sources empty, strict empty MCP config, no session persistence, existing audited settings disable hooks. Raw result/stderr/context retained for each round. CLI emits unrecognized_model warning while result modelUsage reports requested claude-haiku-5-5; that is invocation/report provenance, not independent certification of server backend identity. No auditor tool access, code execution, provider invocation or permission-changing audit action.

## Round1

No confirmed P0/P1; six P2, all addressed:

- W-01: bound source identity JSON escaped bytes to1200 before encryption/base64, same schema in token and rows; control-character regression. Oversized/corrupt identities return source_unavailable; no partial successful page.
- W-02: successor cursors retain first page issued time, so whole chain expires after15minutes. Each newly issued view gets its own15minute TTL. Chain-expiry regression verifies it.
- W-03: terminal views use wait_reason none, while separate uncertain_delivery_recorded preserves historical unresolved receipt evidence. For nonterminal views delivery remains conservatively unknown; not claiming historical receipts became delivered.
- W-04: NULL run outcome now outcome_pending, never proof of running/liveness.
- W-05: decision_payload_present is presence-only, not decision validity or completion.
- W-06: plain paths escape all Unicode Cf plus C1/lineformatting; C0/ESC already escaped by JSON quoting; adversarial CLI regression.

Conditional questions verified against actual repo source (included in round2 context): migration21 Session has no tenant column; onlylater Session alteration is repo_path22. Tasks/runs tenantNULL both checked. Session/run IDs are PK; session_turns(session_id,ordinal) is UNIQUE. Session and turn states have exact CHECK, Sessionversion>0. daemon writer stores Date.now()/1000. Corrupt unsupported data deliberately fails source_unavailable, not healthyzero.

## Accepted limits

Views count Session and boundrun source projections, not physicalworkers. Canonical storedpaths only; alias/legacy rows excluded. Runs without consistent Session binding excluded_not_bound. Local daemon socket supplies existing transport trust; no new authority. Perpage transactional snapshot, not frozen scan across pages. No production p95 qualification. No protocol index/generated schema or default userDB changes.

## Round2 and final qualification

Round2 found actual CLI --prefix token rejection (base64url can start with --), fixed by excluding exact knownflags only, regression added. JSON/plain Unicode output now share serializeWorkerView with service bytebudget; escapes remain valid JSON and preserve parsedpath, including astral Cf. Decision label now decision_record_present and timestamps rounded. Alias visibility and absence of an index are explicit scope/performance limits already agreed with parent, not auth bypasses.

Round3 full static review returned confirmed P0=0/P1=0/P2=0. Its schema questions are verified by migration21 (session_messages/turn columns and CHECK); these are not runtime claims. After round3, parent requested dynamic CURRENT_SCHEMA_VERSION instead of max41 so integrated migration42 is accepted; this small delta was separately submitted for audit, and all final61 tests/typecheck/build passed.

Source commit d215b016968314100bc9f2ac5242b2e9f3af5d62. Includes 45 worker tests plus16 adjacentreadmodel/dashboard tests. No push/PR/worktreeremoval. Parent owns actual daemon/CLI registration and fullintegration qualification.

Round4 schema-constant-only static delta audit completed; rawresult retained. ```json
{
  "scope": "delta-only static audit; no tools; no DB open/migration; no test or suite execution claims",
  "verdict": "PASS_NO_CONFIRMED_P0_P1_P2",
  "confirmed_findings": [],
  "observations": [
    {
      "id": "OBS-1",
      "severity": "P3",
      "status": "unverified_gap",
      "area": "tests",
      "detail": "The supplied test change covers the rejection path at CURRENT_SCHEMA_VERSION+1 only. The delta does not show a test that accepts DB version exactly CURRENT_SCHEMA_VERSION, or one that rejects version 23. The lower bound 24 and the new upper bound are therefore not shown to be exercised by tests.",
      "suggested_action": "Add boundary cases: 23 -> unsupported_schema, 24 and CURRENT_SCHEMA_VERSION -> accepted, CURRENT_SCHEMA_VERSION+1 -> unsupported_schema."
    },
    {
      "id": "OBS-2",
      "severity": "P3",
      "status": "unverified",
      "area": "packaging",
      "detail": "The service now imports @osstack/core at runtime. The supplied facts do not show that the worker-view package declares @osstack/core as a dependency (or peer dependency). Resolution could depend on the workspace layout.",
      "suggested_action": "Confirm the worker-view package manifest declares @osstack/core consistently with the rest of the workspace."
    }
  ],
  "checked_no_issue": [
    "Upper bound now tracks installed core CURRENT_SCHEMA_VERSION, so DBs newer than installed code are rejected with unsupported_schema.",
    "Lower bound 24 is preserved.",
    "Import is confined to the lazily loaded service module; the CLI entry/bin/index eager path is unchanged per supplied facts.",
    "migration42 adds only a cursor table; session/run/turn/message sources are unchanged, so existing table queries remain valid for DBs at 42.",
    "Readonly constructor and missing/corrupt field handling (source_unavailable) are unchanged.",
    "RPC {ok,result,error} unwrapping to rawresult is unchanged; the delta does not alter the handler schema.",
    "Guide text matches the new range (24..installed CURRENT_SCHEMA_VERSION) and documents rawresult unwrapping."
  ],
  "confirmed_p0_p1_p2_count": 0
}
```
