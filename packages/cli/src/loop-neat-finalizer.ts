import {
  checkKnowledgeHygiene,
  type KnowledgeHygieneReportV1,
} from "@osstack/governance";

export interface LoopNeatFinalizerInputV1 {
  enabled: boolean;
  loop_succeeded: boolean;
  workspace_path: string;
}

export type LoopNeatFinalizerResultV1 =
  | {
      command: "knowledge_hygiene.check";
      status: "ok";
      report: KnowledgeHygieneReportV1;
    }
  | {
      command: "knowledge_hygiene.check";
      status: "error";
      error: string;
    };

export interface LoopNeatFinalizerDepsV1 {
  check?: typeof checkKnowledgeHygiene;
}

/**
 * Optional application finalizer. It calls the governance API directly, never
 * the CLI or LoopEngine, so it cannot recurse into another loop. Errors are
 * returned as evidence and deliberately never thrown into the loop outcome.
 */
export async function runLoopNeatFinalizer(
  input: LoopNeatFinalizerInputV1,
  deps: LoopNeatFinalizerDepsV1 = {},
): Promise<LoopNeatFinalizerResultV1 | undefined> {
  if (!input.enabled || !input.loop_succeeded) return undefined;
  try {
    const report = await (deps.check ?? checkKnowledgeHygiene)({
      repo_root: input.workspace_path,
      mode: "all",
    });
    return {
      command: "knowledge_hygiene.check",
      status: "ok",
      report,
    };
  } catch (error) {
    return {
      command: "knowledge_hygiene.check",
      status: "error",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
