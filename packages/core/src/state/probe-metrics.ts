import type Database from "better-sqlite3";
import { z } from "zod";

const epochMilliseconds = z.number().int().nonnegative().finite();
const dayMs = 86_400_000;

export const ProbeOutcomeCountsV1 = z
  .object({
    sessions_total: z.number().int().nonnegative(),
    sessions_replayed: z.number().int().nonnegative(),
    sessions_skipped: z.number().int().nonnegative(),
    answered_questions: z.number().int().nonnegative(),
    effective_questions: z.number().int().nonnegative(),
    resolved_items: z.number().int().nonnegative(),
    integrated_decisions: z.number().int().nonnegative(),
    high_risk_tasks: z.number().int().nonnegative(),
    mid_build_deviation_tasks: z.number().int().nonnegative(),
    deferred_items: z.number().int().nonnegative(),
    stale_deferred_items: z.number().int().nonnegative(),
    gate_relevant_items: z.number().int().nonnegative(),
    active_waivers: z.number().int().nonnegative(),
    started_sessions: z.number().int().nonnegative(),
    completed_sessions: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((counts, context) => {
    const bounded: Array<[keyof typeof counts, keyof typeof counts]> = [
      ["effective_questions", "answered_questions"],
      ["integrated_decisions", "resolved_items"],
      ["mid_build_deviation_tasks", "high_risk_tasks"],
      ["stale_deferred_items", "deferred_items"],
      ["active_waivers", "gate_relevant_items"],
      ["completed_sessions", "started_sessions"],
    ];
    for (const [numerator, denominator] of bounded) {
      if (counts[numerator] > counts[denominator]) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [numerator],
          message: `${numerator} cannot exceed ${denominator}`,
        });
      }
    }
    if (
      counts.sessions_total !==
        counts.sessions_replayed + counts.sessions_skipped
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["sessions_total"],
        message: "sessions_total must equal replayed plus skipped sessions",
      });
    }
  });
export type ProbeOutcomeCountsV1 = z.infer<typeof ProbeOutcomeCountsV1>;

const nullableRate = z.number().min(0).max(1).finite().nullable();
export const ProbeOutcomeRatesV1 = z
  .object({
    effective_question_rate: nullableRate,
    decision_integration_rate: nullableRate,
    mid_build_architecture_deviation_rate: nullableRate,
    stale_deferral_rate: nullableRate,
    waiver_rate: nullableRate,
    completion_rate: nullableRate,
  })
  .strict();
export type ProbeOutcomeRatesV1 = z.infer<typeof ProbeOutcomeRatesV1>;

export const ProbeRepoOutcomeMetricsV1 = z
  .object({
    repo_id: z.string().trim().min(1).max(256),
    counts: ProbeOutcomeCountsV1,
    rates: ProbeOutcomeRatesV1,
  })
  .strict();
export type ProbeRepoOutcomeMetricsV1 = z.infer<
  typeof ProbeRepoOutcomeMetricsV1
>;

export const ProbeOutcomeMetricsReportV1 = z
  .object({
    schema_version: z.literal("1"),
    as_of_ms: epochMilliseconds,
    repos: z.array(ProbeRepoOutcomeMetricsV1),
  })
  .strict();
export type ProbeOutcomeMetricsReportV1 = z.infer<
  typeof ProbeOutcomeMetricsReportV1
>;

export const QueryProbeOutcomeMetricsInputV1 = z
  .object({
    as_of_ms: epochMilliseconds.optional(),
    repo_ids: z
      .array(z.string().trim().min(1).max(256))
      .max(10_000)
      .optional(),
    max_deferred_age_days: z.number().int().positive().max(3_650).optional(),
    max_waiver_age_days: z.number().int().positive().max(3_650).optional(),
  })
  .strict();
export type QueryProbeOutcomeMetricsInputV1 = z.infer<
  typeof QueryProbeOutcomeMetricsInputV1
>;

const metricItemFact = z
  .object({
    item_id: z.string().min(1),
    required: z.boolean(),
    severity: z.enum(["high", "medium", "low"]),
    impact: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    origin: z.string().min(1),
  })
  .strict();
type MetricItemFact = z.infer<typeof metricItemFact>;

const storedMetricEvent = z
  .object({
    session_id: z.string().min(1),
    revision: z.number().int().positive(),
    type: z.string().min(1),
    item_id: z.string().min(1).optional(),
    occurred_at_ms: epochMilliseconds,
    payload: z.record(z.unknown()),
  })
  .passthrough();
type StoredMetricEvent = z.infer<typeof storedMetricEvent>;

const startMetricFacts = z
  .object({
    item_facts: z.array(metricItemFact),
    task_ref: z.string().trim().min(1).max(512).optional(),
  })
  .passthrough();
