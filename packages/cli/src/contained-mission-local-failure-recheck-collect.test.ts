import { createHash, randomUUID } from "node:crypto";
import { ContainedMissionStore, localFailureBindingFromLedger, RevisionChainStore } from "@osstack/core";
import { diagnosisFixture, eligibleRequest } from "@osstack/core/dist/state/diagnosis-fixtures.js";
import {
  verificationFixture,
  passedVerificationFixture,
} from "@osstack/core/dist/bridge/verification-result-fixtures.js";
import {
  LocalFailureDispatchStore,
  LocalFailureRecheckRunStore,
  LocalFailureRecheckStore,
  parseVerificationResultV1,
  verificationDedupKey,
  type HostRecheckProof,
  type ActionsAttemptFact,
} from "@osstack/core/verification-intake";
import { afterEach, expect, it, vi } from "vitest";
import { collectLocalFailureRecheck } from "./contained-mission-local-failure-recheck-collect.js";

const cleanup: (() => void)[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0)) close();
});
function fixture() {
  const f = diagnosisFixture({ allowedPaths: ["src/a.ts"] });
  cleanup.push(f.close);
  const request = eligibleRequest(f);
  const now = () => f.facts.now;
  const d = new LocalFailureDispatchStore(f.store).dispatch({
    request_id: request.request_id,
    now,
    verify: () => ({ grant_digest: f.facts.grant_digest, principal: f.principal, check_ids: ["fixture-check"] }),
    launchCaps: { executor_seconds: 3, verify_seconds: 2 },
    locations: ["src/a.ts"],
    withinAllowed: (p, allowed) => allowed.includes(p),
    checkPaths: () => null,
    buildChild: ({ goal, binding }) => ({
      spec: { goal, publication: { preauthorized: false }, local_failure_repair: binding },
      claim: { branch: "child", repo_identity: "fixture", worktree_identity: "child" },
    }),
  });
  if (d.status !== "dispatched") throw Error(d.reason);
  const store = new ContainedMissionStore(f.attention, f.owner);
  const chains = new RevisionChainStore(f.attention, f.owner);
  const head = "e".repeat(40),
    child = d.child_mission_id;
  f.db.transaction(() => {
    store.record(
      child,
      "verify_repair_push_confirmed",
      {
        candidate: head,
        previous: request.head_sha,
        base: request.base_sha,
        branch: chains.get(f.facts.chain_id).branch,
      },
      now(),
    );
    chains.confirmLocalRepairPush({ child_mission_id: child, new_head: head }, now());
  })();
  const add = (failed = false, candidate = head, attempt = 1, supersedes: string | null = null) => {
    const wire = {
      ...(failed ? verificationFixture() : passedVerificationFixture()),
      result_id: randomUUID(),
      head_sha: candidate,
      attempt,
      supersedes_result_id: supersedes,
    };
    wire.dedup_key = verificationDedupKey(wire);
    const text = JSON.stringify(wire),
      parsed = parseVerificationResultV1(text);
    if (!parsed.ok) throw Error(parsed.code);
    const digest = createHash("sha256").update(text).digest("hex");
    const [row] = f.source.record(
      [
        {
          source_kind: "check_run",
          object_id: attempt + 1,
          repository_id: wire.repository_id,
          repository: wire.repository,
          pr: wire.pr,
          observed_head_sha: candidate,
          app_id: 201,
          check_name: "fixture",
          response_digest: digest,
          contract_digest: digest,
          verdict: { ok: true },
          result: parsed.result,
        },
      ],
      now(),
      now(),
    );
    expect(row?.outcome.decision).toBe("accepted");
    return { text, seq: row!.seq!, id: wire.result_id };
  };
  const deps = {
    store,
    now,
    readOriginalContract: vi.fn(async (): Promise<string | null> => f.input.contract_text),
    readRecheckContracts: vi.fn(async (): Promise<readonly string[] | null> => null),
    readActions: vi.fn(async (): Promise<ActionsAttemptFact | null> => null),
    hostProof: vi.fn((_id: string): HostRecheckProof | null => null),
  };
  const actions: ActionsAttemptFact = {
    head_sha: head,
    attempt: 3,
    complete: true,
    conclusion: "success",
    digest: "a".repeat(64),
  };
  const snapshot = () =>
    ["contained_missions", "local_failure_dispatches", "revision_chain_events"].map((t) =>
      f.db.prepare("SELECT * FROM engineering_" + t).all(),
    );
  return { f, deps, child, add, actions, snapshot, collect: () => collectLocalFailureRecheck(deps, child) };
}

