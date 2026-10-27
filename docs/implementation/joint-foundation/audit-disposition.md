# Sonnet 5.5 review disposition

Round 1: `REVISE`; raw report, JSON model metadata, exact input and input hashes are preserved in `evidence/sonnet-round1.*`. The requested and returned canonical model was `claude-sonnet-5-5`. Claude ran tool-less. Host verification and independent Python vectors supplement the model review.

| Finding | Disposition and evidence |
|---|---|
| 1 REPLACE bypass | Accepted. BEFORE INSERT guards protect all immutable tables independently of recursive_triggers. Tests cover INSERT OR REPLACE, REPLACE and UPSERT. |
| 2 unbound ledger/weak types | Accepted. STRICT tables, safe integers, bounded JSON, null-safe field equality, canonical subject binding and home-only ledger. Receipt owner generation is positive. Host still authenticates proof and re-parses stored raw JSON. |
| 3 revision/terminal chain | Accepted. Recovery starts at 0, advances without gaps, permits repeated preserve_unknown only; terminal decisions seal the chain. Upgrade state/revision/owner/spec transitions enforced in SQL. |
| 4 digest domains/root ID | Accepted. Added registered request/consumption domains and typed constructors, exact trial-root derivation/regex, six independent Python reference vectors. |
| 5 flowing ID bounds | Accepted. Request/subject effect ID limits align with receipt at 256. Negative tests reject larger values before any mutation. |
| 6 proof linkage | Accepted. Proof record_ref links to the unique reference set; preserve_unknown has no proofs; a resolving decision requires one exact proof type. |
| 7 test claims | Accepted. Raw manifest decoder, future SQL digest, full sqlite_master before/after, upgrade tests, broker containment positive/identity mutations, receipt round trip, exact vector counts and correct sqlite_ prefix filtering. |
| 8 oracle chronology | Accepted. Frozen state has immutable custody ref and no future candidate; executed state adds candidate/profile and temporal checks. |
| 9 source path hazards | Partly accepted. Reject .git, NFC/case collisions, prefixes, symlinks/gitlinks. Helper normalizes UTF-8 file ordering instead of rejecting different declaration order. This is a digest manifest; J02 must still prove secure source materialization. |
| 10 complete lineage | Accepted. MigrationSpec includes raw SHA256 of complete source/target sqlite_master catalogs. Python independently recomputes these and schema-spec digest. |
| 11 digest/decode | Partly accepted. Constructors and registry drift test added. Binding self digest verification is explicitly a host admission step, documented alongside decoder. Sorting schema table names already appears in the supplied original digest-catalog; that part of the finding is not a defect. |
| 12 semantic shapes | Partly accepted. Containment profile consistency; required reviewer-owned independent review; registry ref equals unique command byte digest; pass=[0]; Ref rejects edge whitespace/controls. Principal alias authentication cannot be proved by a string charset and remains host registry work. |
| 13 future templates | Accepted. Permanent forward-only consumption, hex checks, typed composite object foreign keys, scope/tenant columns. content_ref is explicitly an opaque registry key, not a worker path. |
| 14 smaller items | Accepted where applicable. Package generation/check scripts, orphan-schema test, incremental encoding byte budget, fatal UTF-8 bytes entry, byte-bounded material text, raw Buffer digest checks, -text attributes, no redundant index and Python reference vectors. |

J12/J17 obligations in the raw report remain required and are listed in the recovery specification. This batch does not claim actual crash recovery, live writer fencing, broker recovery or provider qualification. Later source changes invalidate this frozen migration candidate and require regeneration.

## Follow-up reviews

Round 2 returned only its final continuation: the report begins mid-sentence and omits the numbered conditions. Its raw JSON and input are retained, but its conditional approval was **not** accepted as a complete review. The identifiable conditions led to stricter JSON scalar types, independently executable Python checks with no reverse PR dependency, and additional negative tests.

Round 3 returned a complete REVISE report. It found no blocking legacy/broker identity or SQL logic defect, but required behavioural probes for SQL field equality/home restrictions and Zod identity rules. It also found that Python `assert` could be stripped by optimization. These were fixed with explicit failure checks, an optimized-Python corrupt-vector test, typed SQL mismatch probes, thirteen compiled constraint-deletion mutants that admit the forbidden input, OR IGNORE/DO NOTHING rejection tests, and the requested effect/attention/broker negative cases. The vacuous changed-hash mutation assertion was removed. A final focused review checks these remaining conditions.

Round 4 returned a complete **PASS** for the remaining conditions. It is a static review, not an execution claim. Host cross-check found its statement that every future table already covered OR IGNORE/DO NOTHING was too broad; these extra conflict variants were added afterward and the SQL suite rerun. Product code remained unchanged. There are no unaddressed confirmed blockers in this batch.
