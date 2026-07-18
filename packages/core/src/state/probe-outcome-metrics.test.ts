import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDb } from "./db.js";
import { queryProbeOutcomeMetrics } from "./probe-metrics.js";

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
  const directory = await mkdtemp(join(tmpdir(), "osstack-probe-outcomes-"));
  temporaryDirectories.push(directory);
  return join(directory, "state.db");
}

function insertSession(
  db: ReturnType<typeof openDb>,
  input: { sessionId: string; repoId?: string },
): void {
  db.prepare(`
    INSERT INTO probe_sessions (
      session_id, repo_id, state, revision, snapshot_json,
      created_at_ms, updated_at_ms
    ) VALUES (?, ?, 'completed', 1, '{}', 0, 0)
  `).run(input.sessionId, input.repoId ?? "osstack");
}

function insertEvent(
  db: ReturnType<typeof openDb>,
  input: {
    sessionId: string;
    revision: number;
    type: string;
    occurredAt: number;
    payload: Record<string, unknown>;
    itemId?: string;
  },
): void {
  const event = {
    schema_version: "1",
    event_id: `pe_${input.sessionId.slice(6)}_${input.revision}`,
    session_id: input.sessionId,
    revision: input.revision,
    type: input.type,
    actor: { type: "human", id: "owner" },
    idempotency_key: `${input.sessionId}-${input.revision}`,
    occurred_at_ms: input.occurredAt,
    ...(input.itemId === undefined ? {} : { item_id: input.itemId }),
    payload: input.payload,
  };
  db.prepare(`
    INSERT INTO probe_events (
      event_id, session_id, revision, type, idempotency_key,
      event_json, occurred_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    event.event_id,
    input.sessionId,
    input.revision,
    input.type,
    event.idempotency_key,
    JSON.stringify(event),
    input.occurredAt,
  );
}

function fact(input: {
  itemId: string;
  required: boolean;
  severity: "high" | "medium" | "low";
  impact: 1 | 2 | 3;
  origin: "static_pack" | "mid_build";
}) {
  return {
    item_id: input.itemId,
    required: input.required,
    severity: input.severity,
    impact: input.impact,
    origin: input.origin,
  };
}

describe("queryProbeOutcomeMetrics", () => {
  it("rebuilds section 10 outcome rates from replayable events and reports legacy coverage", async () => {
    const db = openDb({ path: await databasePath(), minFreeBytes: 0 });
    insertSession(db, { sessionId: "probe_metrics01" });
    insertEvent(db, {
      sessionId: "probe_metrics01",
      revision: 1,
      type: "session_started",
      occurredAt: 0,
      payload: {
        metric_facts: {
          task_ref: "task-1",
          item_facts: [
            fact({
              itemId: "pi_answered1",
              required: true,
              severity: "high",
              impact: 3,
              origin: "static_pack",
            }),
            fact({
              itemId: "pi_deferred1",
              required: false,
              severity: "low",
              impact: 1,
              origin: "static_pack",
            }),
          ],
        },
      },
    });
    insertEvent(db, {
      sessionId: "probe_metrics01",
      revision: 2,
      type: "answer_recorded",
      occurredAt: dayMs,
      itemId: "pi_answered1",
      payload: {
        metric_facts: {
          answer_effective: true,
          destination_state: "pending",
        },
        resulting_session_state: "active",
      },
    });
    insertEvent(db, {
      sessionId: "probe_metrics01",
      revision: 3,
      type: "destination_updated",
      occurredAt: dayMs,
      itemId: "pi_answered1",
      payload: { destination_state: "applied" },
    });
    insertEvent(db, {
      sessionId: "probe_metrics01",
      revision: 4,
      type: "item_deferred",
      occurredAt: dayMs,
      itemId: "pi_deferred1",
      payload: {
        metric_facts: { review_after_ms: 5 * dayMs },
        resulting_session_state: "active",
      },
    });
    insertEvent(db, {
      sessionId: "probe_metrics01",
      revision: 5,
      type: "items_added",
      occurredAt: 2 * dayMs,
      payload: {
        metric_facts: {
          item_facts: [fact({
            itemId: "pi_midbuild1",
            required: true,
            severity: "high",
            impact: 3,
            origin: "mid_build",
          })],
        },
      },
    });
    insertEvent(db, {
      sessionId: "probe_metrics01",
      revision: 6,
      type: "item_waived",
      occurredAt: 2 * dayMs,
      itemId: "pi_midbuild1",
      payload: {
        metric_facts: {},
        resulting_session_state: "completed",
      },
    });

    insertSession(db, { sessionId: "probe_metrics02" });
    insertEvent(db, {
      sessionId: "probe_metrics02",
      revision: 1,
      type: "session_started",
      occurredAt: 0,
      payload: {
        metric_facts: {
          task_ref: "task-2",
          item_facts: [fact({
            itemId: "pi_answered2",
            required: true,
            severity: "high",
            impact: 3,
            origin: "static_pack",
          })],
        },
      },
    });
    insertEvent(db, {
      sessionId: "probe_metrics02",
      revision: 2,
      type: "answer_recorded",
      occurredAt: dayMs,
      itemId: "pi_answered2",
      payload: {
        metric_facts: {
          answer_effective: false,
          destination_state: "pending",
        },
        resulting_session_state: "completed",
      },
    });

    insertSession(db, { sessionId: "probe_legacy001" });
    insertEvent(db, {
      sessionId: "probe_legacy001",
      revision: 1,
      type: "session_started",
      occurredAt: 0,
      payload: { selected_question_ids: ["tech.legacy.v1"] },
    });

    expect(queryProbeOutcomeMetrics(db, { as_of_ms: 20 * dayMs })).toEqual({
      schema_version: "1",
      as_of_ms: 20 * dayMs,
      repos: [{
        repo_id: "osstack",
        counts: {
          sessions_total: 3,
          sessions_replayed: 2,
          sessions_skipped: 1,
          answered_questions: 2,
          effective_questions: 1,
          resolved_items: 2,
          integrated_decisions: 1,
          high_risk_tasks: 2,
          mid_build_deviation_tasks: 1,
          deferred_items: 1,
          stale_deferred_items: 1,
          gate_relevant_items: 3,
          active_waivers: 1,
          started_sessions: 2,
          completed_sessions: 2,
        },
        rates: {
          effective_question_rate: 0.5,
          decision_integration_rate: 0.5,
          mid_build_architecture_deviation_rate: 0.5,
          stale_deferral_rate: 1,
          waiver_rate: 0.3333,
          completion_rate: 1,
        },
      }],
    });
    db.close();
  });
});
