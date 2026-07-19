import { Buffer } from "node:buffer";
import { parseDocument } from "yaml";
import { z, ZodError } from "zod";
import {
  KnowledgeHygieneConfigError,
  KnowledgeHygieneConfigV1Schema,
  type KnowledgeHygieneConfigV1,
} from "./config.js";
import { assertKnowledgeHygienePathPatternV1 } from "./path-pattern.js";
import {
  KnowledgeHygieneEvidenceRefV2,
  KnowledgeHygieneRuleIdV2,
} from "./types-v2.js";

const MAX_CONFIG_BYTES = 1024 * 1024;

const repositoryPattern = z
  .string()
  .trim()
  .min(1)
  .superRefine((value, context) => {
    try {
      assertKnowledgeHygienePathPatternV1(value);
    } catch (error) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

export const SemanticDimensionV2 = z.enum([
  "narrative",
  "contradiction",
  "drift",
  "memory_overlap",
]);
export type SemanticDimensionV2 = z.infer<typeof SemanticDimensionV2>;

const defaultSemanticConfig: {
  enabled: boolean;
  dimensions: SemanticDimensionV2[];
  schedule: "manual";
  max_input_tokens: number;
  max_output_tokens: number;
  max_calls: number;
} = {
  enabled: false,
  dimensions: ["narrative"],
  schedule: "manual",
  max_input_tokens: 32_000,
  max_output_tokens: 4_000,
  max_calls: 8,
};

export const SemanticConfigV2Schema = z
  .object({
    enabled: z.boolean(),
    judge_id: z.string().trim().min(1).optional(),
    dimensions: z.array(SemanticDimensionV2).min(1).default(["narrative"]),
    schedule: z.enum(["manual", "daily"]).default("manual"),
    max_input_tokens: z.number().int().min(1).max(250_000).default(32_000),
    max_output_tokens: z.number().int().min(1).max(32_000).default(4_000),
    max_calls: z.number().int().min(1).max(64).default(8),
  })
  .strict()
  .superRefine((semantic, context) => {
    if (new Set(semantic.dimensions).size !== semantic.dimensions.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["dimensions"],
        message: "semantic dimensions must be unique",
      });
    }
    if (semantic.enabled && semantic.judge_id === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["judge_id"],
        message: "enabled semantic audit requires judge_id",
      });
    }
    if (
      !semantic.enabled
      && (semantic.judge_id !== undefined || semantic.schedule === "daily")
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "disabled semantic audit cannot configure a judge or daily schedule",
      });
    }
    if (
      semantic.schedule === "daily"
      && (semantic.dimensions.length !== 1 || semantic.dimensions[0] !== "narrative")
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["dimensions"],
        message: "daily semantic audit supports only the narrative dimension",
      });
    }
  });
export type SemanticConfigV2 = z.infer<typeof SemanticConfigV2Schema>;

const dependencyKind = z.enum([
  "api",
  "sdk",
  "env_name",
  "url",
  "symbol",
  "path",
]);

export const DeclaredDependencyV2Schema = z
  .object({
    edge_id: z.string().regex(/^khe_[a-f0-9]{64}$/),
    upstream_repo_id: z.string().trim().min(1),
    direction: z.literal("depends_on"),
    kinds: z.array(dependencyKind).min(1),
    owner: z.string().trim().min(1),
    evidence_refs: z.array(KnowledgeHygieneEvidenceRefV2).min(1),
    confirmed_at: z.string().datetime(),
    review_after: z.string().datetime(),
  })
  .strict()
  .superRefine((dependency, context) => {
    if (new Set(dependency.kinds).size !== dependency.kinds.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["kinds"],
        message: "dependency kinds must be unique",
      });
    }
    const evidenceKeys = dependency.evidence_refs.map((reference) =>
      JSON.stringify(reference)
    );
    if (new Set(evidenceKeys).size !== evidenceKeys.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["evidence_refs"],
        message: "dependency evidence references must be unique",
      });
    }
    if (Date.parse(dependency.review_after) <= Date.parse(dependency.confirmed_at)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["review_after"],
        message: "review_after must be after confirmed_at",
      });
    }
  });
