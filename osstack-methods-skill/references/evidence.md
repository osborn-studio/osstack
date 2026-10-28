# Common evidence and result record

Keep product behavior, harness operation, coverage and cleanup as separate observations. An exit code alone does not establish the requested behavior. Source inspection, unit tests, a live local fixture and a real provider run answer different questions.

## Before driving

Record the requested outcome and its observable predicate, repository and candidate commit, dirty tracked/untracked changes if relevant, selected feature, exact command and working directory, build identity and fixture/environment. Do not claim a source commit identifies generated binaries unless their build is tied to it. Bound time and output. Choose an evidence destination outside disposable application state, under the configured scratch root for local development runs.

Use an isolated `OSSTACK_HOME`, socket and fixture. Never run a development CLI against the default control-plane home. Establish ownership before cleanup; do not kill by process name or sweep unrelated directories. Do not collect credentials or raw sensitive application data just to make evidence more complete. Record redaction and its effect on what can be concluded.

## Reading existing evidence

Read the input index, manifest and summary first, then inspect the specific fields or raw log sections needed for the claim. Avoid dumping large result files or thousands of build bindings into context. Keep the original file path and hash with any selected projection; a summary or projection does not establish that omitted content was verified. Expand the read when the claim requires it, and state the remaining coverage.

Before saying evidence was not provided, check the supplied input inventory and the explicit referenced path. Distinguish **not provided**, **provided but unread**, **read but not verified**, and **verified for a stated predicate**. A failed read is an access/read failure, not proof that the file was absent. Record the attempted path and failure; do not turn an unread manifest into a missing-manifest claim or treat reading it as verification of its bindings.

## Outcome vocabulary

| Axis | Values | Meaning |
| --- | --- | --- |
| Execution | not_run / blocked / ran | Missing build or prerequisite is blocked, not an executed product failure |
| Behavior | passed / failed / unknown / not_observed | Passed requires the declared predicate on the correct surface; a timeout can leave behavior unknown |
| Harness | healthy / failed / unknown | Tool failure does not by itself prove a product defect |
| Cleanup | confirmed / failed / unknown / not_started | Confirm exit and owned resource disposition; a stop request is not proof of termination |
| Coverage | covered / partial / blocked / not_run | Enumerate missing features and prerequisites; a successful subset is not full coverage |

These are reporting terms, not a new runtime schema or gate state. Keep the script's original output unchanged and attach this interpretation separately. A successful feature followed by failed cleanup remains a successful feature observation with failed run closeout; do not erase either fact or call the entire run clean.

## Record template

```text
Task and requested predicate:
Repository / source commit / dirty changes / generated build identity:
Method files and version or hashes:
Feature / actual surface / external boundaries replaced by fixtures:
Command argv / cwd / relevant non-secret environment:
Start and end time / timeout / exit code or signal:
Execution / behavior / harness / cleanup / coverage:
Action trace and resulting state:
Baseline evidence / candidate evidence / difference:
Evidence paths and hashes / redactions:
Input evidence inventory / explicit paths / read status / verified predicates:
Owned resource identifiers / stop observation / retained resources:
Missing prerequisites / unverified cells / next bounded step:
```

Capture command, action and resulting state, not only a final success sentence. Preserve failed attempts and superseded interpretations. After teardown, read the named evidence files again and verify they survived. If evidence cannot be recovered, say what was lost rather than recreating it from memory. Restrict access to retained scratch data; retention is not authorization to publish it.

A same-author reproduction is useful engineering evidence but is not an authenticated independent principal or pre-frozen oracle. Never relabel it as such. Do not convert `observed_turn` into task `local_verified`, provider qualification, release approval or joint gate completion.
