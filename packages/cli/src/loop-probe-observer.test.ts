import {
  createProbeSession,
  getProbeSession,
  listProbeEvents,
  listProbeItems,
  openDb,
} from "@osstack/core";
import type { LoopEvent } from "@osstack/loop";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { observeLoopImplementationDeviations } from "./loop-probe-observer.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "osstack-loop-probe-observer-"));
  temporaryDirectories.push(root);
  const repo = join(root, "repo");
  await mkdir(join(repo, "src"), { recursive: true });
  await writeFile(join(repo, "src", "adapter.ts"), "export const adapter = true;\n");
  const db = openDb({ path: join(root, "state.db"), minFreeBytes: 0 });
  const session = {
    schema_version: "1" as const,
    session_id: "probe_observer1",
    repo_id: "repo-observer",
    source_revision: "a".repeat(40),
    worktree_state: "clean" as const,
    task_ref: "task-1",
    input_refs: [],
    doc_types: ["tech" as const],
    question_pack_refs: [],
    selected_question_ids: ["tech.interface.v1"],
    unselected_required_question_ids: [],
    depth: "quick" as const,
    question_budget: 8,
    questions_presented: 0,
    revision: 1,
    created_at_ms: 1,
    updated_at_ms: 1,
    state: "active" as const,
    current_question_id: "pi_observer01",
  };
  const item = {
    schema_version: "1" as const,
    item_id: "pi_observer01",
    question_id: "tech.interface.v1",
    session_id: session.session_id,
    item_kind: "question" as const,
    initial_quadrant: "ku" as const,
    current_quadrant: "ku" as const,
    doc_type: "tech" as const,
    category: "interface" as const,
    origin: "static_pack" as const,
    prompt: "Which interface is authoritative?",
    options: [],
    impact: 2 as const,
    irreversibility: 2 as const,
    uncertainty: 2 as const,
    required: false,
    evidence_refs: [],
    destination_hint: "technical_design" as const,
    created_at_ms: 1,
    updated_at_ms: 1,
    state: "open" as const,
  };
  createProbeSession(db, {
    session: {
      session_id: session.session_id,
      repo_id: session.repo_id,
      state: session.state,
      revision: session.revision,
      snapshot_json: JSON.stringify(session),
      created_at_ms: 1,
      updated_at_ms: 1,
    },
    items: [{
      item_id: item.item_id,
      question_id: item.question_id,
      state: item.state,
      current_quadrant: item.current_quadrant,
      severity: "medium",
      updated_at_ms: 1,
      item_json: JSON.stringify(item),
    }],
    event: {
      event_id: "pe_observer01",
      revision: 1,
      type: "session_started",
      idempotency_key: "start-observer",
      event_json: JSON.stringify({ event_id: "pe_observer01" }),
      occurred_at_ms: 1,
    },
    receipt: {
      scope_key: `repo:${session.repo_id}`,
      idempotency_key: "start-observer",
      request_sha256: "b".repeat(64),
      result_json: JSON.stringify({ session_id: session.session_id }),
      created_at_ms: 1,
    },
  });
  let itemSequence = 0;
  let eventSequence = 0;
  return {
    db,
    repo,
    create_item_id: () => `pi_observed${String(++itemSequence).padStart(2, "0")}`,
    create_event_id: () => `pe_observed${String(++eventSequence).padStart(2, "0")}`,
  };
}

function deviationEvent(): LoopEvent {
  return {
    event_id: "evt-deviation-1",
    loop_id: "loop-1",
    type: "loop.implementation.deviation",
    seq: 7,
    created_at: 10,
    payload: {
      task_id: "task-1",
      iteration: 1,
      reviewer_agent_id: "checker",
      deviation_id: "adapter-boundary-drift",
      question: "Should implementation restore the documented adapter boundary?",
      category: "interface",
      doc_type: "tech",
      impact: 3,
      irreversibility: 2,
      uncertainty: 2,
      required: true,
      destination_hint: "technical_design",
      evidence: [{ path: "src/adapter.ts", line: 1, symbol: "adapter" }],
    },
  };
}

describe("loop probe implementation-deviation observer", () => {
  it("adds an evidence-bound mid_build item and replays the event without duplication", async () => {
    const current = await fixture();
    const input = {
      db: current.db,
      repo_root: current.repo,
      repo_id: "repo-observer",
      source_revision: "c".repeat(40),
      events: [deviationEvent()],
      now_ms: 20,
      create_item_id: current.create_item_id,
      create_event_id: current.create_event_id,
    };

    await expect(observeLoopImplementationDeviations(input)).resolves.toMatchObject({
      observed: 1,
      added: 1,
      replayed: 0,
    });
    expect(getProbeSession(current.db, "probe_observer1")?.revision).toBe(2);
    expect(listProbeItems(current.db, "probe_observer1")).toHaveLength(2);
    const observed = listProbeItems(current.db, "probe_observer1")
      .map((row) => JSON.parse(row.item_json) as { origin: string })
      .find((item) => item.origin === "mid_build");
    expect(observed).toMatchObject({
      origin: "mid_build",
      evidence_refs: [{ kind: "file", ref: "src/adapter.ts" }],
    });

    await expect(observeLoopImplementationDeviations(input)).resolves.toMatchObject({
      observed: 1,
      added: 0,
      replayed: 1,
    });
    expect(listProbeItems(current.db, "probe_observer1")).toHaveLength(2);
    expect(listProbeEvents(current.db, "probe_observer1")).toHaveLength(2);
    current.db.close();
  });

  it("ignores ordinary failures and rejects malformed deviation evidence", async () => {
    const current = await fixture();
    const ordinaryFailure: LoopEvent = {
      event_id: "evt-failure-1",
      loop_id: "loop-1",
      type: "loop.execute.done",
      seq: 4,
      created_at: 10,
      payload: { task_id: "task-1", outcome: "failed" },
    };
    const malformed = deviationEvent();
    malformed.payload = {
      ...malformed.payload,
      evidence: [{ path: "../outside.ts" }],
    };

    await expect(observeLoopImplementationDeviations({
      db: current.db,
      repo_root: current.repo,
      repo_id: "repo-observer",
      source_revision: "c".repeat(40),
      events: [ordinaryFailure, malformed],
      now_ms: 20,
      create_item_id: current.create_item_id,
      create_event_id: current.create_event_id,
    })).resolves.toMatchObject({ observed: 0, added: 0, replayed: 0, rejected: 1 });
    expect(listProbeItems(current.db, "probe_observer1")).toHaveLength(1);
    current.db.close();
  });
});