const answerMetricFacts = z
  .object({
    answer_effective: z.boolean(),
    destination_state: z.enum(["pending", "applied", "verified"]),
  })
  .passthrough();
const deferralMetricFacts = z
  .object({ review_after_ms: epochMilliseconds.optional() })
  .passthrough();
const waiverMetricFacts = z
  .object({ expires_at_ms: epochMilliseconds.optional() })
  .passthrough();
const addedMetricFacts = z
  .object({ item_facts: z.array(metricItemFact) })
  .passthrough();

interface ProbeMetricSessionRow {
  session_id: string;
  repo_id: string;
}

interface ProbeMetricEventRow {
  session_id: string;
  revision: number;
  type: string;
  event_json: string;
  occurred_at_ms: number;
}

interface ReplayItem {
  fact: MetricItemFact;
  state: "open" | "resolved" | "deferred" | "waived" | "invalidated";
  destination_state?: "pending" | "applied" | "verified";
  deferred_at_ms?: number;
  review_after_ms?: number;
  waived_at_ms?: number;
  expires_at_ms?: number;
}

interface ReplaySessionResult {
  task_ref?: string;
  high_risk_task: boolean;
  mid_build_deviation: boolean;
  completed: boolean;
  answered_questions: number;
  effective_questions: number;
  resolved_items: number;
  integrated_decisions: number;
  deferred_items: number;
  stale_deferred_items: number;
  gate_relevant_items: number;
  active_waivers: number;
}

interface MutableRepoMetrics {
  repo_id: string;
  counts: ProbeOutcomeCountsV1;
  high_risk_tasks: Set<string>;
  mid_build_deviation_tasks: Set<string>;
}

function metricFacts(
  payload: Record<string, unknown>,
): unknown {
  return payload["metric_facts"];
}

function itemId(event: StoredMetricEvent): string {
  if (event.item_id === undefined) {
    throw new Error(`${event.type} event lacks item_id`);
  }
  return event.item_id;
}

function addFacts(
  items: Map<string, ReplayItem>,
  facts: readonly MetricItemFact[],
): void {
  for (const fact of facts) {
    if (items.has(fact.item_id)) {
      throw new Error(`duplicate metric item fact: ${fact.item_id}`);
    }
    items.set(fact.item_id, { fact, state: "open" });
  }
}

function requireItem(
  items: Map<string, ReplayItem>,
  event: StoredMetricEvent,
): ReplayItem {
  const id = itemId(event);
  const item = items.get(id);
  if (item === undefined) throw new Error(`metric event references unknown item: ${id}`);
  return item;
}

function resultingState(event: StoredMetricEvent): string | undefined {
  const value = event.payload["resulting_session_state"];
  return typeof value === "string" ? value : undefined;
}

