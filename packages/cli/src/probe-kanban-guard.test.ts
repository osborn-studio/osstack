import {
  createProbeSession,
  KanbanRepository,
  openDb,
} from "@osstack/core";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createProbeKanbanTransitionGuard } from "./probe-kanban-guard.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true }),
  ));
});

async function fixture() {
  const workspace = await mkdtemp(join(tmpdir(), "osstack-probe-kanban-"));
  temporaryDirectories.push(workspace);
  const dbPath = join(workspace, "state.db");
  const db = openDb({ path: dbPath, minFreeBytes: 0 });
  const repo = new KanbanRepository(db, dbPath, () => 1);
  repo.createCard({ card_id: "card-1", title: "Implement", status: "ready" });
  const session = {
    schema_version: "1" as const,
    session_id: "probe_guard001",
    repo_id: workspace.split("/").at(-1)!,
    worktree_state: "not_git" as const,
    task_ref: "card-1",
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
    current_question_id: "pi_guard0001",
  };
  const item = {
    schema_version: "1" as const,
    item_id: "pi_guard0001",
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
    impact: 3 as const,
    irreversibility: 3 as const,
    uncertainty: 3 as const,
    required: true,
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
      revision: 1,
      snapshot_json: JSON.stringify(session),
      created_at_ms: 1,
      updated_at_ms: 1,
    },
    items: [{
      item_id: item.item_id,
      question_id: item.question_id,
      state: item.state,
      current_quadrant: item.current_quadrant,
      severity: "high",
      updated_at_ms: 1,
      item_json: JSON.stringify(item),
    }],
    event: {
      event_id: "pe_guard0001",
      revision: 1,
      type: "session_started",
      idempotency_key: "start-guard",
      event_json: JSON.stringify({
        schema_version: "1",
        event_id: "pe_guard0001",
        session_id: session.session_id,
        revision: 1,
        type: "session_started",
        actor: { type: "human", id: "owner" },
        idempotency_key: "start-guard",
        occurred_at_ms: 1,
        payload: {},
      }),
      occurred_at_ms: 1,
    },
    receipt: {
      scope_key: `repo:${session.repo_id}`,
      idempotency_key: "start-guard",
      request_sha256: "a".repeat(64),
      result_json: JSON.stringify({ session_id: session.session_id }),
      created_at_ms: 1,
    },
  });
  db.close();
  return { workspace, dbPath };
}

describe("probe kanban transition guard adapter", () => {
  it("blocks a linked execution transition only under explicit block policy", async () => {
    const current = await fixture();
    await mkdir(join(current.workspace, ".osstack"));
    const configPath = join(current.workspace, ".osstack", "probe.yaml");
    const guard = createProbeKanbanTransitionGuard({
      db_path: current.dbPath,
      now_ms: () => 2,
    });
    const input = {
      cardId: "card-1",
      from: "ready" as const,
      to: "running" as const,
      workspacePath: current.workspace,
    };

    await writeFile(configPath, "schema_version: 1\nenforcement: block\n");
    await expect(guard.evaluate(input)).resolves.toMatchObject({
      allow: false,
      reason: expect.stringContaining("open_required"),
      evidenceRefs: ["probe-session:probe_guard001", "probe-policy:.osstack/probe.yaml"],
    });

    await writeFile(configPath, "schema_version: 1\nenforcement: report\n");
    await expect(guard.evaluate(input)).resolves.toMatchObject({
      allow: true,
      reason: "probe readiness report: advisory violations",
    });
  });

  it("allows unrelated transitions and cards without linked sessions", async () => {
    const current = await fixture();
    const guard = createProbeKanbanTransitionGuard({ db_path: current.dbPath });
    await expect(guard.evaluate({
      cardId: "other-card",
      from: "ready",
      to: "running",
      workspacePath: current.workspace,
    })).resolves.toMatchObject({ allow: true, reason: "no linked probe session" });
    await expect(guard.evaluate({
      cardId: "card-1",
      from: "running",
      to: "done",
      workspacePath: current.workspace,
    })).resolves.toMatchObject({ allow: true });
  });
});
