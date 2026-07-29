import Database from "better-sqlite3";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDb, runMigrations } from "./db.js";
import { CURRENT_SCHEMA_VERSION, MIGRATIONS } from "./migrations.js";
import {
  createProbeSession,
  findActiveProbeSessionsByTaskRef,
  getProbeSession,
  listProbeEvents,
  listProbeItems,
  mutateProbeSession,
  ProbeStoreConflictError,
  recordProbeArtifact,
  replayProbeCommand,
} from "./probe-store.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function databasePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "osstack-probe-db-"));
  temporaryDirectories.push(directory);
  return join(directory, "state.db");
}

function createInput() {
  return {
    session: {
      session_id: "probe_12345678",
      repo_id: "osstack",
      state: "active" as const,
      revision: 1,
      snapshot_json: JSON.stringify({ revision: 1, state: "active" }),
      created_at_ms: 1,
      updated_at_ms: 1,
    },
    items: [
      {
        item_id: "pi_12345678",
        question_id: "tech.data_model.v1",
        state: "open" as const,
        current_quadrant: "ku" as const,
        severity: "high" as const,
        updated_at_ms: 1,
        item_json: JSON.stringify({ item_id: "pi_12345678", state: "open" }),
      },
    ],
    event: {
      event_id: "pe_12345678",
      revision: 1,
      type: "session_started",
      idempotency_key: "start-001",
      event_json: JSON.stringify({ event_id: "pe_12345678", revision: 1 }),
      occurred_at_ms: 1,
    },
    receipt: {
      scope_key: "repo:osstack",
      idempotency_key: "start-001",
      request_sha256: "a".repeat(64),
      result_json: JSON.stringify({ session_id: "probe_12345678", revision: 1 }),
      created_at_ms: 1,
    },
  };
}

function mutationInput() {
  return {
    session_id: "probe_12345678",
    expected_revision: 1,
    session: {
      state: "completed" as const,
      revision: 2,
      snapshot_json: JSON.stringify({ revision: 2, state: "completed" }),
      updated_at_ms: 2,
    },
    items: [
      {
        item_id: "pi_12345678",
        question_id: "tech.data_model.v1",
        state: "resolved" as const,
        current_quadrant: "kk" as const,
        severity: "high" as const,
        updated_at_ms: 2,
        item_json: JSON.stringify({
          item_id: "pi_12345678",
          state: "resolved",
        }),
      },
    ],
    event: {
      event_id: "pe_87654321",
      revision: 2,
      type: "answer_recorded",
      idempotency_key: "answer-001",
      event_json: JSON.stringify({ event_id: "pe_87654321", revision: 2 }),
      occurred_at_ms: 2,
    },
    receipt: {
      scope_key: "session:probe_12345678",
      idempotency_key: "answer-001",
      request_sha256: "b".repeat(64),
      result_json: JSON.stringify({ session_id: "probe_12345678", revision: 2 }),
      created_at_ms: 2,
    },
  };
}

function artifactInput() {
  return {
    receipt_id: "par_12345678",
    session_id: "probe_12345678",
    exported_revision: 1,
    idempotency_key: "render-001",
    actor: { type: "agent" as const, id: "codex" },
    manifest_json: JSON.stringify({
      schema_version: "1",
      session_id: "probe_12345678",
      exported_revision: 1,
    }),
    rendered_at_ms: 2,
    request_sha256: "d".repeat(64),
    result_json: JSON.stringify({
      command: "probe.render",
      session_id: "probe_12345678",
      exported_revision: 1,
    }),
  };
}

function expectConflict(action: () => unknown, code: string): void {
  try {
    action();
    throw new Error("expected conflict");
  } catch (error) {
    expect(error).toBeInstanceOf(ProbeStoreConflictError);
    expect((error as ProbeStoreConflictError).code).toBe(code);
  }
}