it("opens once, presents the newest accepted text and replays on a fresh store handle", async () => {
  const { f, deps, child, collect, add, actions, snapshot } = fixture();
  const before = snapshot();
  expect(await collect()).toMatchObject({
    opened: true,
    recheck: { state: "reverify_pending", missing_json: '["result","actions","host"]' },
  });
  const older = add(),
    latest = add(false, actions.head_sha, 2, older.id);
  deps.readRecheckContracts.mockResolvedValue([latest.text, older.text]);
  deps.readActions.mockResolvedValue(actions);
  const spy = vi.spyOn(LocalFailureRecheckStore.prototype, "evaluate");
  const report = await collect();
  expect(report).toMatchObject({
    opened: false,
    presented: { result: true, actions: true, host: false },
    recheck: {
      state: "reverify_pending",
      missing_json: '["host"]',
      recheck_result_id: latest.id,
      recheck_source_seq: latest.seq,
      actions_attempt: 3,
      actions_digest: actions.digest,
    },
  });
  const standIn = {} as HostRecheckProof;
  deps.hostProof.mockReturnValue(standIn);
  const replay = await collectLocalFailureRecheck(
    { ...deps, store: new ContainedMissionStore(f.attention, f.owner) },
    child,
  );
  const input = spy.mock.lastCall![0];
  expect(input.result).toEqual({ source_seq: latest.seq, contract_text: latest.text });
  expect(input.actions).toBe(actions);
  expect(input.host).toBe(standIn);
  expect(replay.recheck).toEqual(report.recheck);
  expect(deps.readOriginalContract).toHaveBeenCalledTimes(1);
  expect(snapshot()).toEqual(before);
});
it("passes only when the collector presents the result, Actions and a settled host proof", async () => {
  const { f, deps, child, collect, add, actions } = fixture();
  const opened = await collect();
  expect(opened.opened).toBe(true);
  const row = opened.recheck!;
  f.db.prepare(
    "UPDATE engineering_contained_missions SET state='failed',stop_obligation=0,revision=revision+1 WHERE mission_id=?",
  ).run(child);
  const runs = new LocalFailureRecheckRunStore(f.store, deps.now);
  const { run } = runs.reserve({
    recheck_id: row.recheck_id,
    tree_sha: "a".repeat(40),
    grant_id: f.facts.grant.grant_id,
    grant_digest: f.facts.grant_digest,
    invocation_id: randomUUID(),
    journal_ref: "recheck",
    container_cap_seconds: 12,
    now: deps.now(),
  });
  const running = runs.start(run.run_id, run.revision);
  runs.settleStopped(running.run_id, running.revision, {
    container_used_seconds: 2,
    run_identity_digest: "4".repeat(64),
    receipt: {
      ...localFailureBindingFromLedger(running),
      version: 1,
      started_at: running.started_at!,
      finished_at: deps.now(),
      outcome: "passed",
      checks: [{ check_id: row.failed_check_id, category: "test", exit_code: 0, result_digest: "1".repeat(64) }],
      bounded_redacted_summary: "fixture",
      evidence_digest: "2".repeat(64),
      stop: { proven: true, proof_ref: "stop", proof_digest: "3".repeat(64) },
    },
  });
  deps.hostProof.mockImplementation((id) => runs.hostProof(id));
  deps.readActions.mockResolvedValue(actions);
  expect((await collect()).recheck).toMatchObject({ state: "reverify_pending", missing_json: '["result"]' });

  deps.readRecheckContracts.mockResolvedValue([add().text]);
  deps.readActions.mockResolvedValueOnce(null);
  expect((await collect()).recheck).toMatchObject({ state: "reverify_pending", missing_json: '["actions"]' });

  const evaluate = vi.spyOn(LocalFailureRecheckStore.prototype, "evaluate");
  const passed = await collect();
  expect(passed).toMatchObject({
    presented: { result: true, actions: true, host: true },
    recheck: { state: "recheck_passed" },
  });
  expect(evaluate.mock.lastCall![0].host).toBe(deps.hostProof.mock.results.at(-1)!.value);
  vi.clearAllMocks();
  expect((await collect()).recheck).toEqual(passed.recheck);
  for (const port of [deps.readOriginalContract, deps.readRecheckContracts, deps.readActions, deps.hostProof])
    expect(port).not.toHaveBeenCalled();
});
it.each(["digest", "head", "too many", "oversized", "throws"])("ignores result when %s", async (mode) => {
  const { deps, collect, add, actions } = fixture();
  const { text } = add(false, mode === "head" ? "c".repeat(40) : actions.head_sha);
  deps.readRecheckContracts.mockResolvedValue(
    mode === "digest"
      ? [text + " "]
      : mode === "too many"
        ? Array(21).fill(text)
        : mode === "oversized"
          ? [text, "界".repeat(90000)]
          : [text],
  );
  if (mode === "throws") deps.readRecheckContracts.mockRejectedValue(Error());
  deps.readActions.mockResolvedValue(actions);
  expect((await collect()).recheck?.missing_json).toBe('["result","host"]');
});
it.each(["absent", "incomplete", "pending", "wrong head", "throws"])("leaves actions missing for %s", async (mode) => {
  const { deps, collect, add, actions } = fixture();
  deps.readRecheckContracts.mockResolvedValue([add().text]);
  if (mode === "incomplete") deps.readActions.mockResolvedValue({ ...actions, complete: false });
  if (mode === "pending") deps.readActions.mockResolvedValue({ ...actions, conclusion: "pending" });
  if (mode === "wrong head") deps.readActions.mockResolvedValue({ ...actions, head_sha: "0".repeat(40) });
  if (mode === "throws") deps.readActions.mockRejectedValue(Error());
  deps.hostProof.mockImplementation(() => {
    throw Error();
  });
  expect((await collect()).recheck).toMatchObject({ state: "reverify_pending", missing_json: '["actions","host"]' });
});
it("seals a failed result and skips all ports on replay", async () => {
  const { deps, collect, add } = fixture();
  deps.readRecheckContracts.mockResolvedValue([add(true).text]);
  const report = await collect();
  expect(report.recheck).toMatchObject({ state: "awaiting_decision", reason: "verify_recheck_failed" });
  vi.clearAllMocks();
  expect((await collect()).recheck).toEqual(report.recheck);
  for (const port of [deps.hostProof, deps.readActions, deps.readRecheckContracts, deps.readOriginalContract])
    expect(port).not.toHaveBeenCalled();
});
it.each(["null", "throw", "wrong digest", "unknown"])("writes nothing for %s", async (mode) => {
  const { deps, collect, f } = fixture();
  const writes = () => f.db.prepare("SELECT total_changes() AS n").get();
  const before = writes();
  if (mode === "unknown")
    await expect(collectLocalFailureRecheck(deps, "missing")).rejects.toThrow("verify_recheck_unknown_child");
  else {
    deps.readOriginalContract.mockResolvedValue(mode === "wrong digest" ? f.input.contract_text + " " : null);
    if (mode === "throw") deps.readOriginalContract.mockRejectedValue(Error());
    expect(await collect()).toEqual({
      opened: false,
      recheck: null,
      code: mode === "wrong digest" ? "verify_recheck_binding_invalid" : "verify_recheck_missing",
    });
  }
  expect(writes()).toEqual(before);
});

