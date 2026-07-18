import { z } from "zod";
import {
  KnowledgeSurfaceInventoryV1,
  type KnowledgeSurfaceInventoryV1 as KnowledgeSurfaceInventory,
} from "../types.js";
import type { KnowledgeHygieneRuleV1 } from "../rules/rule-types.js";

const adapterId = z.string().regex(/^[a-z0-9][a-z0-9._-]*$/);

export const AdapterEvidenceSourceV1 = z.object({
  kind: z.literal("official_documentation"),
  ref: z.string().url(),
}).strict();
export type AdapterEvidenceSourceV1 = z.infer<typeof AdapterEvidenceSourceV1>;

export const AdapterDetectionInputV1 = z.object({
  repo_root: z.string().min(1),
  enabled: z.boolean(),
  options: z.record(z.unknown()),
}).strict();
export type AdapterDetectionInputV1 = z.infer<typeof AdapterDetectionInputV1>;

export const AdapterDetectionV1 = z.object({
  adapter_id: adapterId,
  adapter_version: z.string().min(1),
  status: z.enum(["available", "absent"]),
  evidence_source: AdapterEvidenceSourceV1,
  root: z.string().min(1).optional(),
}).strict().superRefine((detection, context) => {
  if (detection.status === "available" && detection.root === undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["root"],
      message: "available adapter detection requires root",
    });
  }
  if (detection.status === "absent" && detection.root !== undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["root"],
      message: "absent adapter detection cannot include root",
    });
  }
});
export type AdapterDetectionV1 = z.infer<typeof AdapterDetectionV1>;

export interface AdapterInventoryInputV1 {
  repo_root: string;
  detection: AdapterDetectionV1;
}

/**
 * R3 adapters expose only read capability. There is intentionally no write,
 * apply, delete, rename, or mutation method in this public contract.
 */
export interface KnowledgeSurfaceAdapterV1 {
  id: string;
  version: string;
  capabilities: readonly ["read"];
  detect(input: AdapterDetectionInputV1): Promise<AdapterDetectionV1>;
  inventory(input: AdapterInventoryInputV1): Promise<KnowledgeSurfaceInventory>;
  rules(): readonly KnowledgeHygieneRuleV1[];
}

export type KnowledgeSurfaceAdapterRunResultV1 =
  | {
      adapter_id: string;
      adapter_version: string;
      status: "disabled";
    }
  | {
      adapter_id: string;
      adapter_version: string;
      status: "absent";
      detection: AdapterDetectionV1;
    }
  | {
      adapter_id: string;
      adapter_version: string;
      status: "available";
      detection: AdapterDetectionV1;
      inventory: KnowledgeSurfaceInventory;
      rules: readonly KnowledgeHygieneRuleV1[];
    };

export async function runKnowledgeSurfaceAdapter(
  adapter: KnowledgeSurfaceAdapterV1,
  rawInput: AdapterDetectionInputV1,
): Promise<KnowledgeSurfaceAdapterRunResultV1> {
  const id = adapterId.parse(adapter.id);
  const version = z.string().min(1).parse(adapter.version);
  if (adapter.capabilities.length !== 1 || adapter.capabilities[0] !== "read") {
    throw new Error(`adapter ${id} must expose read-only capability`);
  }
  const input = AdapterDetectionInputV1.parse(rawInput);
  if (!input.enabled) {
    return { adapter_id: id, adapter_version: version, status: "disabled" };
  }

  const detection = AdapterDetectionV1.parse(await adapter.detect(input));
  if (
    detection.adapter_id !== id
    || detection.adapter_version !== version
  ) {
    throw new Error(`adapter identity mismatch: expected ${id}@${version}`);
  }
  if (detection.status === "absent") {
    return {
      adapter_id: id,
      adapter_version: version,
      status: "absent",
      detection,
    };
  }

  const inventory = KnowledgeSurfaceInventoryV1.parse(await adapter.inventory({
    repo_root: input.repo_root,
    detection,
  }));
  return {
    adapter_id: id,
    adapter_version: version,
    status: "available",
    detection,
    inventory,
    rules: Object.freeze([...adapter.rules()]),
  };
}