export type DeclaredDependencyV2 = z.infer<typeof DeclaredDependencyV2Schema>;

const configV1Object = KnowledgeHygieneConfigV1Schema.innerType();
const configV2Object = configV1Object
  .omit({ version: true, ignore: true })
  .extend({
    version: z.literal(2),
    ignore: z
      .array(
        z
          .object({
            rule_id: KnowledgeHygieneRuleIdV2,
            paths: z
              .array(repositoryPattern)
              .min(1)
              .refine(
                (paths) => new Set(paths).size === paths.length,
                "ignore paths must be unique",
              )
              .refine((paths) => !paths.includes("**"), {
                message: "a broad '**' suppression is not allowed",
              }),
            reason: z.string().trim().min(1),
          })
          .strict(),
      )
      .default([]),
    semantic: SemanticConfigV2Schema.default(defaultSemanticConfig),
    dependencies: z.array(DeclaredDependencyV2Schema).default([]),
  })
  .strict();

export const KnowledgeHygieneConfigV2Schema = configV2Object.superRefine(
  (config, context) => {
    const v1Projection: Record<string, unknown> = {
      ...config,
      version: 1,
      ignore: [],
    };
    delete v1Projection.semantic;
    delete v1Projection.dependencies;
    const v1CommonResult = KnowledgeHygieneConfigV1Schema.safeParse(
      v1Projection,
    );
    if (!v1CommonResult.success) {
      for (const issue of v1CommonResult.error.issues) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: issue.path,
          message: issue.message,
        });
      }
    }

    const ignoreKeys = config.ignore.map((entry) =>
      `${entry.rule_id}\0${entry.paths.join("\0")}`
    );
    if (new Set(ignoreKeys).size !== ignoreKeys.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["ignore"],
        message: "ignore entries must be unique",
      });
    }
    const edgeIds = config.dependencies.map((dependency) => dependency.edge_id);
    if (new Set(edgeIds).size !== edgeIds.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["dependencies"],
        message: "dependency edge_id values must be unique",
      });
    }
  },
);
export type KnowledgeHygieneConfigV2 = z.infer<
  typeof KnowledgeHygieneConfigV2Schema
>;

function zodDetails(error: ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join(".") : "config";
    return `${path}: ${issue.message}`;
  });
}

export function parseKnowledgeHygieneConfigV2(
  source: string,
): KnowledgeHygieneConfigV2 {
  if (Buffer.byteLength(source, "utf8") > MAX_CONFIG_BYTES) {
    throw new KnowledgeHygieneConfigError(
      "read",
      `neat config exceeds ${MAX_CONFIG_BYTES} byte limit`,
    );
  }
  const document = parseDocument(source, { uniqueKeys: true });
  if (document.errors.length > 0) {
    throw new KnowledgeHygieneConfigError(
      "parse",
      "invalid neat YAML",
      document.errors.map((error) => error.message),
    );
  }

  let value: unknown;
  try {
    value = document.toJS({ maxAliasCount: 50 });
  } catch (error) {
    throw new KnowledgeHygieneConfigError(
      "parse",
      "invalid neat YAML expansion",
      [error instanceof Error ? error.message : String(error)],
    );
  }

  try {
    return KnowledgeHygieneConfigV2Schema.parse(value);
  } catch (error) {
    if (error instanceof ZodError) {
      throw new KnowledgeHygieneConfigError(
        "validation",
        "invalid neat config",
        zodDetails(error),
      );
    }
    throw error;
  }
}

export function projectKnowledgeHygieneConfigV1ToV2(
  config: KnowledgeHygieneConfigV1,
): KnowledgeHygieneConfigV2 {
  return KnowledgeHygieneConfigV2Schema.parse({
    ...config,
    version: 2,
    semantic: defaultSemanticConfig,
    dependencies: [],
  });
}