function replaySession(
  sessionId: string,
  rows: readonly ProbeMetricEventRow[],
  asOfMs: number,
  deferredAgeMs: number,
  waiverAgeMs: number,
): ReplaySessionResult {
  const events = rows.map((row) => {
    const event = storedMetricEvent.parse(JSON.parse(row.event_json) as unknown);
    if (
      event.session_id !== sessionId ||
      event.revision !== row.revision ||
      event.type !== row.type ||
      event.occurred_at_ms !== row.occurred_at_ms
    ) {
      throw new Error(`probe event row binding mismatch at revision ${row.revision}`);
    }
    return event;
  });
  const first = events[0];
  if (first === undefined || first.type !== "session_started") {
    throw new Error("metric replay requires a session_started event");
  }
  events.forEach((event, index) => {
    if (event.revision !== index + 1) {
      throw new Error(`metric replay revision gap at ${event.revision}`);
    }
  });
  const start = startMetricFacts.parse(metricFacts(first.payload));
  const items = new Map<string, ReplayItem>();
  addFacts(items, start.item_facts);
  const answered = new Set<string>();
  const effective = new Set<string>();
  let completed = false;

  for (const event of events.slice(1)) {
    if (event.type === "answer_recorded") {
      const item = requireItem(items, event);
      if (item.state !== "open") throw new Error("answer requires an open item");
      const facts = answerMetricFacts.parse(metricFacts(event.payload));
      item.state = "resolved";
      item.destination_state = facts.destination_state;
      answered.add(item.fact.item_id);
      if (facts.answer_effective) effective.add(item.fact.item_id);
    } else if (event.type === "destination_updated") {
      const item = requireItem(items, event);
      if (item.state !== "resolved") {
        throw new Error("destination update requires a resolved item");
      }
      const state = event.payload["destination_state"];
      if (state !== "applied" && state !== "verified") {
        throw new Error("destination update lacks a valid state");
      }
      item.destination_state = state;
      if (answered.has(item.fact.item_id)) effective.add(item.fact.item_id);
    } else if (event.type === "item_deferred") {
      const item = requireItem(items, event);
      if (item.state !== "open") throw new Error("deferral requires an open item");
      const facts = deferralMetricFacts.parse(metricFacts(event.payload));
      item.state = "deferred";
      item.deferred_at_ms = event.occurred_at_ms;
      if (facts.review_after_ms !== undefined) {
        item.review_after_ms = facts.review_after_ms;
      }
    } else if (event.type === "item_waived") {
      const item = requireItem(items, event);
      if (item.state !== "open") throw new Error("waiver requires an open item");
      const facts = waiverMetricFacts.parse(metricFacts(event.payload));
      item.state = "waived";
      item.waived_at_ms = event.occurred_at_ms;
      if (facts.expires_at_ms !== undefined) item.expires_at_ms = facts.expires_at_ms;
    } else if (event.type === "item_invalidated") {
      const item = requireItem(items, event);
      if (item.state !== "open") throw new Error("invalidation requires an open item");
      item.state = "invalidated";
    } else if (event.type === "items_added") {
      const facts = addedMetricFacts.parse(metricFacts(event.payload));
      addFacts(items, facts.item_facts);
    } else if (event.type === "session_resumed") {
      const revisitIds = z.array(z.string()).parse(
        event.payload["revisited_item_ids"] ?? [],
      );
      for (const id of revisitIds) {
        const item = items.get(id);
        if (item === undefined || item.state !== "deferred") {
          throw new Error(`resume references a non-deferred item: ${id}`);
        }
        item.state = "open";
        delete item.deferred_at_ms;
        delete item.review_after_ms;
      }
      const facts = addedMetricFacts.parse(metricFacts(event.payload));
      addFacts(items, facts.item_facts);
    }
    if (resultingState(event) === "completed") completed = true;
    if (event.type === "session_abandoned") completed = false;
  }

  const values = [...items.values()];
  const deferred = values.filter((item) => item.state === "deferred");
  const staleDeferred = deferred.filter((item) =>
    (item.review_after_ms !== undefined && item.review_after_ms <= asOfMs) ||
    (item.deferred_at_ms !== undefined && asOfMs - item.deferred_at_ms >= deferredAgeMs)
  );
  const waived = values.filter((item) => item.state === "waived");
  const activeWaivers = waived.filter((item) =>
    (item.fact.required || item.fact.severity === "high") &&
    !(
      (item.expires_at_ms !== undefined && item.expires_at_ms <= asOfMs) ||
      (item.waived_at_ms !== undefined && asOfMs - item.waived_at_ms >= waiverAgeMs)
    )
  );
  const resolved = values.filter((item) => item.state === "resolved");
  const integrated = resolved.filter((item) =>
    item.destination_state === "applied" || item.destination_state === "verified"
  );
  const gateRelevant = values.filter((item) =>
    item.fact.required || item.fact.severity === "high"
  );
  const highRisk = values.some((item) =>
    item.fact.severity === "high" || item.fact.impact === 3
  );
  const midBuild = values.some((item) =>
    item.fact.origin === "mid_build" && item.fact.impact === 3
  );
  return {
    ...(start.task_ref === undefined ? {} : { task_ref: start.task_ref }),
    high_risk_task: highRisk,
    mid_build_deviation: midBuild,
    completed,
    answered_questions: answered.size,
    effective_questions: effective.size,
    resolved_items: resolved.length,
    integrated_decisions: integrated.length,
    deferred_items: deferred.length,
    stale_deferred_items: staleDeferred.length,
    gate_relevant_items: gateRelevant.length,
    active_waivers: activeWaivers.length,
  };
}

function emptyCounts(): ProbeOutcomeCountsV1 {
  return {
    sessions_total: 0,
    sessions_replayed: 0,
    sessions_skipped: 0,
    answered_questions: 0,
    effective_questions: 0,
    resolved_items: 0,
    integrated_decisions: 0,
    high_risk_tasks: 0,
    mid_build_deviation_tasks: 0,
    deferred_items: 0,
    stale_deferred_items: 0,
    gate_relevant_items: 0,
    active_waivers: 0,
    started_sessions: 0,
    completed_sessions: 0,
  };
}

function rate(numerator: number, denominator: number): number | null {
  return denominator === 0
    ? null
    : Math.round((numerator / denominator) * 10_000) / 10_000;
}

export function deriveProbeOutcomeRates(
  counts: ProbeOutcomeCountsV1,
): ProbeOutcomeRatesV1 {
  return ProbeOutcomeRatesV1.parse({
    effective_question_rate: rate(
      counts.effective_questions,
      counts.answered_questions,
    ),
    decision_integration_rate: rate(
      counts.integrated_decisions,
      counts.resolved_items,
    ),
    mid_build_architecture_deviation_rate: rate(
      counts.mid_build_deviation_tasks,
      counts.high_risk_tasks,
    ),
    stale_deferral_rate: rate(
      counts.stale_deferred_items,
      counts.deferred_items,
    ),
    waiver_rate: rate(counts.active_waivers, counts.gate_relevant_items),
    completion_rate: rate(
      counts.completed_sessions,
      counts.started_sessions,
    ),
  });
}

