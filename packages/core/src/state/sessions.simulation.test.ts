// OSSTACK_SIMULATION_STEPS=100000 pnpm --filter @osstack/core exec vitest run src/state/sessions.simulation.test.ts
// With fsync disabled, a restart models process/object loss, not power loss.
// S1 Each execution needs an authorized hand-off.
// S2 Automatic replay preserves uncertain receipts without executing.
// S3 Applied replay preserves the result and every stored row.
// S4 Terminal states, version guards, counts and turn ordinals match the model.
// S5 Admission and completion timestamps survive clock changes.
import { rmSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createScratchDirSync } from "../scratch.js";
import { chance, FaultPlan, pick, simulationConfig, Trace } from "../testing/seeded-simulation.testkit.js";
import { openDb } from "./db.js";
import { insertRun, insertTask } from "./run-store.js";
import {
  type CompleteInboundTurnInput, SessionMessageIdConflict, type SessionMessageInput,
  SessionRepository, SessionVersionConflict,
} from "./sessions.js";

type Db = ReturnType<typeof openDb>;
type Factory = (db: Db, path: string) => SessionRepository;
type RelayRepo = Pick<SessionRepository, "getMessage" | "applyInbound" | "completeInboundTurn"
  | "markMessageApplied" | "markMessageFailed" | "retryFailedMessage" | "getSession">;
type SendFault = "none" | "executor_failure" | "lost_response" | "restart_mid_step";
type Model = {
  input: SessionMessageInput;
  state: "accepted" | "applied" | "failed";
  handoffs: number;
  uncertain: boolean;
  appliedAt: number | null;
  result: string | null;
  completion?: CompleteInboundTurnInput;
};

type MessageIdentity = Pick<SessionMessageInput, "message_id" | "session_id">;

function completion(input: MessageIdentity, version: number, ordinal: number, now: number, text: string): CompleteInboundTurnInput {
  return {
    message_id: input.message_id, expected_version: version, applied_at: now,
    turn: { turn_id: "turn-" + input.message_id, session_id: input.session_id, ordinal, state: "idle",
      assistant_text: text, decision: null, created_at: now, updated_at: now },
  };
}

class RelayDriver {
  constructor(
    readonly repo: RelayRepo, readonly db: Db, readonly executor: { run(id: string): string },
    readonly restart: () => void,
  ) {}

  private complete(input: MessageIdentity, version: number, now: number, text: string) {
    const ordinal = this.db.prepare("SELECT coalesce(max(ordinal),0)+1 FROM session_turns WHERE session_id=?")
      .pluck().get(input.session_id) as number;
    return this.repo.completeInboundTurn(completion(input, version, ordinal, now, text));
  }

  send(input: SessionMessageInput, expectedVersion: number, now: number, fault: SendFault) {
    const existing = this.repo.getMessage(input.message_id);
    let receipt: ReturnType<RelayRepo["applyInbound"]>;
    try {
      receipt = this.repo.applyInbound(input, expectedVersion, now);
    } catch (error) {
      if (error instanceof SessionMessageIdConflict) return { kind: "message_id_conflict" } as const;
      if (error instanceof SessionVersionConflict) return { kind: "version_conflict" } as const;
      throw error;
    }
    if (receipt.outcome === "duplicate") {
      if (existing?.state !== "applied") return { kind: "delivery_uncertain" } as const;
      const result = this.db.prepare("SELECT assistant_text FROM session_turns WHERE session_id=? AND turn_id=?")
        .pluck().get(input.session_id, "turn-" + input.message_id) ?? null;
      return { kind: "applied", ...receipt, result } as const;
    }

    const text = this.executor.run(input.message_id);
    if (fault === "restart_mid_step") this.restart();
    if (fault === "lost_response" || fault === "restart_mid_step") return { kind: "delivery_uncertain" } as const;
    if (fault === "executor_failure") {
      this.repo.markMessageFailed(input.message_id);
      return { kind: "delivery_failed" } as const;
    }
    const session = this.complete(input, receipt.session_version, now, text);
    return { kind: "applied", outcome: receipt.outcome, session_version: session.version, result: text } as const;
  }

