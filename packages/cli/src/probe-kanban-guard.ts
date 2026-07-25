import { getProbeSession, listProbeEvents, listProbeItems, listProbeSessionsByRepo, type KanbanTransitionGuard } from "@osstack/core";
import { guardedOpenDb as openDb } from "./guarded-open-db.js";
import {
  evaluateProbeGate,
  ProbeEventV1,
  ProbeItemV1,
  ProbeSessionV1,
} from "@osstack/governance";
import {
  collectProbeDestinationContent,
  loadProbeGatePolicy,
} from "./probe-gate.js";
import { resolveProbeRepositoryId } from "./probe-command.js";

export interface CreateProbeKanbanTransitionGuardOptionsV1 {
  db_path: string;
  now_ms?: () => number;
}

function linkedTaskRefs(
  db: ReturnType<typeof openDb>,
  cardId: string,
): string[] {
  const row = db
    .prepare("SELECT task_id FROM kanban_cards WHERE card_id = ?")
    .get(cardId) as { task_id: string | null } | undefined;
  return [...new Set([
    cardId,
    ...(row?.task_id === null || row?.task_id === undefined ? [] : [row.task_id]),
  ])];
}

export function createProbeKanbanTransitionGuard(
  options: CreateProbeKanbanTransitionGuardOptionsV1,
): KanbanTransitionGuard {
  return {
    id: "probe-readiness",
    async evaluate(input) {
      if (input.to !== "running") {
        return {
          allow: true,
          reason: "probe readiness applies only before execution",
          evidenceRefs: [],
        };
      }
      const db = openDb({ path: options.db_path });
      try {
        const repoId = await resolveProbeRepositoryId(input.workspacePath);
        const refs = new Set(linkedTaskRefs(db, input.cardId));
        const linked = listProbeSessionsByRepo(db, repoId)
          .map((row) => ({
            row,
            session: ProbeSessionV1.parse(JSON.parse(row.snapshot_json)),
          }))
          .filter(({ session }) =>
            session.task_ref !== undefined &&
            refs.has(session.task_ref) &&
            session.state !== "abandoned"
          );
        const current = linked[0];
        if (current === undefined) {
          return {
            allow: true,
            reason: "no linked probe session",
            evidenceRefs: [],
          };
        }
        const sessionId = current.row.session_id;
        const sessionRow = getProbeSession(db, sessionId);
        if (sessionRow === undefined) throw new Error("linked probe session disappeared");
        const items = listProbeItems(db, sessionId).map((item) =>
          ProbeItemV1.parse(JSON.parse(item.item_json)),
        );
        const events = listProbeEvents(db, sessionId).map((event) =>
          ProbeEventV1.parse(JSON.parse(event.event_json)),
        );
        const loadedPolicy = await loadProbeGatePolicy(input.workspacePath);
        const destinationContent = await collectProbeDestinationContent(
          input.workspacePath,
          items,
        );
        const gate = evaluateProbeGate({
          session: current.session,
          items,
          events,
          policy: loadedPolicy.policy,
          now_ms: (options.now_ms ?? Date.now)(),
          destination_content: destinationContent,
        });
        const violationCodes = gate.readiness.violations
          .filter((violation) => violation.advisory !== true)
          .map((violation) => violation.code);
        return {
          allow: !gate.blocked,
          reason: gate.blocked
            ? `probe readiness denied: ${violationCodes.join(", ") || "not eligible"}`
            : `probe readiness ${gate.enforcement}: ${gate.readiness.eligible ? "eligible" : "advisory violations"}`,
          evidenceRefs: [
            `probe-session:${sessionId}`,
            `probe-policy:${loadedPolicy.source}`,
          ],
        };
      } finally {
        db.close();
      }
    },
  };
}
