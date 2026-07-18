import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDb } from "./db.js";
import {
  createProbeSession,
  queryProbePortfolioSummary,
} from "./probe-store.js";

const dayMs = 86_400_000;
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function databasePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "osstack-probe-portfolio-"));
  temporaryDirectories.push(directory);
  return join(directory, "state.db");
}

function item(input: {
  id: string;
  state: "open" | "deferred" | "resolved" | "waived" | "invalidated";
  severity: "high" | "medium" | "low";
  required: boolean;
  createdAt: number;
  details?: Record<string, unknown>;
}) {
  return {
    item_id: input.id,
    question_id: `tech.${input.id}.v1`,
    state: input.state,
    current_quadrant: "ku" as const,
    severity: input.severity,
    updated_at_ms: input.createdAt,
    item_json: JSON.stringify({
      required: input.required,
      created_at_ms: input.createdAt,
      ...input.details,
    }),
  };
}

function createSummarySession(nowMs: number) {
  return {
    session: {
      session_id: "probe_summary01",
      repo_id: "osstack",
      state: "active" as const,
      revision: 1,
      snapshot_json: JSON.stringify({
        unselected_required_question_ids: ["tech.missing.v1"],
      }),
      created_at_ms: nowMs - 10 * dayMs,
      updated_at_ms: nowMs,
    },
    items: [
      item({
        id: "pi_openhigh1",
        state: "open",
        severity: "high",
        required: true,
        createdAt: nowMs - 8 * dayMs,
      }),
      item({
        id: "pi_openlow01",
        state: "open",
        severity: "low",
        required: false,
        createdAt: nowMs - 2 * dayMs,
      }),
      item({
        id: "pi_deferred1",
        state: "deferred",
        severity: "medium",
        required: true,
        createdAt: nowMs - 20 * dayMs,
        details: {
          deferral: {
            deferred_at_ms: nowMs - 15 * dayMs,
          },
        },
      }),
      item({
        id: "pi_expired01",
        state: "waived",
        severity: "high",
        required: true,
        createdAt: nowMs - 40 * dayMs,
        details: {
          waiver: {
            approved_at_ms: nowMs - 31 * dayMs,
          },
        },
      }),
      item({
        id: "pi_activewa1",
        state: "waived",
        severity: "medium",
        required: true,
        createdAt: nowMs - 2 * dayMs,
        details: {
          waiver: {
            approved_at_ms: nowMs - dayMs,
          },
        },
      }),
      item({
        id: "pi_resolved1",
        state: "resolved",
        severity: "high",
        required: true,
        createdAt: nowMs - 5 * dayMs,
      }),
      item({
        id: "pi_invalid01",
        state: "invalidated",
        severity: "medium",
        required: true,
        createdAt: nowMs - 4 * dayMs,
        details: { invalidation: { actor: { type: "human" } } },
      }),
    ],
    event: {
      event_id: "pe_summary01",
      revision: 1,
      type: "session_started",
      idempotency_key: "summary-start",
      event_json: JSON.stringify({ type: "session_started" }),
      occurred_at_ms: nowMs - 10 * dayMs,
    },
    receipt: {
      scope_key: "repo:osstack",
      idempotency_key: "summary-start",
      request_sha256: "a".repeat(64),
      result_json: JSON.stringify({ session_id: "probe_summary01" }),
      created_at_ms: nowMs - 10 * dayMs,
    },
  };
}

describe("queryProbePortfolioSummary", () => {
  it("returns no repository summaries when no probe sessions exist", async () => {
    const db = openDb({ path: await databasePath(), minFreeBytes: 0 });
    expect(queryProbePortfolioSummary(db, { as_of_ms: 10 * dayMs })).toEqual({
      schema_version: "1",
      as_of_ms: 10 * dayMs,
      repos: [],
    });
    db.close();
  });

  it("aggregates current obligations without letting completed history inflate completion", async () => {
    const nowMs = 50 * dayMs;
    const db = openDb({ path: await databasePath(), minFreeBytes: 0 });
    createProbeSession(db, createSummarySession(nowMs));
    createProbeSession(db, {
      ...createSummarySession(nowMs),
      session: {
        ...createSummarySession(nowMs).session,
        session_id: "probe_completed1",
        state: "completed",
      },
      items: [],
      event: {
        ...createSummarySession(nowMs).event,
        event_id: "pe_completed1",
        idempotency_key: "completed-start",
      },
      receipt: {
        ...createSummarySession(nowMs).receipt,
        idempotency_key: "completed-start",
        request_sha256: "b".repeat(64),
      },
    });

    expect(queryProbePortfolioSummary(db, {
      as_of_ms: nowMs,
      repo_ids: ["missing", "osstack"],
    })).toEqual({
      schema_version: "1",
      as_of_ms: nowMs,
      repos: [{
        repo_id: "osstack",
        session_count: 2,
        in_progress_session_count: 1,
        completed_session_count: 1,
        open_by_severity: { high: 1, medium: 0, low: 1 },
        oldest_open_age_days: 8,
        deferred_due: 1,
        waived_active: 1,
        waived_expired: 1,
        required_total: 7,
        required_disposed: 3,
        completion_percent: 42.86,
      }],
    });
    db.close();
  });
});