  reconcileApplied(id: string, now: number) { this.repo.markMessageApplied(id, now); }
  reconcileFailed(id: string) { this.repo.markMessageFailed(id); }
  operatorRetry(id: string, now: number) {
    this.repo.retryFailedMessage(id);
    const input = this.repo.getMessage(id)!;
    const version = this.repo.getSession(input.session_id)!.version;
    this.complete(input, version, now, this.executor.run(id));
  }
}

type InboundArgs = Parameters<SessionRepository["applyInbound"]>;
function readmit(state: "applied" | "accepted"): Factory {
  return (db, path) => new class extends SessionRepository {
    override applyInbound(...args: InboundArgs) {
      const receipt = super.applyInbound(...args);
      if (receipt.outcome === "duplicate" && this.getMessage(args[0].message_id)?.state === state) {
        return { ...receipt, outcome: "applied" as const };
      }
      return receipt;
    }
  }(db, path);
}
const mutants: { id: string; name: string; factory: Factory }[] = [
  { id: "S1", name: "readmits an applied message", factory: readmit("applied") },
  { id: "S2", name: "readmits an accepted message", factory: readmit("accepted") },
  { id: "S3", name: "replay changes storage", factory: (db, path) => new class extends SessionRepository {
    override applyInbound(...args: InboundArgs) {
      const receipt = super.applyInbound(...args);
      if (receipt.outcome === "duplicate" && this.getMessage(args[0].message_id)?.state === "applied") {
        db.prepare("UPDATE agent_sessions SET version=version+1 WHERE session_id=?").run(args[0].session_id);
      }
      return receipt;
    }
  }(db, path) },
  { id: "S4", name: "terminal state reopened", factory: (db, path) => new class extends SessionRepository {
    override markMessageFailed(id: string) {
      if (this.getMessage(id)?.state === "applied") {
        db.prepare("UPDATE session_messages SET state='failed' WHERE message_id=?").run(id);
      } else super.markMessageFailed(id);
    }
  }(db, path) },
  { id: "S5", name: "duplicate rewrites history", factory: (db, path) => new class extends SessionRepository {
    override applyInbound(...args: InboundArgs) {
      const receipt = super.applyInbound(...args);
      if (receipt.outcome === "duplicate") {
        db.prepare("UPDATE session_messages SET created_at=? WHERE message_id=?").run(args[2], args[0].message_id);
      }
      return receipt;
    }
  }(db, path) },
];

