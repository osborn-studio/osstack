import {
  type checkKnowledgeHygiene,
  checkKnowledgeHygieneV2,
  type KnowledgeHygieneReportV1,
  type KnowledgeHygieneReportV2,
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
      report: KnowledgeHygieneReportV1 | KnowledgeHygieneReportV2;
    }
  | {
      command: "knowledge_hygiene.check";
      status: "error";
      error: string;
    };

export interface LoopNeatFinalizerDepsV1 {
  check?: (
    input: Parameters<typeof checkKnowledgeHygiene>[0],
  ) => Promise<KnowledgeHygieneReportV1 | KnowledgeHygieneReportV2>;
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
    const report = deps.check === undefined
      ? await checkKnowledgeHygieneV2({
          schema_version: "2",
          repo_root: input.workspace_path,
          mode: "all",
        })
      : await deps.check({
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