it("reports one opener when original reads overlap and reads every port outside a transaction", async () => {
  const { f, deps, child } = fixture();
  const signal = new AbortController().signal;
  const ports = { ...deps, signal };
  const inTransaction: boolean[] = [];
  const recordRead = () => inTransaction.push(f.db.inTransaction);
  deps.readOriginalContract.mockImplementation(async () => {
    recordRead();
    return f.input.contract_text;
  });
  deps.readRecheckContracts.mockImplementation(async () => {
    recordRead();
    return null;
  });
  deps.readActions.mockImplementation(async () => {
    recordRead();
    return null;
  });
  deps.hostProof.mockImplementation(() => {
    recordRead();
    return null;
  });
  const reports = await Promise.all([
    collectLocalFailureRecheck(ports, child),
    collectLocalFailureRecheck(ports, child),
  ]);
  expect(inTransaction).toEqual(Array(8).fill(false));
  expect(reports.map((r) => r.opened).sort()).toEqual([false, true]);
  expect(reports[0]!.recheck).toEqual(reports[1]!.recheck);
  const row = reports[0]!.recheck!;
  const target = {
    repository: row.repository,
    repository_id: row.repository_id,
    pr: row.pr_number,
    head: row.new_head_sha,
  };
  expect(deps.readOriginalContract).toHaveBeenCalledWith(
    {
      result_id: row.original_result_id,
      source_seq: row.original_source_seq,
      repository_id: row.repository_id,
      pr: row.pr_number,
    },
    signal,
  );
  expect(deps.readRecheckContracts).toHaveBeenCalledWith({ ...target, base_sha: row.base_sha }, signal);
  expect(deps.readActions).toHaveBeenCalledWith({ ...target, base: row.base_sha, branch: f.v.branch }, signal);
  expect(deps.hostProof).toHaveBeenCalledWith(row.recheck_id);
});
