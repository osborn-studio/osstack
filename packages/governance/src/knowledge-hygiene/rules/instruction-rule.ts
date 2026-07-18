import type { InstructionSourceObservationV1 } from "../instruction-source.js";
import type { KnowledgeHygieneRuleV1 } from "./rule-types.js";
import { createRuleFinding } from "./rule-types.js";

const canonicalMissingRule: KnowledgeHygieneRuleV1 = {
  id: "instruction.canonical_missing",
  version: "1",
  default_severity: "error",
  evaluate(input) {
    const instructions = input.config?.instructions;
    if (!instructions) return [];
    const canonical = input.inventory.surfaces.find(
      (surface) => surface.path === instructions.canonical,
    );
    if (canonical?.exists && canonical.kind === "file") return [];
    return [createRuleFinding(this, input, {
      path: instructions.canonical,
      anchor: `canonical:${instructions.canonical}`,
      surface: "instruction",
      severity: "error",
      confidence: "high",
      observed: {
        exists: canonical?.exists ?? false,
        kind: canonical?.kind ?? null,
      },
      expected: { exists: true, kind: "file" },
      rationale: "The configured canonical instruction source is missing.",
      remediation: { mode: "agent_edit" },
    })];
  },
};

function configuredMirror(
  input: Parameters<KnowledgeHygieneRuleV1["evaluate"]>[0],
  observation: InstructionSourceObservationV1,
) {
  return input.config?.instructions?.mirrors.find(
    (mirror) => mirror.path === observation.mirror_path,
  );
}

const mirrorMissingRule: KnowledgeHygieneRuleV1 = {
  id: "instruction.mirror_missing",
  version: "1",
  default_severity: "warning",
  evaluate(input) {
    if (!input.config?.instructions) return [];
    return input.instruction_observations.flatMap((observation) => {
      if (
        observation.status !== "mirror_missing" &&
        observation.status !== "both_missing"
      ) return [];
      const mirror = configuredMirror(input, observation);
      if (!mirror) return [];
      const safePatch = mirror.mode !== "symlink";
      return [createRuleFinding(this, input, {
        path: mirror.path,
        anchor: `mirror:${mirror.path}`,
        surface: "instruction",
        severity: "warning",
        confidence: "high",
        observed: { exists: false },
        expected: { exists: true, mode: mirror.mode },
        rationale: "The configured instruction mirror is missing.",
        remediation: safePatch
          ? { mode: "safe_patch", action_id: `create_import_mirror:${mirror.path}` }
          : { mode: "agent_edit" },
      })];
    });
  },
};

const mirrorDriftRule: KnowledgeHygieneRuleV1 = {
  id: "instruction.mirror_drift",
  version: "1",
  default_severity: "error",
  evaluate(input) {
    return input.instruction_observations.flatMap((observation) => {
      if (observation.status !== "mirror_drift") return [];
      const mirror = configuredMirror(input, observation);
      if (input.config?.instructions && !mirror) return [];
      return [createRuleFinding(this, input, {
        path: observation.mirror_path,
        anchor: `mirror:${observation.mirror_path}`,
        surface: "instruction",
        severity: mirror ? "error" : "warning",
        confidence: "high",
        observed: { reason: observation.reason },
        expected: {
          canonical: observation.canonical_path,
          mode: mirror?.mode ?? "import_or_symlink",
        },
        rationale: "The instruction mirror does not resolve to the canonical source.",
        remediation: { mode: "human_decision" },
      })];
    });
  },
};

export const INSTRUCTION_RULES_V1 = Object.freeze([
  canonicalMissingRule,
  mirrorMissingRule,
  mirrorDriftRule,
] satisfies readonly KnowledgeHygieneRuleV1[]);
