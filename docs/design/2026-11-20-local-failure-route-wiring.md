# U4b W: production wiring of the local-failure route

Date: 2026-11-20. Status: approved by the owner on 2026-11-20; all nine decisions in §7 were accepted as recommended (§7.1). No code, test or migration is part of this change.

Baseline: `main` at `bb360e92`. Every `file:line` below refers to that commit. Two local branches are mentioned and marked: **[D4]** is `feat/recheck-collector` at `7b00a75c` (PR #496, not merged) and **[D5a]** is `feat/recheck-wiring` at `cce3e24c` (local only).

Parent contracts: [verify-failure intake](2026-11-16-verify-failure-intake.md) ("the intake design") and [host recheck run](2026-11-19-host-recheck-run.md) ("the recheck design"). This document changes neither. It answers one question the two designs left open: which production code calls the libraries they describe.

## 0. The gap

Nodes B1 to B7 and D1 to D4 were each delivered as a library with a static guard that keeps it unwired. The result is that route B (a trusted verification failure, one host diagnosis, one repair, one publication, one recheck) has no production caller at any step:

- Every entry function of the route is named only in its own file (§2).
- The runner port that publishes a local repair is never set, so a local-failure child that reaches publication halts at `verify_publish_authority_invalid` (`packages/cli/src/contained-mission-runner.ts:873`).
- The grant service issues and accepts only version 1 grants (`packages/cli/src/contained-mission-grant.ts:49`, `:402`). The only caller of `signLocalFailureRevisionGrant` is a test fixture (`packages/core/src/state/diagnosis-fixtures.ts:132`). No chain in production can carry the V2 grant that every step of the route checks.
- The recheck design names `resumeConfirmedLocalPublication` (`contained-mission-runner.ts:246`) as the anchor for its wiring node (its §7, row D5). That method has no caller and a guard forbids one (`packages/cli/src/contained-mission-diagnosis-guards.test.ts:17-18`).

W gives each library exactly one production caller in the contained mission service, behind one switch that defaults to off.

## 1. The switch

One route-level environment variable, read once by `createContainedMissionService` (`packages/cli/src/contained-mission-rpc.ts:363` onwards): `OSSTACK_LOCAL_FAILURE_REPAIR=1` turns the route on; unset or any other value is off. This name and form were chosen by the orchestrating session, not by the owner. The recheck wiring (D5b) uses the same switch, not a second one.

Rules:

1. **Off means absent.** With the switch off the service must not import a route module, build a route port, start a route timer, register a route RPC method or set `localFailurePublication`. The service already has this shape for optional parts: `ContainedMissionServiceOptions` takes `githubCi?`, `live?`, `merger?` as optional handles (`contained-mission-rpc.ts:59-83`) and `start()` calls them only when present (`:147-152`).
2. **One assembly module.** All route wiring lives in one new file, `packages/cli/src/contained-mission-local-failure-service.ts`, loaded by a lazy `await import()` inside the `=== '1'` branch. It returns one handle `{ start(), stop(), recover(), ports }`. The guards are changed to allow exactly this file as the caller of each library (§2), so the allow-list stays one name long.
3. **Proof of "byte for byte".** Three tests, added in the first node and kept by every later one:
   - Service construction with the switch unset, `0`, empty, `true` and `on` produces a service whose options object has no route handle, and the ports object has no `localFailurePublication`. Compared by deep equality against a snapshot of the keys taken with the route file deleted from the module graph.
   - With the switch off, the route assembly module is never imported (asserted with a module-load spy, as the CLI startup closure test does).
   - The method table of `handle()` (`contained-mission-rpc.ts:200-267`) is identical with the switch off; any route method answers `mission_disabled`-style refusal without touching the store. With the switch off, a full recorded run of the existing service test suite must write the same rows as before (the existing tests are the oracle; no test may be edited to pass).
4. **The switch is not authority.** It only makes the code reachable. Every step still needs what it needs today: a live chain, a valid V2 grant, a registered producer, a human approval for the candidate.

The route needs live revision chains: `DiagnosisStore.chain` reads only `mode='live'` chains that are not closed (`packages/core/src/state/engineering-diagnosis-store.ts:185-191`), and live chains exist only when the bridge runs live (`contained-mission-rpc.ts:503`). See decision 4.

## 2. Call-site map

"Assembly" means the new file of §1. "Guard" names the test in `packages/cli/src/contained-mission-diagnosis-guards.test.ts` unless another file is given.

| Step (intake design §4) | Library function | Production caller it needs | Guard that must change | Ports still missing |
|---|---|---|---|---|
| 0. Read results | `readVerificationResults` (`contained-mission-verification-reader.ts:121`) | Assembly: a scan on its own timer, one registered PR at a time, never on the Mission tick (same rule as `githubCi`, `contained-mission-rpc.ts:70`) | None today forbids it; W adds one that allows only the assembly | `rest` and `installationFor` exist as `createVerificationRest` (`contained-mission-verification-read-transport.ts:8`) and `contained-mission-verification-installation.ts`, both unwired. Policy: `loadVerificationProducerConfig` (`contained-mission-verification-producer-config.ts:18`), unwired. Target list: §3.3 |
| 0. Record results | `VerificationSourceStore.record` (`packages/core/src/state/engineering-verification-source-store.ts:28`) | Assembly, same scan, same pass as the read | New guard: only the assembly calls `record` outside core and tests | None |
| 1. Register diagnosis | `registerDiagnosis` (`contained-mission-diagnosis.ts:61`) | Assembly, after a failed result is accepted | Line 28 (`daemon`, `bin`, `cli-entry`, `*-rpc` may not name the diagnosis modules) stays. New line: only the assembly may name `registerDiagnosis` | `registration(resultId)` must return the **contract text**. No code keeps or returns it (§3.1) |
| 2-4. Diagnose | `runDiagnosis` (`contained-mission-diagnosis.ts:75`) | Assembly: once per registered request, automatically (decision 3) | As above, for `runDiagnosis` | `keys`, `access`, `loadInstalledProfile`, `readCandidate`, `imageOptions`, `host`, `randomId`: **[D5a]** supplies all of them for the recheck (`createRecheckRunPorts`); W reuses the same factory with `registration` added (§3.2) |
| Restart | `recoverDiagnoses` (`contained-mission-diagnosis.ts:317`) | Assembly `recover()`, called once from `ContainedMissionService.start()` after `host.recover()` and before any timer (`contained-mission-rpc.ts:143-153`) | As above | Same as diagnose |
| 5. Dispatch | `dispatchLocalFailureRepair` (`contained-mission-local-failure-dispatch.ts:45`) | Assembly, after a request becomes eligible | Line 28 names `dispatchLocalFailureRepair`, `LocalFailureDispatchStore` and the module for entry files; stays. New line: only the assembly | `launchCaps`: use `ports.revisionLaunchCaps` (`contained-mission-ports.ts:427`). `worktreesRoot`: the host's. `locations`: source not traced (§8) |
| Restart | `recoverLocalFailureDispatch` (`contained-mission-local-failure-dispatch.ts:37`) | Assembly `recover()`, per consumed request without a confirmed child | As above | None |
| 6. Execute | none new: the dispatched child is an ordinary contained Mission and the existing host tick steps it (`contained-mission-host.ts:189-205`) | Already wired | None | None |
| 7. Approve candidate | `approveLocalFailureRepair` (`contained-mission-local-failure-approval.ts:55`) | One operator entry (decision 2) | "keeps local failure publication closed outside its library" (line 35) allows only the approval and publish modules; it must allow the assembly, and, if decision 2 picks an RPC method, exactly one line in `contained-mission-rpc.ts` | `refresh` is `deps.access.refresh` (`contained-mission-rpc.ts:444`) |
| 7-8. Publish | `publishLocalFailureRepair` (`contained-mission-local-failure-publish.ts:132`) through the runner port `localFailurePublication` (`contained-mission-runner.ts:91`, `:912`) | `createContainedMissionPorts` receives the port from the assembly only when the switch is on | Same guard, lines 44-49: it strips three exact runner strings and forbids the word `localFailurePublication` everywhere else. It must allow the assembly and one line in `contained-mission-ports.ts` | `host` is `ports.hostProcesses` (`contained-mission-ports.ts:62`). `runner`, `readPr`, `repository`, `enabled`: the bridge publication adapters hold equivalents (`contained-mission-bridge-assembly.ts:63-66`); which ones can be shared is not traced (§8) |
| 8. Reconcile an uncertain push | `reconcileLocalFailurePush` (`contained-mission-local-failure-publish.ts:119`) | Assembly: read-only, at start and on an operator retry (decision 3) | Same guard | Same as publish |
| 8. Resume after a confirmed push | `resumeConfirmedLocalPublication` (`contained-mission-runner.ts:246`) | Assembly, only after `reconcileLocalFailurePush` returned `confirmed` | Lines 17-18 forbid every file from naming it; must allow the assembly | None |
| 8. Confirm push | `confirmLocalRepairPush` | Already called by the publisher (`contained-mission-local-failure-publish.ts:109`) | "keeps published-head writes in the chain store..." (line 53) stays unchanged | None |
| 9. Recheck run | `runRecheck`, `recoverRecheckRuns` (`contained-mission-local-failure-recheck-run.ts:73`, `:277`) | D5b, behind the same switch | Line 73 guard; D5b's change, not W's | **[D5a]** |
| 9. Collect | `collectLocalFailureRecheck` **[D4]** | D5b | **[D4]** guard; D5b's change | Contract text for two ports (§3.1) |
| 10. Close-out | `readLocalFailureCloseout` (`contained-mission-local-failure-closeout.ts:24`), `evaluateVerificationGate` | Not in W (§5.3, decision 6) | Lines 19-22 | `readPr` and `countedApprovers` have no implementation |

## 3. What is missing besides callers

### 3.1 Contract text

Three ports need the exact text of a verification result: `registration` (diagnosis), `readOriginalContract` and `readRecheckContracts` (collector, **[D4]**). Each consumer checks the text against the digest in the source ledger (`engineering-diagnosis-store.ts:198`). But the text exists nowhere after the read: the source ledger stores `contract_digest` only, and the reader lets only identifiers, digests and a parsed reference leave it (`contained-mission-verification-reader.ts:65`, `:91`).

Two ways to supply it (decision 7):

- **Re-read (recommended).** A new reader function fetches one check run by its recorded `object_id`, applies the same producer checks as `classifyVerificationCheckRun`, and returns the output text only when its SHA-256 equals the `contract_digest` of an accepted source row. The text is held in memory for the one call and is never stored. It stays data: the consumers parse it with the strict contract parser and nothing else.
- **Store the text.** A new column in the source ledger. This needs a migration, keeps external text at rest, and widens what a database reader can see.

### 3.2 Host ports

**[D5a]** already builds every host port the diagnosis needs, because the recheck run takes the same ports minus `registration`. W should move that factory to a route-neutral name (or call it as it is) and add `registration` from §3.1. Configuration it needs, none of which has a production source yet:

- Docker: the service already requires `OSSTACK_CONTAINED_DOCKER_SOCKET`, `OSSTACK_CONTAINED_DOCKER_DAEMON_ID` and `OSSTACK_CONTAINED_BASE_IMAGE_ID` for the other verification route (`contained-mission-rpc.ts:464-465`). Reuse them; the journal root is a new directory under the daemon home.
- Installed profile host: install root, owner uid and the allowed argv list (`contained-mission-verification-profile.ts:50-56`). New host configuration (decision 8).
- Repository path that holds the head to verify. For the diagnosis this is the PR head fetched by the host; for the recheck it is the child's published commit. Not traced which existing checkout holds both (§8).
- Grant keys: the live bridge configuration's issuer keys (`contained-mission-bridge-assembly.ts:54`).

### 3.3 Which PRs are read

The intake design allows only explicitly registered PRs (its §9.1, "定时巡检"). The only durable registration that exists is the live chain. W reads a PR only when a live, open chain for it carries a valid V2 grant (decision 5). No discovery from GitHub.

### 3.4 The V2 grant has no issuing path

This is the largest missing piece and it is not a port. Today:

- `mission.revision_grant_preview` builds a version 1 preview and `mission.grant_revisions` accepts a signature over it (`contained-mission-grant.ts:189`, `:402`); the host command `mission grant-revisions` signs with the issuer key that the daemon never holds (`contained-mission-grant-command.ts:140`, file header of `contained-mission-grant.ts:6-9`).
- Nothing builds a `LocalFailureGrantPreview`, shows it to the owner, signs it or stores it on a chain.

Without this node the switch can be on and nothing after "record results" can pass, which is safe but useless. See decision 1.

## 4. Authority and remote answer paths

The rule from the task: an approval or a grant that needs a host signature must not gain a remote answer path.

How answers reach the service today:

- Every `mission.*` method is a local-socket RPC authenticated by a bearer credential from the engineering authority file (`contained-mission-rpc.ts:2`, `packages/cli/src/daemon.ts:1320-1322`).
- `decisions.answer` is a second, generic route (`daemon.ts:1282`). It forwards an answer to `mission.decide` or `mission.approve_ci_repair` with the caller's credential (`packages/cli/src/decisions/answer.ts:113`). It is the route a remote assistant uses to answer a pending decision. It already refuses four kinds with `local_only`: loop, autonomy, session items that need a local signature, and `grant_revisions` on a chain (`answer.ts:51`).
- A grant is safe from this route because the signature is made on the host with a key the daemon does not hold. A candidate approval is different: it is an operator-scope record, not a signature (`contained-mission-local-failure-approval.ts:10-14`, `:89-96`).

Flags:

1. **Candidate approval would become remotely answerable by default.** If W adds the approval as a `mission.*` method and lists it as a decision the way `ci_repair` is listed (`decisions/list.ts:41-43`), `decisions.answer` forwards it for anyone who holds a credential with read, write and operator scope. The intake design says the candidate is approved by a person (its §9.1, "授权边界与多轮"). Recommendation in decision 2: `decisions.answer` returns `local_only` for it.
2. **The decision list already advertises a wrong answer.** A local-failure child waiting at `publication_pending` is listed with `approve_publication` as an allowed answer, because the list excludes only `ci_repair` (`decisions/list.ts:37`). The runner refuses that answer for a local-failure child (`contained-mission-runner.ts:275`, `:349`). No harm today, since no such child exists in production, but the first W node that can create one must correct the list in the same PR.
3. **`mission.decide` on a local-failure child.** `abandon` is allowed and safe. `extra_repair` and `approve_publication` are refused (`contained-mission-runner.ts:270`, `:275`). `resume_budget` and `resume_grant` need a `publish_target`, which the child does not have (`:292-295`). `discard_changes` is refused once the executor ran (`:277`, `:368`). `adopt_worktree` at `needs_reconciliation` is **not** excluded for a local-failure child (`:278`); whether that can move a repair forward without the approval was not traced (§8). W must add a test for it before any child can exist.
4. **V2 grant.** Must follow the version 1 pattern exactly: preview over RPC, signature only by the host command with the issuer key, `decisions.answer` answers `local_only`. No new method may accept a grant without a signature. The preview must show the local-failure opt-in and the recheck opt-in in plain words, because one signature now authorises a diagnosis run, one repair dispatch and one recheck run.
5. **Recheck re-arm (D5c).** Still open with the owner. The recheck design says no RPC reaches the run (its §3.4) while every operator action that exists is an RPC method. W does not decide it and adds no entry for it.
6. **Who holds a credential.** Whether a remote assistant is given a credential with operator scope is host configuration in the authority file, outside the repository. If it is, flags 1 and 3 are live; if it is not, they are latent. Not verified (§8).

Nothing in W adds a decision kind, a webhook input or a bot command. The notification channel only receives notices.

## 5. Order of operations inside the route

### 5.1 What runs automatically

With the switch on, a valid V2 grant on the chain and a registered producer (decision 3 asks the owner to confirm this table):

| Step | Automatic | Why |
|---|---|---|
| Read and record results | Yes, on the scan timer | Read-only |
| Register a diagnosis | Yes | A row, no launch |
| Run the diagnosis | Yes, once per head and profile | The signed grant is the opt-in (intake design §9.1: "首发每个 head 与 profile 诊断一次") |
| Dispatch one repair | Yes, once per root chain | Same decision record: "每条根链修复一次" |
| Execute and verify the child | Yes | Existing Mission tick |
| Approve the candidate | **No** | "候选默认由人批准后推送" |
| Publish after approval | Yes, within the approval's 15 minutes (`contained-mission-local-failure-approval.ts:94`) | The approval names the exact candidate |
| Reconcile an uncertain push | Read-only pass at service start; later only on an operator retry | The intake design forbids a blind re-push |
| Resume after a confirmed push | Yes, only after reconcile returned `confirmed` | No remote write |

### 5.2 Restart

`start()` gains one call, after `host.recover()` and `revisionRecovery` and before any timer: the assembly's `recover()`. It runs `recoverDiagnoses` (settles `reserved`, marks `running` as `stop_unknown`, launches nothing), then `recoverLocalFailureDispatch` for each consumed request, then the read-only reconcile pass. Recovery never starts a container and never pushes.

### 5.3 What W does not wire

- **The merge hold (intake design §4.1).** That section calls the hold "the hard gate for B going live". `evaluateVerificationGate` and `readLocalFailureCloseout` exist and are unwired, and neither the sandbox CI merge (`contained-mission-rpc.ts:554-567`) nor the shadow Merger consults them. W does not wire them (the orchestrator's scope list ends at the confirmed push), but turning the switch on for a repository where an automatic merge path is also enabled would let a PR merge on green Actions before a failure arrives. Decision 6.
- The recheck run, the collector and the close-out view: D5b and D5c.
- The Watcher publisher: B8.
- Any change to `evaluateMergeGates`, the profile runtime limits, the depth limit or the tables.

## 6. Node split

One PR per node, each against `main`, in this order. Every node keeps the three "off" tests of §1 green and adds its own. No node needs a migration unless decision 7 picks "store the text".

| Node | Content | Main files | Acceptance |
|---|---|---|---|
| W1 | Switch, assembly skeleton, the "off" proof, guard allow-list of one file. The assembly does nothing yet | `contained-mission-rpc.ts` (one branch), new `contained-mission-local-failure-service.ts`, guards | The three tests of §1.3. Switch on without a live bridge behaves as decision 4 says. No library is called |
| W2 | V2 grant: preview, host signing command, acceptance and storage on the chain, `local_only` in `decisions.answer` | `contained-mission-grant.ts`, `contained-mission-grant-command.ts`, `decisions/answer.ts`, `decisions/list.ts` | A V1 flow is unchanged byte for byte. A V2 grant without a valid host signature is refused. The preview lists diagnosis, repair and recheck opt-ins. No path stores a V2 grant with the switch off. `decisions.answer` never forwards it |
| W3 | Read, record, contract text, register. Read-only towards GitHub, no launch | assembly, new reader function for §3.1, producer config and transports wired | Only PRs of live chains with a valid V2 grant are read. Partial reads record nothing. Text is returned only when its digest matches an accepted row. Untrusted producer, stale head, withdrawal each end as the intake design says. Zero containers, zero pushes |
| W4 | Diagnosis run and restart recovery | assembly, host ports factory from **[D5a]** generalised | With fake `prepare` and `run`: one run per request; reproduced failure becomes eligible; pass, timeout and infrastructure error dispatch nothing; crash points never launch twice; recovery at start launches nothing |
| W5 | Dispatch and dispatch recovery | assembly | One child per root chain across review, Actions and local writers; protected paths refuse; a crash after consumption recovers the same child; the child halts at `publication_pending` and, without W6, cannot publish |
| W6 | Candidate approval entry and the decision list correction | per decision 2 | Approval needs read, write and operator scope, binds the exact candidate and expires. `decisions.answer` answers `local_only`. The list no longer offers `approve_publication` for a local-failure child. `adopt_worktree` test of §4 flag 3 |
| W7 | Publication port, reconcile, resume after confirmed push | assembly, one line in `contained-mission-ports.ts`, guards | With a fake delivery runner: no push without a live approval; withdrawal before release pushes nothing; unknown after release only reconciles; a confirmed push records `local_repair_push_confirmed` once; nothing re-pushes |
| D5b | Recheck recovery, collect, one automatic recheck run | as in the recheck design | Needs W7 and **[D5a]** |
| D5c | Operator re-arm, close-out view, notices | open | Needs the owner's answer on transport |
| W8 | Merge hold, if decision 6 puts it here | close-out reader ports, the merge paths | Green Actions with a pending or failed verification never merges |

W1 and W2 are independent. W3 needs W1 and W2. W4 needs W3 and **[D5a]**. W5 needs W4. W6 needs W5. W7 needs W6. If W2 is too large, split the host command from the service acceptance; if W3 is too large, split the contract-text reader from the scan.

## 7. Decisions for the owner

| # | Decision | Recommendation | If the alternative is taken |
|---|---|---|---|
| 1 | Is issuing the V2 grant part of W (node W2), and by which path | Yes. Same path as version 1: preview over RPC, signature only by the host command with the issuer key, never answerable through `decisions.answer` | Without it nothing after "record results" can run. A path that accepts a V2 grant without a host signature would hand a diagnosis run, a repair and a recheck to any credential holder |
| 2 | How the candidate approval is given | A new method `mission.approve_local_failure_repair` beside `mission.approve_ci_repair`, requiring read, write and operator scope; `decisions.answer` returns `local_only` for it, so in the first release it can only be typed on the host | Allowing it through `decisions.answer` lets a remote credential holder approve a push. A host-only command with no RPC has no transport today (the same open question as the recheck re-arm) |
| 3 | Which steps run without a person | The table in §5.1: everything up to the candidate is automatic under a valid V2 grant; the approval is always a person; reconcile after an uncertain push is automatic once at start and otherwise on an operator retry | Making the diagnosis or the dispatch manual adds two more waits per PR and needs two more operator entries, each with the transport question of decision 2 |
| 4 | Switch on while the bridge is not live | The service refuses to start with a fixed configuration error, as it does for `contained_missions_require_engineering` (`daemon.ts:4433`) | Silently staying off hides a misconfiguration; the route cannot work without live chains either way |
| 5 | Which PRs are read | Only PRs of live, open chains that carry a valid V2 grant | Reading every Mission PR spends API calls and records results nobody authorised acting on; it is still read-only |
| 6 | The merge hold of the intake design §4.1 | Its own node (W8) after D5b, and until it is merged the service refuses to start with the switch on when an automatic merge path is also configured (sandbox CI merge key or live pilot merge) | Putting it inside W7 makes that PR too large. Leaving it out with no refusal lets green Actions merge a PR before a failure is read |
| 7 | How the contract text is supplied | Digest-checked re-read of one check run, held in memory only (§3.1) | Storing the text needs a migration and keeps external text at rest |
| 8 | Where the installed-profile host settings come from | A protected file in the daemon home with the same checks as `bridge/verification-producers.json` (owner uid, mode 0600, no symlink; `contained-mission-verification-producer-config.ts:25-28`) | Environment variables are simpler but an allowed argv list does not fit one variable well |
| 9 | The switch name and form | Confirm `OSSTACK_LOCAL_FAILURE_REPAIR=1`, anything else off (chosen by the orchestrating session) | A config-file field would be the alternative; behaviour is the same |

Decisions already taken and not reopened here: the upstream wiring is its own node before D5b (owner, 2026-11-20); one switch for W and D5b (orchestrating session).

### 7.1 Decision record (2026-11-20)

The owner accepted all nine decisions on 2026-11-20, each as recommended in the table above. The owner's words: "我都同意".

| # | Decided |
|---|---|
| 1 | Issuing the V2 grant is node W2. Preview over RPC, signature only by the host command with the issuer key, never answerable through `decisions.answer` |
| 2 | The candidate approval is a new method `mission.approve_local_failure_repair` with read, write and operator scope; `decisions.answer` returns `local_only` for it |
| 3 | The steps of §5.1 run as listed: everything up to the candidate is automatic under a valid V2 grant, the approval is always a person |
| 4 | With the switch on and the bridge not live, the service refuses to start |
| 5 | Only PRs of live, open chains that carry a valid V2 grant are read |
| 6 | The merge hold is its own node, W8, after D5b. Until it is merged the service refuses to start with the switch on when an automatic merge path is also configured |
| 7 | The contract text comes from a digest-checked re-read of one check run, held in memory only |
| 8 | The installed-profile host settings live in a protected file in the daemon home |
| 9 | The switch is `OSSTACK_LOCAL_FAILURE_REPAIR=1`; anything else is off |

Still open, and not decided by this record: the transport of the operator re-arm for the recheck run (D5c). The recheck design says no RPC reaches the run (its §3.4), and every operator action that exists today is an RPC method. D5c stays parked until the owner answers.

With these decisions recorded, nodes W1 to W7 are unblocked in the order of §6.

### 7.2 Addendum (2026-11-20): where the numeric repository id comes from

Found while preparing W3; this document missed it. The reader's target needs a numeric `repository_id` (`contained-mission-verification-reader.ts`, `VerificationReadTarget`). A live chain and its version 2 grant carry only the repository name. The producer policy in `bridge/verification-producers.json` carries `repository_id` but no name. No host file held the pair.

Two sources were possible:

- (a) An optional list `repositories: [{ repository, repository_id }]` in `bridge/verification-producers.json`, the same protected file with the same checks. A chain whose repository is not listed is not read.
- (b) Take the ids from the policy's producer entries and let the reader's own name and id check against GitHub's PR answer confirm the pair.

Chosen: (a). It is explicit and fails closed like the rest of the route, it costs no extra GitHub read, and the reader's name and id check stays a second check instead of becoming the source. **This was decided by the orchestrating session, not by the owner.** Changing to (b) later is a small change in the scan module.

Rules that follow from (a): the list is optional; an absent list or an unlisted repository means "not read" and is never a start error; a duplicate name, a duplicate id, or an id that no producer entry in the same file names makes the file invalid; a file without the field loads exactly as before. The owner adds the pair for each repository to the host file by hand. No real id is written in this repository.

Two further points settled for W3, also by the orchestrating session:

- The digest-checked re-read of §3.1 checks the run's identity and the text digest against the accepted ledger row, and that the App is still a registered producer for that repository. It does not check freshness, the TTL or the PR's current head, because the same function must later serve the recheck collector for an old result. The caller must check those: for registration that is the scan pass, which re-reads only results it has just read as fresh on the chain's current head, and `DiagnosisStore.register`; for the collector it is D5b.
- The "valid V2 grant" check of decision 5 is made inside the scan module from the core functions (parse, signature, window, principal, chain binding), without a change to the grant service.

### 7.3 Addendum (2026-11-20): the diagnosis run (W4)

Six points were open when the W4 brief was drafted. The owner accepted all six as recommended on 2026-11-20.

1. **Finding the requests to run.** `DiagnosisStore` gets one read-only method, `registered(limit)`: requests in state `registered` that were never admitted, oldest first. No schema change. The diagnosis is not run inside the W3 scan, because a request registered just before a crash would be lost once its result expired.
2. **Which checkout holds the head.** The repository path is the `repo_path` of the root Mission's own specification in the host ledger. It never comes from GitHub or from the verification result. A missing Mission, an unreadable specification, a relative path or a path that is not a directory leaves the request `registered`. A head that is not in that object store is not caught earlier: the library holds the request for a person, as it does today.
3. **Profile host settings.** A new protected host file `bridge/verification-profile-host.json` (`version`, `installed_root`, `allowed_argv`) with the same file checks as the producer file. Missing file: the route starts and recovers, but launches no diagnosis. Invalid file: start is refused. The owner creates the file by hand.
4. **Docker settings.** With the switch on, `OSSTACK_CONTAINED_DOCKER_SOCKET`, `OSSTACK_CONTAINED_DOCKER_DAEMON_ID` and `OSSTACK_CONTAINED_BASE_IMAGE_ID` are required; a missing one refuses start. The journal root is `local-failure-diagnosis` under the daemon home.
5. **Pace.** Its own timer, one minute, one request per tick, never two diagnoses at once, never on the Mission tick or in the scan.
6. **What runs without a person.** Only `registered` requests. A request in `awaiting_decision` is never run again by the service, whatever its reason. An entry for a person to release one does not exist yet.

One rule was added by the session that wrote the brief, not by the owner: a service instance hands a request to the library at most once, whatever the library answers. The library's own admission rule still applies.

### 7.4 Addendum (2026-11-22): the dispatch (W5)

Seven points were open when the W5 brief was written. **All seven were chosen by the session that wrote the brief, not by the owner.** Each takes the option that dispatches less. The owner may overrule any of them in review.

1. **Allowed locations of the repair.** Traced (§8 had left it open): when the port passes no `locations`, the core takes the root Mission's own `allowed_paths`, and the protected-path check then refuses any of them that touches a protected or verification path. No trusted, narrower source exists: the verification result is external text and must not choose paths. W5 passes no `locations`.
2. **Finding the requests to dispatch.** `DiagnosisStore` gets one read-only method, `dispatchable(limit, after)`: requests in state `eligible` whose receipt is not consumed, whose root has no dispatch row, and whose root has no `local_failure_dispatch_refused` event. No schema change.
3. **A refusal is final for the service.** The core answers a refused dispatch with `awaiting_decision`. The service never tries that root again, also not after a restart, whatever the reason (a busy chain included). An entry for a person to release one does not exist yet.
   **Changed on 2026-11-23 (node W5b, approved by the owner):** a refusal holds until the request's chain is renewed. A version 2 `grant_replaced` event on the request's own chain, recorded strictly after every refusal event of the root, re-opens the request for one attempt. A refusal after that renewal closes it again until a further renewal. Nothing else re-opens it: not a restart, not time, not a renewal of another chain. A root that has a dispatch row is never offered again. To make the second refusal visible, the core records a repeated refusal with the same reason again once a renewal has happened since the last one; without a renewal it still records one event per reason. The step remembers an attempt by request and by the re-opening chain event, so one instance tries once per renewal. The core dispatch checks, the succession test of the renewal design (its §2.6) and the one-repair-per-root rule are unchanged. Chosen by the session that wrote the brief, not by the owner: equal timestamps do not re-open; a request skipped for missing host ports stays skipped in that instance after a renewal; the comparison uses the event times of the two ledgers, which is why the step's memory also carries the chain event's sequence number.
4. **Pace.** Its own timer, one minute, at most one dispatch per tick, never on the Mission tick, in the scan or in the diagnosis tick. A service instance hands a request to the library at most once.
5. **Host ports.** The dispatch uses the same host ports the diagnosis built for that request (issuer keys, access, installed profile, root Mission with a usable `repo_path`). So without `bridge/verification-profile-host.json` nothing is dispatched either. Launch caps are the contained host's own (`revisionLaunchCaps`); the worktrees root is the host's default.
6. **Restart.** The core commits a dispatch in one transaction: receipt consumption, child registration, budget allocation and the dispatch row either all exist or none does. A crash before the commit leaves the request `eligible` and unconsumed, and the next tick dispatches it once. Start recovery therefore has nothing to settle and launches nothing; before each dispatch the service asks `recoverLocalFailureDispatch` and skips a request that already has a child.
7. **§4 flags 2 and 3 stay with W6.** The decision-list correction and the `adopt_worktree` test are in the W6 row of §6, while §4 asked for them in "the first node that can create a child". W5 leaves them to W6, because the service still cannot start with the switch on (the live bridge gate refuses), so no child can exist in a running service before W6, and the runner already refuses `approve_publication` for such a child. If the live gate opens before W6 is merged, W6 must land first.

### 7.5 Addendum (2026-11-23): the candidate approval entry (W6)

Decision 2 is implemented as decided: `mission.approve_local_failure_repair` needs read, write and operator scope on the Mission's scope, binds the exact candidate, expires after 15 minutes, and `decisions.answer` answers `local_only` for it. Seven further points were open when the W6 brief was written. **All seven were chosen by the session that wrote the brief, not by the owner.** Each takes the option that approves or advertises less. The owner may overrule any of them in review.

1. **No approval before the publication port exists.** The approval is single-use per child: the library refuses a second one once a `verify_repair_approval` event exists. Without the publication port of W7 the runner ends an approved child at `verify_publish_authority_invalid`, and that repair could then never be approved again. So the route handle carries a flag, `publicationReady`, and the method refuses with `local_failure_publication_unavailable` while it is false. W6 sets it to false. W7 sets it when it wires the port.
2. **Switch off.** The method refuses with `local_failure_route_disabled` before any Mission is read.
3. **Request shape.** `credential`, `mission_id` and `candidate` only. There is no `decision_id` and no `expected_revision`, so there is no keyed replay. A repeat is refused by the library.
4. **Typed on the host.** A host command, `mission approve-local-failure-repair --mission ID --candidate SHA`, beside `approve-ci-repair`.
5. **The decision list.** A repair child is never listed with `approve_publication` or `extra_repair`; the runner refuses both (§4 flag 2). At `publication_pending` it is listed with `approve_local_failure_repair`, the host command as an alternative, and `requires_local_signature` set, as a chain that lists `grant_revisions` is. The flag name says "signature"; here it means "this item has an answer that only the host command gives". `resume_budget`, `resume_grant` and `discard_changes` stay listed as before; the cases in which the runner refuses them were not all traced.
6. **Where `decisions.answer` refuses.** On all three engineering sources, on the same line as the grants, before any revision check and before any forward. `decisions.answer` gains no forwarded method.
7. **`adopt_worktree` (§4 flag 3, §8).** Traced and pinned by a runner test: adoption commits the worktree as a candidate, the protected-path check and the verification still run, and the child stops at `publication_pending`. It writes no delivery intent, calls no publisher, and `approve_publication` stays refused. Adoption cannot move a repair past the approval. No code was changed for it.

The method is a `mission.*` method on the local socket, like every other operator action. Whoever holds a credential with read, write and operator scope on that socket can call it; that is decision 2 as taken, and §4 flag 6 (who holds such a credential) is still host configuration.

### 7.6 Addendum (2026-11-23): the commit audit and the repair push (W7a)

**The gap.** The bridge's commit audit (`verifyBridgeLedger`, `packages/cli/src/contained-mission-bridge-ledger.ts`) rebuilt a chain's expected head only from the chain's own publication intents: the `open_pr` intent and each confirmed `push` intent. A local-failure repair push writes no chain intent. Its confirmation moves the chain's published head with a chain event only (`confirmLocalRepairPush`). So after every confirmed repair push the audit answered `external_write`, and the live scan, the stopped-chain scan and the start-up ledger recovery would each have stopped the chain for a write the host made itself. No earlier section of this document saw that.

**Decision (owner, 2026-11-23, in the owner's words: "A：单独节点 W7a").** The audit learns the repair push, as its own node before W7. No migration, no RPC method, no change in `packages/core`.

**Rule 1: one accepted step.** One `local_repair_push_confirmed` chain event counts as a covered step from its `old_head` to its `new_head` with exactly one commit, `new_head`. The step is accepted only when all of this holds:

- the event is on this chain, and it is the only such event on the chain;
- its payload has exactly `dispatch_id`, `child_mission_id`, `old_head` and `new_head`, and the two heads are different commit ids;
- a dispatch row exists with that id, for this chain, this chain's root Mission and that child;
- the child has exactly one approval record (`verify_repair_approval`) for that candidate, that previous head, the chain's branch, base and PR and that dispatch;
- the child has exactly one push intent (`verify_repair_push_intent`), recorded after the approval, with the same candidate, previous head, branch, base and PR;
- the child has a confirmation (`verify_repair_push_confirmed`), recorded after the intent, for the same intent and the same facts;
- the host process record of that intent is a `git push` of that child, released and stopped;
- `old_head` is the head the audit has reached when it walks the chain: the baseline, then at each head either the one confirmed push intent or the repair step that starts there. A push and a repair step that start at the same head, or a step that the walk never reaches, make the ledger invalid.

The audit's existing final checks are unchanged and now cover the repair step too: the walk must end at the chain's published head, the remote head must equal it, and the list of covered commits must equal the commit list that GitHub reports from the root's start commit to the published head. That last comparison is what proves, against the real repository, that the repair is exactly one commit on top of the previous head. A second commit under the candidate, a different parent, a missing or mismatched record, a duplicate event or an event out of order is `external_write`, as before. Stored data that cannot be parsed is `external_write`, never a read error.

**Rule 2: a released push that is not confirmed yet.** After the remote head is read, the audit answers `reconciliation_incomplete` when the chain's dispatch has a child with one approval and one push intent that bind the chain's current published head, branch, base and PR, the host process of that intent has been released, neither the chain nor the child has a confirmation, and the remote head is exactly that intent's candidate. In every other case nothing is deferred: a remote head that is neither the published head nor that candidate is `external_write`; an intent whose process was never released, with the remote at the candidate, is `external_write`; with the remote still at the published head the audit runs as usual.

**What the audit trusts for this step, and who can write it.** Six stored facts, all in the host's own database, none read from GitHub or from a verification result:

| Fact | Table | Written by |
|---|---|---|
| Chain event `local_repair_push_confirmed` | `engineering_revision_chain_events` (append-only by trigger) | `RevisionChainStore.confirmLocalRepairPush` only; a static guard pins the files that may name the event, and another pins the publisher as the only caller |
| Dispatch row | `engineering_local_failure_dispatches` | `LocalFailureDispatchStore.dispatch` only, under the insert triggers of that table (one per root, one per child) |
| Approval record | `engineering_contained_events` of the child | `approveLocalFailureRepair`, called only by the operator method `mission.approve_local_failure_repair` (§7.5) |
| Push intent | same | the publisher, in the transaction that re-checks the approval and the publication fence |
| Push confirmation | same | the publisher, after the PR and the remote branch both read back at the candidate, in the transaction that calls `confirmLocalRepairPush` |
| Host process record | `engineering_host_processes` | the gated launcher (W13) |

The only outside input is the two reads the audit already made: the remote branch head and the compared commit list. The audit does not re-check that the approval was unexpired at push time; the publisher did that inside the release transaction. Like the rest of the audit, the rule assumes that only the host process writes this database.

**Start-up order.** `start()` runs the ledger recovery before the route's `recover()` (`contained-mission-rpc.ts`). After this change: a repair push that is confirmed is `matched`. One that landed but is not confirmed is `reconciliation_incomplete`, so the chain is not stopped; it stays so until the reconcile pass of W7 confirms it, after which the next audit is `matched`. One that was released and did not land leaves the remote at the published head, and the audit runs as usual. Until W7 exists nothing confirms such a push at start, and nothing produces one either.

**Chosen by the session that wrote the brief, not by the owner.**

1. At most one repair step per chain. The dispatch table allows one repair per root, so a second event can only be an error.
2. The deferral of rule 2 holds only while the remote head is exactly the candidate, and it is decided after the remote read. The audit's own unsettled pushes are also deferred before the read; the repair push is not, because nothing settles a repair intent automatically yet, and a blanket deferral would switch the audit off for that chain.
3. While rule 2 defers, the chain is not audited. That lasts until the push is confirmed. If it never is (the PR cannot be read back), the chain stays unaudited at that one candidate, which the host pushed under an approval, until a person acts. W7's reconcile pass is the remedy.
4. The audit reads the child's events and the dispatch row with its own queries on the shared database, as it already reads the host process table. No store method was added.

## 8. What could not be verified

- Nothing was built or run for this document beyond the gates in §9. Every statement about behaviour comes from reading the source at `bb360e92`.
- Where the dispatch takes the repair's allowed `locations` from when the port passes none (`packages/core/src/state/engineering-local-failure-dispatch-store.ts:220-251`). W5 must trace this before its brief is written.
- Which existing checkout can serve as the repository path for the candidate reader for both the diagnosis head and the published repair head.
- Whether the bridge's publication adapters (delivery runner, PR read) can be shared with `publishLocalFailureRepair` as they are, or need a thin adapter. The publisher's `readPr` wants `{ state, head.sha, base.sha }` (`contained-mission-local-failure-publish.ts:36-39`).
- Whether `createVerificationRest` and the installation proof in `contained-mission-verification-installation.ts` are complete for production use. They have no caller; I read their signatures, not their bodies.
- Whether `adopt_worktree` on a local-failure child at `needs_reconciliation` can advance a repair without the approval (§4 flag 3).
- Whether any remote client is configured with an operator-scope credential on the serving host (§4 flag 6).
- Whether a host reconciler exists that can move a diagnosis intake from `stop_unknown` to `stopped`. The recheck design listed the same doubt (its §9). Without one, an unknown stop keeps the root excluded until a person acts.
- How the upgrade gate treats an unsettled intake once the route is live. The comments say it holds once per unsettled intake (`packages/cli/src/upgrade-native-port.ts:162-164`); I did not re-read the code path.
- Docker is stopped on this machine by the owner's choice. No node of W can be exercised against a real container here.

## 9. Gates for this document

`pnpm test:deterministic-rules` passes. In `packages/governance`, `vitest run` passes (51 files, 429 tests). The two relative links in this document point to existing files. Nothing else was run; this document claims no implementation, container run or sandbox result.
