import type Database from "better-sqlite3";
import {
  findActiveProbeSessionsByTaskRef,
  getProbeSession,
  listProbeItems,
  mutateProbeSession,
  replayProbeCommand,
} from "@osstack/core";
import {
  applyProbeMutation,
  canonicalProbeJson,
  deriveProbeSeverity,
  materializeProbeQuestionBatch,
  ProbeCategoryV1,
  ProbeDestinationRoleV1,
  ProbeDocTypeV1,
  ProbeItemV1,
  ProbeRepositoryRelativePathV1,
  ProbeSessionV1,
  probeSha256,
  type ProbeDomainStateV1,
  type ProbeEvidenceRefV1,
} from "@osstack/governance";
import { ImplementationDeviation, LoopEvent } from "@osstack/loop";
import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

export interface ObserveLoopImplementationDeviationsInputV1 {
  db: Database.Database;
  repo_root: string;
  repo_id: string;
  source_revision: string;
  events: readonly unknown[];
  now_ms: number;
  create_item_id: () => string;
  create_event_id: () => string;
}

export interface LoopProbeObservationResultV1 {
  observed: number;
  added: number;
  replayed: number;
  rejected: number;
  unlinked: number;
  ambiguous: number;
  duplicate: number;
}

interface ParsedDeviationEvent {
  event_id: string;
  loop_id: string;
  task_id: string;
  reviewer_agent_id: string;
  deviation: ImplementationDeviation;
}

function parseDeviationEvent(raw: unknown): ParsedDeviationEvent | undefined {
  const event = LoopEvent.safeParse(raw);
  if (!event.success || event.data.type !== "loop.implementation.deviation") {
    return undefined;
  }
  const payload = event.data.payload;
  if (
    payload === undefined ||
    typeof payload["task_id"] !== "string" ||
    payload["task_id"].trim() === "" ||
    typeof payload["reviewer_agent_id"] !== "string" ||
    payload["reviewer_agent_id"].trim() === ""
  ) {
    return undefined;
  }
  const {
    task_id: taskId,
    reviewer_agent_id: reviewerAgentId,
    iteration: _iteration,
    ...candidate
  } = payload;
  void _iteration;
  const deviation = ImplementationDeviation.safeParse(candidate);
  if (!deviation.success) return undefined;
  if (
    !ProbeCategoryV1.safeParse(deviation.data.category).success ||
    !ProbeDocTypeV1.safeParse(deviation.data.doc_type).success ||
    !ProbeDestinationRoleV1.safeParse(deviation.data.destination_hint).success
  ) {
    return undefined;
  }
  return {
    event_id: event.data.event_id,
    loop_id: event.data.loop_id,
    task_id: taskId,
    reviewer_agent_id: reviewerAgentId,
    deviation: deviation.data,
  };
}

function loadState(
  db: Database.Database,
  sessionId: string,
): ProbeDomainStateV1 {
  const row = getProbeSession(db, sessionId);
  if (row === undefined) throw new Error(`probe session not found: ${sessionId}`);
  return {
    session: ProbeSessionV1.parse(JSON.parse(row.snapshot_json)),
    items: listProbeItems(db, sessionId).map((item) =>
      ProbeItemV1.parse(JSON.parse(item.item_json)),
    ),
  };
}

function storedItems(items: readonly ProbeItemV1[]) {
  return items.map((item) => ({
    item_id: item.item_id,
    question_id: item.question_id,
    state: item.state,
    current_quadrant: item.current_quadrant,
    severity: deriveProbeSeverity(item),
    updated_at_ms: item.updated_at_ms,
    item_json: JSON.stringify(item),
  }));
}

function isInside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (
    path !== ".." &&
    !path.startsWith(`..${sep}`) &&
    !isAbsolute(path)
  );
}

async function verifyEvidence(
  repoRoot: string,
  evidence: ImplementationDeviation["evidence"][number],
): Promise<ProbeEvidenceRefV1 | undefined> {
  const parsedPath = ProbeRepositoryRelativePathV1.safeParse(evidence.path);
  if (!parsedPath.success) return undefined;
  try {
    const resolved = await realpath(resolve(repoRoot, parsedPath.data));
    if (!isInside(repoRoot, resolved)) return undefined;
    const info = await stat(resolved);
    if (!info.isFile()) return undefined;
    const content = await readFile(resolved);
    if (evidence.line !== undefined) {
      const lineCount = content.toString("utf8").split("\n").length;
      if (evidence.line > lineCount) return undefined;
    }
    return {
      kind: "file",
      ref: parsedPath.data,
      sha256: probeSha256(content),
      ...(evidence.line === undefined ? {} : { line: evidence.line }),
      ...(evidence.symbol === undefined ? {} : { symbol: evidence.symbol }),
    };
  } catch {
    return undefined;
  }
}

function idempotencyKey(event: ParsedDeviationEvent): string {
  return `loop-deviation:${probeSha256(canonicalProbeJson({
    event_id: event.event_id,
    deviation_id: event.deviation.deviation_id,
  })).slice(0, 32)}`;
}