async function simulate(seed: number, steps: number, factory: Factory = (db, path) => new SessionRepository(db, path)) {
  const root = createScratchDirSync("tests", "session-simulation");
  const path = join(root, "state.db");
  let traceFailure: Error | undefined;
  const trace = new class extends Trace {
    override failure(cause: unknown): Error {
      traceFailure = super.failure(cause);
      return traceFailure;
    }
  }(seed);
  const plan = new FaultPlan(seed);
  const { next } = plan;
  const coverage = new Set<string>();
  const runs = new Map<string, number>();
  const executor = { run(id: string) {
    runs.set(id, (runs.get(id) ?? 0) + 1);
    return "answer to " + id;
  } };
  function connect() {
    const db = openDb({ path });
    db.pragma("synchronous = OFF");
    const repo = factory(db, path);
    return { db, repo, driver: new RelayDriver(repo, db, executor, restart) };
  }
  let world = connect();
  function restart() { world.db.close(); world = connect(); }

  let session = "";
  let version = 1;
  let ordinal = 0;
  let now = 1_000_000_000;
  const rows: Model[] = [];
  const snapshot = () => JSON.stringify([
    world.db.prepare("SELECT * FROM agent_sessions WHERE session_id=?").get(session),
    world.db.prepare("SELECT * FROM session_messages WHERE session_id=? ORDER BY message_id").all(session),
    world.db.prepare("SELECT * FROM session_turns WHERE session_id=? ORDER BY ordinal").all(session),
  ]);
  function rejected(fn: () => unknown, detail: string, stale = false) {
    const before = snapshot();
    let error: unknown;
    try { fn(); } catch (cause) { error = cause; }
    trace.check(error instanceof Error && (!stale || error instanceof SessionVersionConflict), "S4", detail);
    trace.check(snapshot() === before, "S4", "rejection changed storage");
  }
  function completed(row: Model) {
    row.result = "answer to " + row.input.message_id;
    row.completion = completion(row.input, version, ++ordinal, now, row.result);
    row.state = "applied";
    row.uncertain = false;
    row.appliedAt = now;
    version++;
  }

  try {
    insertTask(world.db, path, { task_id: "task", title: "simulation", created_at: 1 });
    insertRun(world.db, path, { run_id: "run", task_id: "task", session_id: "session", agent_id: "fake",
      capability_id: "code", phase: "execute", started_at: 1 });
    for (let step = 0; step < steps; step++) {
      if (step % 256 === 0) await new Promise<void>(resolve => setImmediate(resolve));
      if (step % 64 === 0) {
        session = "s" + step;
        rows.length = 0;
        runs.clear();
        version = 1;
        ordinal = 0;
        world.repo.createSession({ session_id: session, task_id: "task", run_id: "run", agent_id: "fake",
          request_sha256: "a".repeat(64), native_session_id: "native", repo_path: root, state: "idle",
          resume_supported: true, version, updated_at: now });
      }
      const fault = plan.fault();
      now += fault === "clock_backwards" ? -100 : 1;
      function record(command: string, kind: string) { trace.record({ step, fault, command, kind, version }); }
      function fresh(faultAfterExecution: SendFault, requireCompletion = false) {
        const mode = !requireCompletion && chance(next, 8) ? "executor_failure" : faultAfterExecution;
        const input: SessionMessageInput = { message_id: "m" + step, session_id: session, turn_id: "initial",
          direction: "inbound", kind: "instruction.send", payload: { text: "instruction " + step }, state: "accepted", created_at: now };
        const before = snapshot();
        const stale = world.driver.send(input, version - 1, now, "none");
        record("stale-send", stale.kind);
        trace.check(stale.kind === "version_conflict" && !runs.has(input.message_id) && snapshot() === before, "S4", "stale admission");
        const reply = world.driver.send(input, version, now, mode);
        version++;
        const row: Model = { input, state: "accepted", handoffs: 1, uncertain: mode !== "none", appliedAt: null, result: null };
        rows.push(row);
        if (mode === "none") completed(row);
        if (mode === "executor_failure") row.state = "failed";
        record("send-" + mode, reply.kind);
        trace.check(runs.get(input.message_id) === 1, "S1", "fresh hand-off missing");
        if (mode === "none") {
          trace.check(reply.kind === "applied" && reply.outcome === "applied" && reply.result === row.result
            && reply.session_version === version, "S3", "fresh result");
        } else if (mode === "executor_failure") {
          trace.check(reply.kind === "delivery_failed", "S2", "failure receipt");
          coverage.add("executor:failed");
        } else {
          trace.check(reply.kind === "delivery_uncertain", "S2", "uncertain receipt");
          coverage.add(fault + ":uncertain");
        }
        return row;
      }
      function replay(row: Model) {
        const id = row.input.message_id;
        const before = snapshot();
        const count = runs.get(id);
        record("replay-" + id, "sending");
        let reply: ReturnType<RelayDriver["send"]>;
        try {
          reply = world.driver.send({ ...row.input, created_at: now }, 0, now, "none");
        } finally {
          // Observe the hand-off even when the repository then refuses a second completion.
          if (row.uncertain) trace.check(runs.get(id) === count, "S2", "automatic replay of uncertain receipt");
          trace.check(runs.get(id)! <= row.handoffs, "S1", "execution exceeded authorized hand-offs");
        }
        record("replay-" + id, reply.kind);
        if (row.uncertain) {
          trace.check(reply.kind === "delivery_uncertain" && world.repo.getMessage(id)?.state === row.state,
            "S2", "uncertain receipt changed");
        }
        const actual = world.repo.getMessage(id)!;
        trace.check(actual.created_at === row.input.created_at && actual.applied_at === row.appliedAt, "S5", "historical timestamp changed");
        if (!row.uncertain) {
          trace.check(reply.kind === "applied" && reply.outcome === "duplicate" && reply.session_version === version
            && reply.result === row.result, "S3", "replayed result changed");
        }
        trace.check(snapshot() === before, row.uncertain ? "S2" : "S3", "duplicate changed storage");
      }

      if (fault === "duplicate_submission") {
        const row = rows.length ? pick(next, rows) : fresh("none");
        replay(row);
        coverage.add("duplicate_submission:duplicate");
        const before = snapshot();
        const reply = world.driver.send({ ...row.input, payload: { text: "other" } }, version, now, "none");
        record("conflicting-payload", reply.kind);
        trace.check(reply.kind === "message_id_conflict" && snapshot() === before, "S4", "collision changed storage or result");
        coverage.add("duplicate_submission:conflict");
      } else if (fault === "lost_response") {
        const uncertain = rows.filter(row => row.uncertain);
        if (uncertain.length && chance(next, 2)) {
          const row = pick(next, uncertain);
          const id = row.input.message_id;
          if (row.state === "failed") {
            world.driver.operatorRetry(id, now);
            row.handoffs++;
            completed(row);
            trace.check(runs.get(id) === row.handoffs, "S1", "operator hand-off missing");
            record("operator-retry", "applied");
            coverage.add("operator:retry");
          } else if (chance(next, 2)) {
            world.driver.reconcileApplied(id, now);
            row.state = "applied";
            row.appliedAt = now;
            row.uncertain = false;
            record("operator-reconcile", "applied");
          } else {
            world.driver.reconcileFailed(id);
            row.state = "failed";
            record("operator-reconcile", "failed");
          }
        } else fresh("lost_response");
      } else if (fault === "restart_mid_step") {
        if (rows.length && chance(next, 3)) {
          restart();
          record("restart", "reopened");
          replay(pick(next, rows));
        } else fresh("restart_mid_step");
      } else if (fault === "late_result") {
        const row = rows.length ? pick(next, rows) : fresh("lost_response");
        const stale = row.state === "accepted";
        const late = completion(row.input, stale ? version - 1 : version, ordinal + 1, now, "late");
        late.turn.turn_id = "late-" + step;
        record("late-result", "arrived");
        rejected(() => world.repo.completeInboundTurn(late), "late completion accepted", stale);
        record("late-result", "rejected");
        coverage.add("late_result:rejected");
      } else if (fault === "duplicate_answer") {
        const finished = rows.filter(row => row.completion);
        const row = finished.length ? pick(next, finished) : fresh("none", true);
        record("duplicate-answer", "arrived");
        rejected(() => world.repo.completeInboundTurn(row.completion!), "duplicate completion accepted");
        record("duplicate-answer", "rejected");
        coverage.add("duplicate_answer:rejected");
      } else {
        if (rows.length && chance(next, 2)) replay(pick(next, rows));
        else fresh("none");
        coverage.add("clock_backwards:send");
      }

      const guarded = pick(next, rows);
      const id = guarded.input.message_id;
      if (guarded.state === "applied") {
        rejected(() => world.repo.markMessageApplied(id, now), "markMessageApplied accepted an applied receipt");
        rejected(() => world.repo.markMessageFailed(id), "markMessageFailed accepted an applied receipt");
      }
      if (guarded.state !== "failed") rejected(() => world.repo.retryFailedMessage(id), "retry accepted a non-failed receipt");
      const stored = world.db.prepare("SELECT message_id,state,created_at,applied_at FROM session_messages WHERE session_id=? ORDER BY message_id")
        .all(session) as { message_id: string; state: string; created_at: number; applied_at: number | null }[];
      const byId = new Map(stored.map(row => [row.message_id, row]));
      trace.check(stored.length === rows.length && world.repo.getSession(session)?.version === version, "S4", "receipt count or version changed");
      const turns = world.db.prepare("SELECT turn_id,ordinal,assistant_text FROM session_turns WHERE session_id=? ORDER BY ordinal").all(session) as
        { turn_id: string; ordinal: number; assistant_text: string }[];
      trace.check(turns.length === ordinal && turns.every((t, i) => t.ordinal === i + 1), "S4", "turn ordinal gap or repeat");
      for (const row of rows) {
        const actual = byId.get(row.input.message_id);
        trace.check(runs.get(row.input.message_id)! <= row.handoffs, "S1", "execution exceeded authorized hand-offs");
        trace.check(actual?.state === row.state, row.uncertain ? "S2" : "S4", "stored receipt state changed");
        trace.check(actual?.created_at === row.input.created_at && actual.applied_at === row.appliedAt, "S5", "historical timestamp changed");
        if (row.completion) {
          const turn = turns[row.completion.turn.ordinal - 1];
          trace.check(turn?.turn_id === row.completion.turn.turn_id && turn.assistant_text === row.result, "S3", "stored turn changed");
        }
      }
    }
    return { digest: trace.digest(), coverage };
  } catch (cause) {
    if (traceFailure !== undefined && cause === traceFailure) throw cause;
    throw trace.failure(cause);
  } finally { world.db.close(); rmSync(root, { recursive: true, force: true }); }
}

