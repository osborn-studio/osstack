# Local App C/D API-read capability sample

Date2026-11-07. These are local installation-token observations on the existing
public sandbox, not cloud Routine acceptance. The probe used the existing
createInstallationTokenSource with ADR-006 App/install registrations and existing
owner-only key files. Private keys/tokens remained in memory, were not output,
committed or sent to cloud; no raw responses, authentication headers or error
bodies are part of this handoff. No App, permission, repository, review, check,
Routine or Bot setting changed.

| Role | App / installation | Requested minimum | Observed |
|---|---|---|---|
| C |5620065 /178742326|checks write, contents read, metadata read|mint201;5 GET200|
| D |5620078 /178742542|pull_requests write, metadata read|mint201;5 GET200|

Both tokens' mint repository list and GET installation/repositories contained
exactly one repository: osborn-studio/osstack-bridge-sandbox, id1446327922.
The bounded first page was short with total_count1. Both read sandbox metadata,
existing PR13, head check suites and the App B suite's check runs. PR head
3ee145c2d54c1c1e436c8185cf08f2192447386f had App B5620053 suite113737072833 and
run127067598778 on the same head, completed/success. Read counts, numeric IDs and
scope matches are whitelisted observations, not arbitrary remote content.

D initially requested additional contents read and received422. Retrying with the
strictly smaller ADR-registered set succeeded. Because no error body was retained,
this records the rejected larger request and successful smaller request without
asserting a server explanation. **Do not require contents read for D.**

A separate bounded main-only token request used the same existing installations
and minimum permissions: D422 (rejected scope, main access not established); C
captured no HTTP response status and produced no usable token (cause unknown,
not a proven scope rejection). Neither proceeded to main GETs, and neither
failed request was retried. Main repository1255570742 access remains unverified;
these observations do not prove whether an App is installed there.

Sandbox sampling performed3 auth POSTs and10 GETs; main scope sampling attempted
2 auth POSTs and0 GETs. Business writes were zero. These results demonstrate local
authenticated reads of the public sandbox PR and another App's checks. Public
HTTP200 does not prove private-repository access, future writes or cloud binding.
U-3 still needs cloud-context execution, commit-to-PR and complete bounded reading
evidence; U-1/U-9/U-10 remain unknown. No acceptance gate or paused draft was enabled.

The shared personal-account ordinary PR flow remains separate. Mission-only
coexistence exclusions need owner confirmation and applied-config readback;
gilosbornhello's mandatory counted approval cannot be replaced by App D approve.

## Evidence binding

Only safe content hashes are included; raw private probe artifacts remain local.

- local-app-cd-read-capability-summary.json SHA256 `1e496c24c348dc7404c12dde87d3073d97636e19af87559d29ca0613c77d9139`.

- local-app-cd-main-scope.json SHA256 `8fb885b7bf2c402ddddf79e977d3b0c11571f325652020f16cd7cdb216374e2f`.

Sandbox sample times: 2026-11-07T16:36:00.751Z, 2026-11-07T16:36:27.658Z. Main sample time: 2026-11-07T16:41:07.628Z.