describe("probe persistence migration", () => {
  it("upgrades a v10 database additively and preserves older data", async () => {
    const path = await databasePath();
    const old = new Database(path);
    for (const migration of MIGRATIONS.filter((candidate) => candidate.id <= 10)) {
      old.exec(migration.sql);
      old.pragma(`user_version = ${migration.id}`);
    }
    old.prepare(
      "INSERT INTO tasks (task_id, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    ).run("task-old", "Preserved", "pending", 1, 1);
    old.close();

    const upgraded = openDb({ path, minFreeBytes: 0 });
    expect(CURRENT_SCHEMA_VERSION).toBe(17);
    expect(upgraded.pragma("user_version", { simple: true })).toBe(17);
    expect(
      upgraded.prepare("SELECT title FROM tasks WHERE task_id = ?").get("task-old"),
    ).toEqual({ title: "Preserved" });
    const tables = upgraded
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as Array<{ name: string }>;
    expect(tables.map((row) => row.name)).toEqual(
      expect.arrayContaining([
        "probe_sessions",
        "probe_items",
        "probe_events",
        "probe_artifacts",
        "probe_command_receipts",
      ]),
    );
    expect(() => runMigrations(upgraded)).not.toThrow();
    upgraded.close();
  });
});

describe("probe store", () => {
  it("creates and reopens a complete session snapshot", async () => {
    const path = await databasePath();
    const db = openDb({ path, minFreeBytes: 0 });

    expect(createProbeSession(db, createInput())).toEqual({
      replayed: false,
      result_json: JSON.stringify({
        session_id: "probe_12345678",
        revision: 1,
      }),
    });
    expect(getProbeSession(db, "probe_12345678")).toMatchObject({
      repo_id: "osstack",
      state: "active",
      revision: 1,
    });
    expect(listProbeItems(db, "probe_12345678")).toHaveLength(1);
    expect(listProbeEvents(db, "probe_12345678")).toHaveLength(1);
    db.close();

    const reopened = openDb({ path, minFreeBytes: 0 });
    expect(getProbeSession(reopened, "probe_12345678")?.snapshot_json).toBe(
      JSON.stringify({ revision: 1, state: "active" }),
    );
    reopened.close();
  });

  it("finds only active sessions linked to an exact repository task reference", async () => {
    const path = await databasePath();
    const db = openDb({ path, minFreeBytes: 0 });
    const matching = createInput();
    matching.session.snapshot_json = JSON.stringify({
      repo_id: "osstack",
      task_ref: "task-1",
      revision: 1,
      state: "active",
    });
    createProbeSession(db, matching);

    expect(findActiveProbeSessionsByTaskRef(db, "osstack", "task-1")).toEqual([
      expect.objectContaining({ session_id: "probe_12345678", state: "active" }),
    ]);
    expect(findActiveProbeSessionsByTaskRef(db, "other", "task-1")).toEqual([]);
    expect(findActiveProbeSessionsByTaskRef(db, "osstack", "task-2")).toEqual([]);
    db.close();
  });

  it("replays identical command receipts and rejects key reuse with new payload", async () => {
    const path = await databasePath();
    const db = openDb({ path, minFreeBytes: 0 });
    const input = createInput();
    const first = createProbeSession(db, input);
    expect(
      replayProbeCommand(db, {
        scope_key: input.receipt.scope_key,
        idempotency_key: input.receipt.idempotency_key,
        request_sha256: input.receipt.request_sha256,
      }),
    ).toEqual({ replayed: true, result_json: input.receipt.result_json });
    const replay = createProbeSession(db, input);
    expect(first.replayed).toBe(false);
    expect(replay).toEqual({
      replayed: true,
      result_json: input.receipt.result_json,
    });

    expectConflict(
      () =>
        createProbeSession(db, {
          ...input,
          receipt: { ...input.receipt, request_sha256: "f".repeat(64) },
        }),
      "idempotency_conflict",
    );
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM probe_sessions").get(),
    ).toEqual({ count: 1 });
    db.close();
  });

  it("commits event, affected items, snapshot, and receipt in one CAS transaction", async () => {
    const path = await databasePath();
    const db = openDb({ path, minFreeBytes: 0 });
    createProbeSession(db, createInput());

    const result = mutateProbeSession(db, mutationInput());
    expect(result.replayed).toBe(false);
    expect(getProbeSession(db, "probe_12345678")).toMatchObject({
      state: "completed",
      revision: 2,
    });
    expect(listProbeItems(db, "probe_12345678")[0]).toMatchObject({
      state: "resolved",
      current_quadrant: "kk",
    });
    expect(listProbeEvents(db, "probe_12345678").map((event) => event.revision))
      .toEqual([1, 2]);

    expect(mutateProbeSession(db, mutationInput())).toEqual({
      replayed: true,
      result_json: mutationInput().receipt.result_json,
    });
    db.close();
  });

  it("records artifact and command receipts atomically without changing revision", async () => {
    const path = await databasePath();
    const db = openDb({ path, minFreeBytes: 0 });
    createProbeSession(db, createInput());

    expect(recordProbeArtifact(db, artifactInput())).toEqual({
      replayed: false,
      result_json: artifactInput().result_json,
    });
    expect(getProbeSession(db, "probe_12345678")?.revision).toBe(1);
    expect(
      db.prepare(
        "SELECT exported_revision, manifest_json FROM probe_artifacts WHERE receipt_id = ?",
      ).get("par_12345678"),
    ).toEqual({
      exported_revision: 1,
      manifest_json: artifactInput().manifest_json,
    });
    expect(recordProbeArtifact(db, artifactInput())).toEqual({
      replayed: true,
      result_json: artifactInput().result_json,
    });
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM probe_artifacts").get(),
    ).toEqual({ count: 1 });

    expectConflict(
      () =>
        recordProbeArtifact(db, {
          ...artifactInput(),
          request_sha256: "e".repeat(64),
        }),
      "idempotency_conflict",
    );
    db.close();
  });

  it("rejects rendering a stale session revision", async () => {
    const path = await databasePath();
    const db = openDb({ path, minFreeBytes: 0 });
    createProbeSession(db, createInput());
    mutateProbeSession(db, mutationInput());

    expectConflict(
      () => recordProbeArtifact(db, artifactInput()),
      "revision_conflict",
    );
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM probe_artifacts").get(),
    ).toEqual({ count: 0 });
    db.close();
  });

  it("rejects stale competing writers across connections", async () => {
    const path = await databasePath();
    const first = openDb({ path, minFreeBytes: 0 });
    const second = openDb({ path, minFreeBytes: 0 });
    createProbeSession(first, createInput());
    mutateProbeSession(first, mutationInput());

    const stale = mutationInput();
    expectConflict(
      () =>
        mutateProbeSession(second, {
          ...stale,
          event: {
            ...stale.event,
            event_id: "pe_abcdefgh",
            idempotency_key: "answer-stale",
          },
          receipt: {
            ...stale.receipt,
            idempotency_key: "answer-stale",
            request_sha256: "c".repeat(64),
          },
        }),
      "revision_conflict",
    );
    expect(listProbeEvents(second, "probe_12345678")).toHaveLength(2);
    first.close();
    second.close();
  });

  it("rolls back every projection when an event insert fails", async () => {
    const path = await databasePath();
    const db = openDb({ path, minFreeBytes: 0 });
    createProbeSession(db, createInput());
    const mutation = mutationInput();

    expect(() =>
      mutateProbeSession(db, {
        ...mutation,
        event: { ...mutation.event, event_id: "pe_12345678" },
      }),
    ).toThrow();
    expect(getProbeSession(db, "probe_12345678")).toMatchObject({
      state: "active",
      revision: 1,
    });
    expect(listProbeItems(db, "probe_12345678")[0]?.state).toBe("open");
    expect(listProbeEvents(db, "probe_12345678")).toHaveLength(1);
    expect(
      db.prepare(
        "SELECT COUNT(*) AS count FROM probe_command_receipts WHERE idempotency_key = 'answer-001'",
      ).get(),
    ).toEqual({ count: 0 });
    db.close();
  });
});
