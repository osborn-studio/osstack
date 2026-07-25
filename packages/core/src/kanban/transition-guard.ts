import type { CardStatus } from "./schema.js";

export interface KanbanTransitionGuardInput {
  cardId: string;
  from: CardStatus;
  to: CardStatus;
  workspacePath: string;
}

export interface KanbanTransitionGuardDecision {
  allow: boolean;
  reason: string;
  evidenceRefs: readonly string[];
}

export interface KanbanTransitionGuard {
  id: string;
  evaluate(
    input: KanbanTransitionGuardInput,
  ): Promise<KanbanTransitionGuardDecision>;
}

export interface EvaluatedKanbanTransitionGuardDecision
  extends KanbanTransitionGuardDecision {
  guardId: string;
}

export interface KanbanTransitionGuardResult {
  allow: boolean;
  decisions: EvaluatedKanbanTransitionGuardDecision[];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Evaluate the full guard set before a caller performs any transition write.
 * Guards run concurrently, results retain registration order, and one broken
 * guard fails closed without preventing the other guards from being observed.
 */
export async function evaluateKanbanTransitionGuards(
  guards: readonly KanbanTransitionGuard[],
  input: KanbanTransitionGuardInput,
): Promise<KanbanTransitionGuardResult> {
  const decisions = await Promise.all(
    guards.map(async (guard): Promise<EvaluatedKanbanTransitionGuardDecision> => {
      try {
        const decision = await guard.evaluate(input);
        if (
          typeof decision.allow !== "boolean" ||
          typeof decision.reason !== "string" ||
          !Array.isArray(decision.evidenceRefs) ||
          !decision.evidenceRefs.every((ref) => typeof ref === "string")
        ) {
          throw new Error("invalid guard decision");
        }
        return {
          guardId: guard.id,
          allow: decision.allow,
          reason: decision.reason,
          evidenceRefs: [...decision.evidenceRefs],
        };
      } catch (error) {
        return {
          guardId: guard.id,
          allow: false,
          reason: `guard error: ${errorMessage(error)}`,
          evidenceRefs: [],
        };
      }
    }),
  );
  return {
    allow: decisions.every((decision) => decision.allow),
    decisions,
  };
}