/** Rebuilds outcome counters from append-only probe events, never CLI text. */
export function queryProbeOutcomeMetrics(
  db: Database.Database,
  rawInput: QueryProbeOutcomeMetricsInputV1 = {},
): ProbeOutcomeMetricsReportV1 {
  const input = QueryProbeOutcomeMetricsInputV1.parse(rawInput);
  const asOfMs = input.as_of_ms ?? Date.now();
  const repoIds = input.repo_ids === undefined
    ? undefined
    : [...new Set(input.repo_ids)];
  if (repoIds?.length === 0) {
    return ProbeOutcomeMetricsReportV1.parse({
      schema_version: "1",
      as_of_ms: asOfMs,
      repos: [],
    });
  }
  const deferredAgeMs = (input.max_deferred_age_days ?? 14) * dayMs;
  const waiverAgeMs = (input.max_waiver_age_days ?? 30) * dayMs;
  const sessionRepoClause = repoIds === undefined
    ? ""
    : `WHERE repo_id IN (${repoIds.map(() => "?").join(", ")})`;
  const sessions = db.prepare(`
    SELECT session_id, repo_id
    FROM probe_sessions
    ${sessionRepoClause}
    ORDER BY repo_id, created_at_ms, session_id
  `).all(...(repoIds ?? [])) as ProbeMetricSessionRow[];
  const eventRepoClause = repoIds === undefined
    ? ""
    : `WHERE sessions.repo_id IN (${repoIds.map(() => "?").join(", ")})`;
  const eventRows = db.prepare(`
    SELECT events.session_id, events.revision, events.type,
           events.event_json, events.occurred_at_ms
    FROM probe_events AS events
    JOIN probe_sessions AS sessions
      ON sessions.session_id = events.session_id
    ${eventRepoClause}
    ORDER BY events.session_id, events.revision
  `).all(...(repoIds ?? [])) as ProbeMetricEventRow[];
  const eventsBySession = new Map<string, ProbeMetricEventRow[]>();
  for (const row of eventRows) {
    const bucket = eventsBySession.get(row.session_id);
    if (bucket === undefined) eventsBySession.set(row.session_id, [row]);
    else bucket.push(row);
  }
  const repos = new Map<string, MutableRepoMetrics>();

  for (const session of sessions) {
    const aggregate = repos.get(session.repo_id) ?? {
      repo_id: session.repo_id,
      counts: emptyCounts(),
      high_risk_tasks: new Set<string>(),
      mid_build_deviation_tasks: new Set<string>(),
    };
    aggregate.counts.sessions_total += 1;
    try {
      const replayed = replaySession(
        session.session_id,
        eventsBySession.get(session.session_id) ?? [],
        asOfMs,
        deferredAgeMs,
        waiverAgeMs,
      );
      aggregate.counts.sessions_replayed += 1;
      aggregate.counts.started_sessions += 1;
      if (replayed.completed) aggregate.counts.completed_sessions += 1;
      aggregate.counts.answered_questions += replayed.answered_questions;
      aggregate.counts.effective_questions += replayed.effective_questions;
      aggregate.counts.resolved_items += replayed.resolved_items;
      aggregate.counts.integrated_decisions += replayed.integrated_decisions;
      aggregate.counts.deferred_items += replayed.deferred_items;
      aggregate.counts.stale_deferred_items += replayed.stale_deferred_items;
      aggregate.counts.gate_relevant_items += replayed.gate_relevant_items;
      aggregate.counts.active_waivers += replayed.active_waivers;
      if (replayed.task_ref !== undefined && replayed.high_risk_task) {
        aggregate.high_risk_tasks.add(replayed.task_ref);
        if (replayed.mid_build_deviation) {
          aggregate.mid_build_deviation_tasks.add(replayed.task_ref);
        }
      }
    } catch {
      aggregate.counts.sessions_skipped += 1;
    }
    repos.set(session.repo_id, aggregate);
  }

  return ProbeOutcomeMetricsReportV1.parse({
    schema_version: "1",
    as_of_ms: asOfMs,
    repos: [...repos.values()]
      .sort((left, right) => left.repo_id.localeCompare(right.repo_id))
      .map((aggregate) => {
        const counts = {
          ...aggregate.counts,
          high_risk_tasks: aggregate.high_risk_tasks.size,
          mid_build_deviation_tasks:
            aggregate.mid_build_deviation_tasks.size,
        };
        return {
          repo_id: aggregate.repo_id,
          counts,
          rates: deriveProbeOutcomeRates(counts),
        };
      }),
  });
}