const defaults = [0x51e5510, 2026, 92761] as const;
const defaultSteps = 600;
const { steps, seed } = simulationConfig(defaultSteps, defaults[0]);
const list = process.env.OSSTACK_SIMULATION_SEEDS?.split(",").map(value => {
  if (!/^\d+$/.test(value.trim()) || Number(value) > 0xffffffff) throw new Error("Invalid OSSTACK_SIMULATION_SEEDS");
  return Number(value);
});
const seeds = process.env.OSSTACK_PROPERTY_SEED === undefined ? list ?? defaults : [seed];
const timeout = Math.max(60_000, Math.ceil(60_000 * seeds.length * steps / (defaults.length * defaultSteps)));

it("replays seeded session relay faults", async () => {
  const start = performance.now();
  const digests: string[] = [];
  const coverage = new Set<string>();
  for (const selected of seeds) {
    const first = await simulate(selected, steps);
    for (const label of first.coverage) coverage.add(label);
    expect((await simulate(selected, steps)).digest).toBe(first.digest);
    digests.push(first.digest);
  }
  if (seeds === defaults && steps === defaultSteps) {
    for (const label of ["lost_response:uncertain", "duplicate_submission:duplicate", "duplicate_submission:conflict",
      "restart_mid_step:uncertain", "late_result:rejected", "clock_backwards:send", "duplicate_answer:rejected",
      "operator:retry", "executor:failed"]) expect(coverage.has(label), label).toBe(true);
  }
  console.log(`session-relay simulation seeds=${seeds.join(",")} steps=${steps} replays=2 elapsed_ms=${Math.round(performance.now() - start)} digests=${digests.join(",")}`);
}, timeout);

it("the unmutated repository passes the same 256-step run", async () => {
  await simulate(defaults[0], 256);
});

it("an unexpected repository error carries the seed and trace", async () => {
  let calls = 0;
  const factory: Factory = (db, path) => new class extends SessionRepository {
    override getMessage(id: string) {
      if (++calls > 20) throw new Error("boom");
      return super.getMessage(id);
    }
  }(db, path);
  const run = simulate(defaults[0], 64, factory);
  await expect(run).rejects.toThrow(/^seed=\d+ trace=/);
  await expect(run).rejects.toThrow("boom");
  await expect(run).rejects.not.toThrow(/seed=[\s\S]*seed=/);
});

it.each(mutants)("kills the $id mutant: $name", async ({ id, factory }) => {
  await expect(simulate(defaults[0], 256, factory)).rejects.toThrow(new RegExp("seed=\\d+ .*" + id + ":", "s"));
});
