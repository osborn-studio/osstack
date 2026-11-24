import { createHash } from "node:crypto";
import type { ContainedProfileRunResult } from "@osstack/agents";
import { canonicalJson, localFailureBindingFromLedger, RevisionChainStore, type LocalVerificationReceipt } from "@osstack/core";
import {
  LocalFailureRecheckStore, LocalFailureRecheckRunStore, VerificationSourceStore,
  parseLocalFailureRevisionGrant, verifyRecheckGrant, type LocalFailureRecheck, type LocalFailureRecheckRun,
} from "@osstack/core/verification-intake";
import type { DiagnosisPorts } from "./contained-mission-diagnosis.js";
import { prepareContainedProfileImage, runPreparedContainedProfile } from "./contained-mission-profile-execution.js";
import type { InstalledVerificationProfile } from "./contained-mission-verification-profile.js";

export type RecheckRunPorts = Omit<DiagnosisPorts, "registration">;
type Trigger = "automatic" | "operator";
type RefusalReason = "recheck_run_state_denied" | "recheck_run_attempts_exhausted" | "verify_recheck_not_started"
  | "verify_grant_missing" | "verify_grant_invalid" | "verify_profile_unavailable" | "verify_infrastructure_error"
  | "verify_withdrawn" | "verify_stale_head" | "verify_base_changed" | "verify_chain_busy" | "verify_budget_exhausted";
type Refusal = {
  status: "refused"; state: "awaiting_decision" | "closed"; reason: RefusalReason; run: null;
};
export type RecheckRunOutcome = Refusal | { status: "existing"; run: LocalFailureRecheckRun }
  | { status: "concluded"; run: LocalFailureRecheckRun };
export interface RecheckRecoveryReport {
  recovered: LocalFailureRecheckRun[];
}
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const concluded = (run: LocalFailureRecheckRun) => ({ status: "concluded", run } as const);

function receiptOutcome(result: Extract<ContainedProfileRunResult, { status: "stopped" }>): LocalVerificationReceipt["outcome"] {
  if (result.termination === "timeout" || result.termination === "cancelled") return result.termination;
  if (result.oomKilled || result.termination !== "exited" || !result.started) return "infrastructure_error";
  return result.exitCode === 0 ? "passed" : "reproducible_failure";
}

function refusal(p: RecheckRunPorts, ledger: LocalFailureRecheck | undefined, trigger: Trigger, reason: RefusalReason): Refusal {
  const state = reason === "verify_withdrawn" ? "closed" : "awaiting_decision";
  const result = { status: "refused", state, reason, run: null } as const;
  if (ledger && reason !== "recheck_run_state_denied") {
    const { store } = p;
    const { root_mission_id, dispatch_id, recheck_id, chain_id } = ledger;
    store.transaction(() => {
      if (!store.chain(root_mission_id, chain_id)) return;
      const prior = store.db.prepare(`SELECT payload_json FROM engineering_revision_chain_events
        WHERE chain_id=? AND kind='local_recheck_refused' AND json_extract(payload_json,'$.dispatch_id')=?
        ORDER BY seq DESC LIMIT 1`).pluck().get(chain_id, dispatch_id) as string | undefined;
      const last = prior === undefined ? null : JSON.parse(prior) as Pick<Refusal, "state" | "reason">;
      if (last?.state !== state || last.reason !== reason)
        new RevisionChainStore(store.attention, store.owner).appendEvent(chain_id, "local_recheck_refused",
          { dispatch_id, recheck_id, trigger, state, reason }, p.now());
    });
  }
  return result;
}

function reservationReason(error: unknown): RefusalReason {
  if (error instanceof Error) {
    switch (error.message) {
      case "recheck_run_grant_mismatch":
      case "recheck_run_binding_denied":
        return "verify_grant_invalid";
      case "verify_withdrawn":
      case "verify_stale_head":
      case "verify_base_changed":
      case "verify_chain_busy":
      case "verify_budget_exhausted":
      case "recheck_run_state_denied":
      case "recheck_run_attempts_exhausted":
        return error.message;
    }
  }
  throw error;
}