export async function observeLoopImplementationDeviations(
  input: ObserveLoopImplementationDeviationsInputV1,
): Promise<LoopProbeObservationResultV1> {
  const result: LoopProbeObservationResultV1 = {
    observed: 0,
    added: 0,
    replayed: 0,
    rejected: 0,
    unlinked: 0,
    ambiguous: 0,
    duplicate: 0,
  };
  const repoRoot = await realpath(input.repo_root);

  for (const rawEvent of input.events) {
    const rawLoopEvent = LoopEvent.safeParse(rawEvent);
    if (!rawLoopEvent.success || rawLoopEvent.data.type !== "loop.implementation.deviation") {
      continue;
    }
    const event = parseDeviationEvent(rawEvent);
    if (event === undefined) {
      result.rejected += 1;
      continue;
    }
    const evidenceRefs = (
      await Promise.all(
        event.deviation.evidence.map((evidence) =>
          verifyEvidence(repoRoot, evidence),
        ),
      )
    ).filter((evidence): evidence is ProbeEvidenceRefV1 => evidence !== undefined);
    if (evidenceRefs.length !== event.deviation.evidence.length) {
      result.rejected += 1;
      continue;
    }
    result.observed += 1;

    const sessions = findActiveProbeSessionsByTaskRef(
      input.db,
      input.repo_id,
      event.task_id,
    );
    if (sessions.length === 0) {
      result.unlinked += 1;
      continue;
    }
    if (sessions.length > 1) {
      result.ambiguous += 1;
      continue;
    }
    const sessionId = sessions[0]!.session_id;
    const key = idempotencyKey(event);
    const requestSha = probeSha256(canonicalProbeJson({
      command: "loop.probe.observe-deviation",
      session_id: sessionId,
      source_revision: input.source_revision,
      event,
      evidence_refs: evidenceRefs,
    }));
    const replay = replayProbeCommand(input.db, {
      scope_key: `session:${sessionId}`,
      idempotency_key: key,
      request_sha256: requestSha,
    });
    if (replay !== undefined) {
      result.replayed += 1;
      continue;
    }

    const state = loadState(input.db, sessionId);
    const questionDigest = probeSha256(canonicalProbeJson({
      repo_id: input.repo_id,
      task_id: event.task_id,
      deviation_id: event.deviation.deviation_id,
    }));
    const questionId = `dynamic.${questionDigest}.v1`;
    if (state.items.some((item) => item.question_id === questionId)) {
      result.duplicate += 1;
      continue;
    }
    const actor = {
      type: "agent" as const,
      id: `loop-verifier:${event.reviewer_agent_id}`.slice(0, 256),
    };
    const batchDigest = probeSha256(canonicalProbeJson({
      loop_id: event.loop_id,
      task_id: event.task_id,
      deviation_id: event.deviation.deviation_id,
    }));
    const batch = {
      schema_version: "1" as const,
      batch_id: `pqb_${batchDigest.slice(0, 24)}`,
      origin: "mid_build" as const,
      generated_by: actor,
      source_revision: input.source_revision,
      questions: [{
        schema_version: "1" as const,
        question_id: questionId,
        item_kind: "risk" as const,
        initial_quadrant: "ku" as const,
        current_quadrant: "ku" as const,
        doc_type: ProbeDocTypeV1.parse(event.deviation.doc_type),
        category: ProbeCategoryV1.parse(event.deviation.category),
        origin: "mid_build" as const,
        prompt: event.deviation.question,
        options: [],
        impact: event.deviation.impact,
        irreversibility: event.deviation.irreversibility,
        uncertainty: event.deviation.uncertainty,
        required: event.deviation.required,
        evidence_refs: evidenceRefs,
        destination_hint: ProbeDestinationRoleV1.parse(
          event.deviation.destination_hint,
        ),
      }],
    };
    const dynamic = await materializeProbeQuestionBatch({
      batch,
      session_id: sessionId,
      source_revision: input.source_revision,
      actor,
      existing_items: state.items,
      created_at_ms: input.now_ms,
      create_item_id: input.create_item_id,
      verify_evidence: async (evidence) => ({
        verifiable: evidenceRefs.some((candidate) =>
          canonicalProbeJson(candidate) === canonicalProbeJson(evidence),
        ),
      }),
    });
    const next = applyProbeMutation(state, {
      type: "add",
      items: dynamic.items,
      batch_id: batch.batch_id,
      origin: "mid_build",
      source_revision: input.source_revision,
      if_revision: state.session.revision,
      actor,
      idempotency_key: key,
      event_id: input.create_event_id(),
      occurred_at_ms: input.now_ms,
    });
    const receiptResult = JSON.stringify({
      command: "loop.probe.observe-deviation",
      session_id: sessionId,
      loop_event_id: event.event_id,
      deviation_id: event.deviation.deviation_id,
      item_ids: dynamic.items.map((item) => item.item_id),
      revision: next.session.revision,
    });
    mutateProbeSession(input.db, {
      session_id: sessionId,
      expected_revision: state.session.revision,
      session: {
        state: next.session.state,
        revision: next.session.revision,
        snapshot_json: JSON.stringify(next.session),
        updated_at_ms: next.session.updated_at_ms,
      },
      items: storedItems(next.items),
      event: {
        event_id: next.event.event_id,
        revision: next.event.revision,
        type: next.event.type,
        idempotency_key: next.event.idempotency_key,
        event_json: JSON.stringify(next.event),
        occurred_at_ms: next.event.occurred_at_ms,
      },
      receipt: {
        scope_key: `session:${sessionId}`,
        idempotency_key: key,
        request_sha256: requestSha,
        result_json: receiptResult,
        created_at_ms: input.now_ms,
      },
    });
    result.added += 1;
  }

  return result;
}
