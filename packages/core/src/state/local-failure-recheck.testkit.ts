import { LocalFailureRecheckRunStore, type LocalFailureRecheckRun } from "./engineering-local-failure-recheck-run-store.js";
import { localFailureBindingFromLedger, type LocalVerificationReceipt } from "../bridge/local-failure.js";
import { LocalFailureRecheckStore } from "./engineering-local-failure-recheck-store.js";
import { randomUUID, createHash } from "node:crypto";
import { parseVerificationResultV1, verificationDedupKey } from "../bridge/verification-result.js";
import { passedVerificationFixture } from "../bridge/verification-result-fixtures.js";
import { onTestFinished, expect } from "vitest";
import { diagnosisFixture, eligibleRequest } from "./diagnosis-fixtures.js";
import { LocalFailureDispatchStore, type DispatchInput } from "./engineering-local-failure-dispatch-store.js";
import { RevisionChainStore } from "./engineering-revision-chain-store.js";
import { ContainedMissionStore } from "./engineering-contained-store.js";
export function fixture(options: Parameters<typeof diagnosisFixture>[0] = {}) {
  const f = diagnosisFixture({ allowedPaths: ["src/a.ts"], ...options });
  onTestFinished(f.close);
  const r = eligibleRequest(f);
  const store = new LocalFailureDispatchStore(f.store);
  const input: DispatchInput = {
    request_id: r.request_id,
    now: () => f.facts.now,
    verify: () => {
      expect(f.db.inTransaction).toBe(true);
      return {
        grant_digest: f.facts.grant_digest,
        principal: f.principal,
        check_ids: ["fixture-check"],
      };
    },
    launchCaps: { executor_seconds: 3, verify_seconds: 2 },
    locations: ["src/a.ts"],
    withinAllowed: (path, allowed) => allowed.includes(path),
    checkPaths: () => null,
    buildChild: ({ goal, binding }) => ({
      spec: {
        goal,
        publication: { preauthorized: false },
        local_failure_repair: binding,
      },
      claim: {
        branch: "child",
        repo_identity: "fixture",
        worktree_identity: "child",
      },
    }),
  };
  const snapshot = () =>
    [
      "contained_missions",
      "mission_lineage",
      "host_receipts",
      "revision_chains",
      "local_failure_dispatches",
      "diagnosis_requests",
      "local_failure_intakes",
    ].map((t) => f.db.prepare("SELECT * FROM engineering_" + t).all());
  return { f, r, store, input, snapshot };
}

export function record(f: ReturnType<typeof diagnosisFixture>, wire: unknown, objectId = 2) {
  const text = JSON.stringify(wire),
    parsed = parseVerificationResultV1(text);
  if (!parsed.ok) throw Error(parsed.code);
  const result = parsed.result,
    digest = createHash("sha256").update(text).digest("hex");
  expect(
    f.source.record(
      [
        {
          source_kind: "check_run",
          object_id: objectId,
          repository_id: result.repository_id,
          repository: result.repository,
          pr: result.pr,
          observed_head_sha: result.head_sha,
          app_id: 201,
          check_name: "fixture",
          response_digest: digest,
          contract_digest: digest,
          verdict: { ok: true },
          result,
        },
      ],
      2,
      2,
    )[0]?.outcome.decision,
  ).toBe("accepted");
  return text;
}

export function dispatchedRepair(options: Parameters<typeof diagnosisFixture>[0] = {}) {
  const { f, r, store, input } = fixture(options);
  const dispatch = store.dispatch(input);
  if (dispatch.status !== "dispatched") throw Error(dispatch.reason);
  const chains = new RevisionChainStore(f.attention, f.owner);
  const chain = () => chains.get(r.chain_id!);
  const missions = new ContainedMissionStore(f.attention, f.owner);
  const payload = {
    candidate: "e".repeat(40), previous: r.head_sha, base: r.base_sha, branch: chain().branch,
  };
  const child = dispatch.child_mission_id;
  const confirm = (id = child) => chains.confirmLocalRepairPush({ child_mission_id: id, new_head: payload.candidate }, input.now());
  const recordConfirmation = (data = payload, id = child) => missions.record(id, "verify_repair_push_confirmed", data, input.now());
  const events = () => chains.events(r.chain_id!);
  return { f, r, dispatch: { ...dispatch }, chain, payload, confirm, recordConfirmation, events };
}


export function publishedRecheck(options: Parameters<typeof diagnosisFixture>[0] = {}) {
  const d = dispatchedRepair(options);
  const { f, dispatch, payload } = d;
  const ledger = new LocalFailureRecheckStore(f.store);
  const now = f.facts.now;
  const open = () => ledger.open({ child_mission_id: dispatch.child_mission_id, original_contract_text: f.input.contract_text, now });
  const add = (patch = {}, objectId = 2) => {
    const wire = { ...passedVerificationFixture(), result_id: randomUUID(), head_sha: payload.candidate, ...patch };
    wire.dedup_key = verificationDedupKey(wire);
    const contract_text = record(f, wire, objectId);
    return { contract_text, source_seq: f.source.registration(wire.result_id)!.registered.seq };
  };
  return { ...d, ledger, now, open, add };
}
export function runFixture(d: ReturnType<typeof publishedRecheck>, row: ReturnType<typeof d.open>) {
  const { f } = d;
  f.db.prepare("UPDATE engineering_contained_missions SET state='failed',stop_obligation=0,revision=revision+1 WHERE mission_id=?").run(d.dispatch.child_mission_id);
  const runs = new LocalFailureRecheckRunStore(f.store, () => d.now);
  const input = { recheck_id: row.recheck_id, tree_sha: f.facts.binding.tree_sha, grant_id: f.facts.grant.grant_id,
    grant_digest: f.facts.grant_digest, invocation_id: randomUUID(), journal_ref: "recheck", container_cap_seconds: 12, now: d.now };
  const receipt = (run: LocalFailureRecheckRun, outcome: LocalVerificationReceipt["outcome"] = "passed"): LocalVerificationReceipt => ({
    ...localFailureBindingFromLedger(run), version: 1, started_at: run.started_at!, finished_at: run.started_at!, outcome,
    checks: [{ check_id: row.failed_check_id, category: "test", exit_code: outcome === "passed" ? 0 : 1, result_digest: "1".repeat(64) }],
    bounded_redacted_summary: "fixture", evidence_digest: "2".repeat(64), stop: { proven: true, proof_ref: "stop", proof_digest: "3".repeat(64) },
  });
  const settle = (run: LocalFailureRecheckRun, outcome?: LocalVerificationReceipt["outcome"]) =>
    runs.settleStopped(run.run_id,run.revision,{ receipt: receipt(run,outcome), container_used_seconds: 2, run_identity_digest: "4".repeat(64) });
  return { runs, input, receipt, settle };
}