export async function runRecheck(p: RecheckRunPorts, recheckId: string, trigger: Trigger, signal: AbortSignal): Promise<RecheckRunOutcome> {
  const store = p.store;
  const runs = new LocalFailureRecheckRunStore(store, p.now);
  const ledgers = new LocalFailureRecheckStore(store);
  let ledger: LocalFailureRecheck;
  try {
    ledger = ledgers.get(recheckId);
  } catch (error) {
    if (error instanceof Error && error.message === "not_found") return refusal(p, undefined, trigger, "recheck_run_state_denied");
    throw error;
  }
  const refuse = (reason: RefusalReason) => refusal(p, ledger, trigger, reason);
  const priorAttempt = (): RecheckRunOutcome | undefined => {
    const active = runs.active(recheckId);
    if (active) return { status: "existing", run: active };
    const attempts = runs.forRecheck(recheckId).length;
    if (attempts >= 3) return refuse("recheck_run_attempts_exhausted");
    if (attempts && trigger === "automatic") return refuse("verify_recheck_not_started");
    return undefined;
  };
  if (ledger.state !== "reverify_pending") return refuse("recheck_run_state_denied");
  const prior = priorAttempt();
  if (prior) return prior;
  const chain = store.chain(ledger.root_mission_id, ledger.chain_id);
  if (!chain) return refuse("verify_grant_missing");
  let grant: ReturnType<typeof parseLocalFailureRevisionGrant>;
  try {
    grant = parseLocalFailureRevisionGrant(chain.grant_json);
  } catch {
    return refuse("verify_grant_missing");
  }
  if (!grant.local_failure.recheck) return refuse("verify_grant_missing");
  const { profile_id, profile_digest, trusted_source } = grant.local_failure;
  const pin = { profile_id, profile_digest, trusted_source };
  const sourceDigest = hash(canonicalJson({
    repository: trusted_source.repository, commit_sha: trusted_source.commit, artifact_digest: trusted_source.artifact_digest,
  }));
  if (profile_id !== ledger.profile_id || profile_digest !== ledger.profile_digest || sourceDigest !== ledger.trusted_source_digest)
    return refuse("verify_grant_invalid");
  let installed: InstalledVerificationProfile;
  try {
    installed = p.loadInstalledProfile(pin);
  } catch {
    return refuse("verify_profile_unavailable");
  }
  if (installed.profile.checks.length !== 1 || installed.profile.checks[0]?.check_id !== ledger.failed_check_id)
    return refuse("verify_profile_unavailable");
  if (store.db.inTransaction) throw Error("recheck_run_nested_launch");
  let candidate: Awaited<ReturnType<RecheckRunPorts["readCandidate"]>>;
  try {
    candidate = await p.readCandidate(ledger.new_head_sha);
  } catch {
    return refuse("verify_infrastructure_error");
  }
  const verify = () => {
    const live = store.chain(ledger.root_mission_id, ledger.chain_id);
    if (live && live.published_head !== ledger.new_head_sha) return { ok: false, reason: "verify_stale_head" } as const;
    if (live && live.published_base !== ledger.base_sha) return { ok: false, reason: "verify_base_changed" } as const;
    if (!live || live.revision !== chain.revision || live.grant_json !== chain.grant_json)
      return { ok: false, reason: "verify_grant_invalid" } as const;
    let principal: ReturnType<typeof p.access.refresh>;
    try {
      principal = p.access.refresh(grant.principal_id, grant.client_session_id);
    } catch {
      return { ok: false, reason: "verify_grant_invalid" } as const;
    }
    return verifyRecheckGrant({
      grant_json: live.grant_json, keys: p.keys(), principal, now: p.now(), budget_json: live.budget_json,
      run: { root_mission_id: ledger.root_mission_id, repository: ledger.repository, pr_number: ledger.pr_number,
        branch: live.branch, base_ref: live.base_ref, base_sha: ledger.base_sha, head_sha: ledger.new_head_sha, ...pin },
      chain: live, ledger, installed: installed.binding, timeout_seconds: installed.profile.limits.timeout_seconds,
    });
  };
  if (store.db.inTransaction) throw Error("recheck_run_nested_launch");
  const admission = store.transaction(() => {
    if (ledgers.get(recheckId).state !== "reverify_pending") return { outcome: refuse("recheck_run_state_denied") };
    const duplicate = priorAttempt();
    if (duplicate) return { outcome: duplicate };
    const verdict = verify();
    if (!verdict.ok) return { outcome: refuse(verdict.reason) };
    const invocation_id = p.randomId();
    try {
      return runs.reserve({
        recheck_id: recheckId, tree_sha: candidate.tree, grant_id: grant.grant_id, grant_digest: verdict.grant_digest,
        invocation_id, journal_ref: "journal:" + invocation_id, container_cap_seconds: verdict.recheck_timeout_seconds, now: p.now(),
      });
    } catch (error) {
      return { outcome: refuse(reservationReason(error)) };
    }
  });
  if ("outcome" in admission) return admission.outcome;
  if (!admission.created) return { status: "existing", run: admission.run };
  const reserved = admission.run;
  const { run_id, invocation_id } = reserved;
  p.fault?.("after_reserve");
  const sources = new VerificationSourceStore(store.attention, store.owner);
  let expectedState: "reserved" | "running" = "reserved";
  const fence = () => {
    store.attention.assertOwner(store.owner);
    const registration = sources.registration(ledger.original_result_id);
    if (runs.get(run_id).state !== expectedState || signal.aborted || !verify().ok ||
        registration?.registered.seq !== ledger.original_source_seq || registration.withdrawn_by)
      throw Error("recheck_run_launch_denied");
  };
  let prepared: Awaited<ReturnType<typeof prepareContainedProfileImage>>;
  let running: LocalFailureRecheckRun;
  let failure: "verify_recheck_not_started" | "verify_profile_unavailable" = "verify_recheck_not_started";
  try {
    fence();
    prepared = await (p.prepare ?? prepareContainedProfileImage)(p.imageOptions, candidate.files, installed, fence);
    if (prepared.runtimeBlockers.length) {
      failure = "verify_profile_unavailable";
      throw Error(failure);
    }
    fence();
    running = runs.start(run_id, reserved.revision);
    expectedState = "running";
  } catch {
    return store.transaction(() => {
      const current = runs.get(run_id);
      return concluded(current.state === "stopped" ? current : runs.settleNotStarted(run_id, reserved.revision, failure));
    });
  }
  const unknown = () => concluded(runs.markStopUnknown(run_id, running.revision));
  p.fault?.("after_launch_journal");
  let run: ReturnType<typeof runPreparedContainedProfile>;
  try {
    run = (p.run ?? runPreparedContainedProfile)(prepared, p.host, {
      invocationId: invocation_id,
      signal,
    });
  } catch {
    return unknown();
  }
  // A simulated process loss discards the result, including any late rejection.
  void run.catch(() => {});
  p.fault?.("mid_run");
  let observation: Awaited<typeof run>;
  try {
    observation = await run;
  } catch {
    return unknown();
  }
  const { identity, result } = observation;
  if (
    result.status === "stop_unknown" ||
    identity.invocationId !== invocation_id ||
    identity.version !== 1 ||
    identity.kind !== "contained_profile_run" ||
    identity.command !== prepared.command ||
    identity.argv_digest !== prepared.argv_digest ||
    identity.timeoutMs !== prepared.timeoutMs ||
    canonicalJson(identity.image) !== canonicalJson(prepared.image) ||
    canonicalJson(identity.outputLimits) !== canonicalJson(prepared.outputLimits) ||
    canonicalJson(identity.binding) !== canonicalJson(installed.binding) ||
    !result.stopReceipt ||
    result.stopReceipt.kind !== "docker_removed" ||
    result.stopReceipt.launch.invocationId !== invocation_id ||
    result.stopReceipt.launch.daemonId !== identity.image.daemonId ||
    result.evidence !== `docker-removed:${hash(JSON.stringify(result.stopReceipt))}`
  )
    return unknown();
  p.fault?.("before_receipt");
  const bindingRow = localFailureBindingFromLedger(running),
    finished = p.now(),
    check = installed.profile.checks[0]!;
  const resultDigest = hash(
    canonicalJson({
      exit: result.exitCode,
      stdout: result.stdout.sha256,
      stderr: result.stderr.sha256,
      termination: result.termination,
      oomKilled: result.oomKilled,
      started: result.started,
    }),
  );
  const receipt: LocalVerificationReceipt = {
    ...bindingRow,
    version: 1,
    started_at: running.started_at!,
    finished_at: finished,
    outcome: receiptOutcome(result),
    checks: [
      {
        check_id: check.check_id,
        category: check.category,
        exit_code: result.exitCode,
        result_digest: resultDigest,
      },
    ],
    bounded_redacted_summary: `stdout: ${result.stdout.observedBytes} bytes; stderr: ${result.stderr.observedBytes} bytes`,
    evidence_digest: hash(canonicalJson({ resultDigest, stop: result.evidence })),
    stop: {
      proven: true,
      proof_ref: result.evidence,
      proof_digest: hash(JSON.stringify(result.stopReceipt)),
    },
  };
  return concluded(runs.settleStopped(run_id, running.revision, {
    receipt, run_identity_digest: hash(canonicalJson(identity)),
    container_used_seconds: Math.min(running.container_cap_seconds, Math.ceil((finished - receipt.started_at) / 1000)),
  }));
}

export function recoverRecheckRuns(p: Pick<RecheckRunPorts, "store" | "now">): RecheckRecoveryReport {
  const runs = new LocalFailureRecheckRunStore(p.store, p.now);
  return p.store.transaction(() => ({
    recovered: runs.unsettled().map(row => {
      if (row.state === "reserved") return runs.settleNotStarted(row.run_id, row.revision, "verify_recheck_not_started");
      if (row.state === "running") return runs.markStopUnknown(row.run_id, row.revision);
      return row;
    }),
  }));
}
