import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { runMigrations } from "./db.js";
import {
  KnowledgeHygienePlanEventConflictErrorV1,
  appendKnowledgeHygienePlanEventV1,
  getKnowledgeHygienePlanProjectionV1,
} from "./knowledge-hygiene-plan-store.js";

const sha = (character: string) => character.repeat(64);

function db(): Database.Database {
  const value = new Database(":memory:");
  value.pragma("foreign_keys = ON");
  runMigrations(value);
  return value;
}

function event(input: {
  character: string;
  from: "draft" | null;
  to: "draft" | "approved";
}) {
  return {
    schema_version: "1" as const,
    event_id: `khte_${sha(input.character)}`,
    plan_id: `khtp_${sha("a")}`,
    kind: "memory" as const,
    repo_id: "repo-1",
    revision: 1,
    from_state: input.from,
    to_state: input.to,
    artifact_path: "/private/plans/plan.json",
    artifact_sha256: sha(input.character),
    actor: "system:governance",
    reason: "Plan lifecycle transition.",
    occurred_at: "2026-07-18T00:00:00.000Z",
  };
}

describe("knowledge hygiene plan event store", () => {
  it("appends idempotent CAS events and rebuilds projection", () => {
    const database = db();
    const created = event({ character: "b", from: null, to: "draft" });
    expect(appendKnowledgeHygienePlanEventV1(database, created))
      .toEqual({ inserted: true, state: "draft" });
    expect(appendKnowledgeHygienePlanEventV1(database, created))
      .toEqual({ inserted: false, state: "draft" });
    expect(appendKnowledgeHygienePlanEventV1(
      database,
      event({ character: "c", from: "draft", to: "approved" }),
    )).toEqual({ inserted: true, state: "approved" });
    expect(getKnowledgeHygienePlanProjectionV1(database, created.plan_id))
      .toMatchObject({ state: "approved", revision: 1 });
  });

  it("rejects stale and illegal transitions", () => {
    const database = db();
    appendKnowledgeHygienePlanEventV1(
      database,
      event({ character: "b", from: null, to: "draft" }),
    );
    expect(() => appendKnowledgeHygienePlanEventV1(
      database,
      event({ character: "d", from: null, to: "draft" }),
    )).toThrow(KnowledgeHygienePlanEventConflictErrorV1);
  });
});
