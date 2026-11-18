import { createHash } from "node:crypto";
import type { ContainedCandidateFile, ContainedProfileRunResult } from "@osstack/agents";
import { canonicalJson, localFailureBindingFromLedger, parseStoredGrant, type LocalVerificationReceipt } from "@osstack/core";
import {
  checkGrantPrincipal,
  classifyDiagnosis,
  diagnosisCanAdmit,
  diagnosisProfile,
  parseLocalFailureRevisionGrant,
  parseVerificationProducerPolicyV1,
  verifyDiagnosisGrant,
  type DiagnosisAdmission,
  type DiagnosisRegistration,
  type DiagnosisRequest,
  type DiagnosisReason,
  type DiagnosisStore,
  type ExpectedFailure,
} from "@osstack/core/verification-intake";
import type { GrantLiveContext } from "./contained-mission-grant.js";
import {
  prepareContainedProfileImage,
  runPreparedContainedProfile,
  type ContainedProfileRunHost,
} from "./contained-mission-profile-execution.js";
import type { InstalledVerificationProfile, VerificationProfileBinding } from "./contained-mission-verification-profile.js";

type FaultPoint = "after_reserve" | "after_launch_journal" | "mid_run" | "before_receipt";
export interface DiagnosisPorts {
  store: DiagnosisStore;
  now(): number;
  keys(): GrantLiveContext["keys"];
  access: GrantLiveContext["access"];
  registration(resultId: string): Promise<Pick<DiagnosisRegistration, "contract_text" | "root_mission_id" | "chain_id">>;
  loadInstalledProfile(binding: VerificationProfileBinding): InstalledVerificationProfile;
  /** Resolve an immutable commit and return the tree and file bytes from that same Git object. */
  readCandidate(head: string): Promise<{ tree: string; files: readonly ContainedCandidateFile[] }>;
  imageOptions: Parameters<typeof prepareContainedProfileImage>[0];
  host: ContainedProfileRunHost;
  prepare?: typeof prepareContainedProfileImage;
  run?: typeof runPreparedContainedProfile;
  randomId(): string;
  fault?(step: FaultPoint): void;
}
export type DiagnosisOutcome = Extract<DiagnosisAdmission, { status: "refused" }> | {
  status: DiagnosisRequest["state"];
  request: DiagnosisRequest;
};
export interface RecoveryReport {
  recovered: DiagnosisRequest[];
}
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const outcome = (request: DiagnosisRequest): DiagnosisOutcome => ({
  status: request.state,
  request,
});
function receiptOutcome(result: Extract<ContainedProfileRunResult, { status: "stopped" }>): LocalVerificationReceipt["outcome"] {
  if (result.termination === "timeout" || result.termination === "cancelled") return result.termination;
  if (result.oomKilled || result.termination !== "exited" || !result.started) return "infrastructure_error";
  return result.exitCode === 0 ? "passed" : "reproducible_failure";
}
export async function registerDiagnosis(p: DiagnosisPorts, resultId: string, policy: unknown) {
  const config = parseVerificationProducerPolicyV1(policy);
  if (!config.ok) throw Error(config.code);
  if (!config.policy.producers.length) return { status: "closed" } as const;
  const prior = p.store.byResult(resultId);
  if (prior) return outcome(prior);
  return outcome(
    p.store.register({
      ...(await p.registration(resultId)),
      result_id: resultId,
      policy: config.policy,
    }),
  );
}
export async function runDiagnosis(p: DiagnosisPorts, id: string, signal: AbortSignal): Promise<DiagnosisOutcome> {
  const store = p.store,
    r = store.get(id);
  if (!diagnosisCanAdmit(r)) return outcome(r);
  const hold = (reason: DiagnosisReason) => outcome(store.conclude(id, r.revision, { state: "awaiting_decision", reason }));
  const chain = store.chain(r.root_mission_id, r.chain_id);
  if (!chain) return hold("verify_grant_missing");
  let grant: ReturnType<typeof parseLocalFailureRevisionGrant>;
  try {
    grant = parseLocalFailureRevisionGrant(chain.grant_json);
  } catch {
    try {
      parseStoredGrant(chain.grant_json);
    } catch {
      return hold("verify_grant_invalid");
    }
    return hold("verify_grant_missing");
  }
  try {
    checkGrantPrincipal(grant, p.access.refresh(grant.principal_id, grant.client_session_id));
  } catch {
    return hold("verify_grant_invalid");
  }
  const pin = {
    profile_id: grant.local_failure.profile_id,
    profile_digest: grant.local_failure.profile_digest,
    trusted_source: grant.local_failure.trusted_source,
  };
  let installed: InstalledVerificationProfile;
  try {
    installed = p.loadInstalledProfile(pin);
  } catch {
    return hold("verify_profile_unavailable");
  }
  let candidate: Awaited<ReturnType<DiagnosisPorts["readCandidate"]>>;
  try {
    candidate = await p.readCandidate(r.head_sha);
  } catch {
    return hold("verify_grant_invalid");
  }
  const binding = {
    repository: chain.repository,
    pr_number: chain.pr_number,
    branch: chain.branch,
    head_sha: chain.published_head,
    base_ref: chain.base_ref,
    base_sha: chain.published_base,
    tree_sha: candidate.tree,
  };
  const verify = () => {
    const current = store.chain(r.root_mission_id, chain.chain_id);
    if (!current || current.grant_json !== chain.grant_json || current.revision !== chain.revision)
      throw Error("verify_grant_invalid");
    return verifyDiagnosisGrant({
      grant_json: current.grant_json,
      keys: p.keys(),
      now: p.now(),
      budget_json: current.budget_json,
      principal: p.access.refresh(grant.principal_id, grant.client_session_id),
      request: { ...r, ...diagnosisProfile(r) },
      installed: installed.binding,
      timeout_seconds: installed.profile.limits.timeout_seconds,
      tree_sha: candidate.tree,
      candidate: { ...binding, root_mission_id: current.root_mission_id },
    });
  };
  const invocation_id = p.randomId(),
    intake_id = `lfi_${p.randomId()}`;
  if (store.db.inTransaction) throw Error("diagnosis_nested_launch");
  const admission = store.transaction(() => {
    const current = store.get(id);
    if (current.revision !== r.revision) return { outcome: outcome(current) };
    let verified: ReturnType<typeof verifyDiagnosisGrant>;
    try {
      verified = verify();
    } catch {
      return { outcome: hold("verify_grant_invalid") };
    }
    if (!verified.ok) return { outcome: hold(verified.reason) };
    if (installed.profile.checks.length !== 1 || JSON.parse(r.allowed_codes_json).length !== 1)
      return { outcome: hold("verify_profile_unavailable") };
    return store.admit(id, r.revision, {
      ...verified,
      now: p.now(),
      chain_id: chain.chain_id,
      binding,
      profile: installed.binding,
      container_cap_seconds: grant.local_failure.diagnostic_timeout_seconds,
      invocation_id,
      intake_id,
      journal_ref: `journal:${invocation_id}`,
    });
  });
  if ("outcome" in admission) return admission.outcome;
  if (admission.status === "refused") return admission;
  if (admission.intake.intake_id !== intake_id) return outcome(admission.request);
  const intake = admission.intake,
    revision = admission.request.revision;
  p.fault?.("after_reserve");
  const fence = () => {
    const journal = store.intakes.get(intake_id);
    store.attention.assertOwner(store.owner);
    if (store.withdrawn(r) || signal.aborted || !["reserved", "running"].includes(journal.state) || !verify().ok)
      throw Error("diagnosis_launch_denied");
  };
  let prepared: Awaited<ReturnType<typeof prepareContainedProfileImage>>;
  let running: ReturnType<DiagnosisStore["intakes"]["start"]>;
  try {
    fence();
    prepared = await (p.prepare ?? prepareContainedProfileImage)(p.imageOptions, candidate.files, installed, fence);
    if (prepared.runtimeBlockers.length) throw Error("diagnosis_runtime_unsupported");
    fence();
    running = store.intakes.start(intake_id, intake.revision);
  } catch {
    return store.transaction(() => {
      store.intakes.settleNotStarted(intake_id, intake.revision);
      return outcome(
        store.conclude(
          id,
          revision,
          store.withdrawn(r)
            ? { state: "diagnostic_closed", reason: "verify_withdrawn" }
            : {
                state: "awaiting_decision",
                reason: "verify_infrastructure_error",
              },
        ),
      );
    });
  }
  const unknown = () =>
    store.transaction(() => {
      store.intakes.markStopUnknown(intake_id, running.revision, "verify_stop_unproven");
      return outcome(
        store.conclude(id, revision, {
          state: "awaiting_decision",
          reason: "verify_stop_unproven",
        }),
      );
    });
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
  return store.transaction(() => {
    store.intakes.settleStopped(intake_id, running.revision, {
      outcome: receipt.outcome,
      container_used_seconds: Math.min(intake.container_cap_seconds, Math.ceil((finished - receipt.started_at) / 1000)),
      receipt_json: JSON.stringify({ result_digest: resultDigest }),
      evidence_digest: receipt.evidence_digest,
      proof_ref: receipt.stop.proof_ref,
      proof_digest: receipt.stop.proof_digest,
    });
    store.recordReceipt(id, receipt, hash(canonicalJson(identity)));
    const verdict = classifyDiagnosis({
      receipt,
      binding: bindingRow,
      profileChecks: installed.profile.checks,
      expected_failures: JSON.parse(r.expected_failures_json) as ExpectedFailure[],
      allowed_failure_codes: JSON.parse(r.allowed_codes_json),
      termination: result.termination,
      oomKilled: result.oomKilled,
    });
    return outcome(
      store.conclude(
        id,
        store.get(id).revision,
        store.withdrawn(r) ? { state: "diagnostic_closed", reason: "verify_withdrawn" } : verdict,
      ),
    );
  });
}
export function recoverDiagnoses(p: DiagnosisPorts): RecoveryReport {
  const s = p.store;
  return s.transaction(() => ({
    recovered: s.admitted().map((r) => {
      const i = s.intakes.get(r.intake_id!);
      let reason: DiagnosisReason = "verify_receipt_binding_invalid";
      switch (i.state) {
        case "reserved":
          s.intakes.settleNotStarted(i.intake_id, i.revision);
          reason = "verify_infrastructure_error";
          break;
        case "running":
          s.intakes.markStopUnknown(i.intake_id, i.revision, "verify_stop_unproven");
          reason = "verify_stop_unproven";
          break;
        case "stop_unknown":
          reason = "verify_stop_unproven";
          break;
        case "stopped":
          break;
      }
      return s.conclude(r.request_id, r.revision, {
        state: "awaiting_decision",
        reason,
      });
    }),
  }));
}
