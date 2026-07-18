import { z } from "zod";
import {
  ProbeCategoryV1,
  ProbeRepositoryRelativePathV1,
  type ProbeCompilationV1,
  type ProbeItemV1,
} from "./types.js";

const identifier = z.string().regex(/^[a-z0-9][a-z0-9._-]{1,127}$/);
const itemId = z.string().regex(/^pi_[a-z0-9][a-z0-9_-]{7,63}$/);

export const ProbeEvaluationSpecV1 = z
  .object({
    id: z.string().trim().min(1).max(256),
    mode: z.enum([
      "command",
      "contract",
      "property",
      "e2e",
      "artifact",
      "semantic_review",
      "governance",
    ]),
    description: z.string().trim().min(1).max(2_000),
    required: z.boolean(),
    command: z.string().trim().min(1).max(4_000).optional(),
    target_paths: z.array(ProbeRepositoryRelativePathV1).max(32),
    forbidden_paths: z.array(ProbeRepositoryRelativePathV1).max(32),
    acceptance: z.string().trim().min(1).max(4_000).optional(),
    weight: z.number().min(0).max(1).finite(),
  })
  .strict();
export type ProbeEvaluationSpecV1 = z.infer<typeof ProbeEvaluationSpecV1>;

const commonParams = {
  description: z.string().trim().min(1).max(2_000),
  required: z.boolean().default(true),
  weight: z.number().min(0).max(1).finite().default(1),
};

const packageScriptRequest = z
  .object({
    item_id: itemId,
    template_id: z.literal("package-script.v1"),
    params: z
      .object({
        ...commonParams,
        package_path: ProbeRepositoryRelativePathV1,
        script: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9:._-]{0,127}$/),
      })
      .strict(),
  })
  .strict();

const artifactPathRequest = z
  .object({
    item_id: itemId,
    template_id: z.literal("artifact-path.v1"),
    params: z
      .object({
        ...commonParams,
        path: ProbeRepositoryRelativePathV1,
        expectation: z.enum(["exists", "absent"]),
      })
      .strict(),
  })
  .strict();

const contractManifestRequest = z
  .object({
    item_id: itemId,
    template_id: z.literal("contract-manifest.v1"),
    params: z
      .object({
        ...commonParams,
        manifest_path: ProbeRepositoryRelativePathV1,
        manifest_id: identifier,
      })
      .strict(),
  })
  .strict();

const manualAcceptanceRequest = z
  .object({
    item_id: itemId,
    template_id: z.literal("manual-acceptance.v1"),
    params: z
      .object({
        acceptance: z.string().trim().min(1).max(4_000),
        reason: z.string().trim().min(1).max(2_000),
      })
      .strict(),
  })
  .strict();

export const ProbeEvaluationCompilationRequestV1 = z.discriminatedUnion(
  "template_id",
  [
    packageScriptRequest,
    artifactPathRequest,
    contractManifestRequest,
    manualAcceptanceRequest,
  ],
);
export type ProbeEvaluationCompilationRequestV1 = z.infer<
  typeof ProbeEvaluationCompilationRequestV1
>;

export const ProbeEvaluationCompilationBatchV1 = z
  .object({
    schema_version: z.literal("1"),
    requests: z.array(ProbeEvaluationCompilationRequestV1).min(1).max(100),
  })
  .strict()
  .superRefine((batch, context) => {
    const ids = batch.requests.map((request) => request.item_id);
    if (new Set(ids).size !== ids.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["requests"],
        message: "an item may have only one compilation request per batch",
      });
    }
  });
export type ProbeEvaluationCompilationBatchV1 = z.infer<
  typeof ProbeEvaluationCompilationBatchV1
>;

export const ProbeEvaluationCompilationDeltaV1 = z
  .object({
    schema_version: z.literal("1"),
    session_id: z.string().regex(/^probe_[a-z0-9][a-z0-9_-]{7,63}$/),
    exported_revision: z.number().int().positive(),
    generated_at_ms: z.number().int().nonnegative(),
    spec_ref: ProbeRepositoryRelativePathV1,
    evaluations: z.array(ProbeEvaluationSpecV1).max(100),
    compilations: z
      .array(
        z
          .object({
            item_id: itemId,
            template_id: z.enum([
              "package-script.v1",
              "artifact-path.v1",
              "contract-manifest.v1",
              "manual-acceptance.v1",
            ]),
            compilation: z.union([
              z
                .object({
                  state: z.literal("manual_required"),
                  reason: z.string().trim().min(1).max(20_000),
                })
                .strict(),
              z
                .object({
                  state: z.literal("compiled"),
                  spec_ref: ProbeRepositoryRelativePathV1,
                  template_id: identifier,
                })
                .strict(),
            ]),
            manual_acceptance: z.string().trim().min(1).max(4_000).optional(),
            evaluation_ids: z.array(z.string().trim().min(1)).max(8),
          })
          .strict()
          .superRefine((entry, context) => {
            if (
              (entry.compilation.state === "manual_required") !==
              (entry.manual_acceptance !== undefined)
            ) {
              context.addIssue({
                code: z.ZodIssueCode.custom,
                path: ["manual_acceptance"],
                message:
                  "manual acceptance is required only for manual_required compilation",
              });
            }
          }),
      )
      .min(1)
      .max(100),
  })
  .strict();
export type ProbeEvaluationCompilationDeltaV1 = z.infer<
  typeof ProbeEvaluationCompilationDeltaV1
>;

export interface ProbeEvaluationCompilerEnvironmentV1 {
  verify_package_script: (
    packagePath: string,
    script: string,
  ) => Promise<void>;
  verify_artifact_path: (path: string) => Promise<void>;
  verify_contract_manifest: (
    manifestPath: string,
    manifestId: string,
  ) => Promise<void>;
}

export interface CompileProbeEvaluationsInputV1 {
  batch: unknown;
  session_id: string;
  exported_revision: number;
  generated_at_ms: number;
  spec_ref: string;
  items: readonly ProbeItemV1[];
  environment: ProbeEvaluationCompilerEnvironmentV1;
}

export class ProbeEvaluationCompilerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProbeEvaluationCompilerError";
  }
}

const acceptedCategories = {
  "package-script.v1": new Set<z.infer<typeof ProbeCategoryV1>>([
    "performance",
    "security",
    "migration",
    "rollback",
    "acceptance",
    "environment",
  ]),
  "artifact-path.v1": new Set<z.infer<typeof ProbeCategoryV1>>([
    "scope",
    "migration",
    "rollback",
    "acceptance",
    "environment",
  ]),
  "contract-manifest.v1": new Set<z.infer<typeof ProbeCategoryV1>>([
    "interface",
    "security",
    "acceptance",
  ]),
  "manual-acceptance.v1": new Set(ProbeCategoryV1.options),
} as const;

function shQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function evaluationId(itemIdValue: string, suffix: string): string {
  return `probe.${itemIdValue}.${suffix}`;
}

export async function compileProbeEvaluations(
  input: CompileProbeEvaluationsInputV1,
): Promise<ProbeEvaluationCompilationDeltaV1> {
  const batch = ProbeEvaluationCompilationBatchV1.parse(input.batch);
  const specRef = ProbeRepositoryRelativePathV1.parse(input.spec_ref);
  const items = new Map(input.items.map((item) => [item.item_id, item]));
  const evaluations: ProbeEvaluationSpecV1[] = [];
  const compilations: Array<{
    item_id: string;
    template_id: ProbeEvaluationCompilationRequestV1["template_id"];
    compilation: ProbeCompilationV1;
    manual_acceptance?: string;
    evaluation_ids: string[];
  }> = [];

  for (const request of batch.requests) {
    const item = items.get(request.item_id);
    if (item === undefined || item.state !== "resolved") {
      throw new ProbeEvaluationCompilerError(
        `compilation requires a resolved item: ${request.item_id}`,
      );
    }
    if (!acceptedCategories[request.template_id].has(item.category)) {
      throw new ProbeEvaluationCompilerError(
        `${request.template_id} does not accept category ${item.category}`,
      );
    }
    if (request.template_id === "manual-acceptance.v1") {
      compilations.push({
        item_id: item.item_id,
        template_id: request.template_id,
        compilation: {
          state: "manual_required",
          reason: request.params.reason,
        },
        manual_acceptance: request.params.acceptance,
        evaluation_ids: [],
      });
      continue;
    }

    let evaluation: ProbeEvaluationSpecV1;
    if (request.template_id === "package-script.v1") {
      await input.environment.verify_package_script(
        request.params.package_path,
        request.params.script,
      );
      evaluation = ProbeEvaluationSpecV1.parse({
        id: evaluationId(item.item_id, "package-script"),
        mode: "command",
        description: request.params.description,
        required: request.params.required,
        command: `pnpm --dir ${shQuote(request.params.package_path)} run ${request.params.script}`,
        target_paths: [],
        forbidden_paths: [],
        weight: request.params.weight,
      });
    } else if (request.template_id === "artifact-path.v1") {
      await input.environment.verify_artifact_path(request.params.path);
      evaluation = ProbeEvaluationSpecV1.parse({
        id: evaluationId(item.item_id, "artifact-path"),
        mode: "artifact",
        description: request.params.description,
        required: request.params.required,
        command:
          request.params.expectation === "exists"
            ? `test -e ${shQuote(request.params.path)}`
            : `test ! -e ${shQuote(request.params.path)}`,
        target_paths:
          request.params.expectation === "exists"
            ? [request.params.path]
            : [],
        forbidden_paths:
          request.params.expectation === "absent"
            ? [request.params.path]
            : [],
        weight: request.params.weight,
      });
    } else {
      await input.environment.verify_contract_manifest(
        request.params.manifest_path,
        request.params.manifest_id,
      );
      evaluation = ProbeEvaluationSpecV1.parse({
        id: evaluationId(item.item_id, "contract-manifest"),
        mode: "contract",
        description: request.params.description,
        required: request.params.required,
        target_paths: [request.params.manifest_path],
        forbidden_paths: [],
        acceptance: `Contract manifest ${request.params.manifest_id} at ${request.params.manifest_path} must remain satisfied.`,
        weight: request.params.weight,
      });
    }
    evaluations.push(evaluation);
    compilations.push({
      item_id: item.item_id,
      template_id: request.template_id,
      compilation: {
        state: "compiled",
        spec_ref: specRef,
        template_id: request.template_id,
      },
      evaluation_ids: [evaluation.id],
    });
  }

  return ProbeEvaluationCompilationDeltaV1.parse({
    schema_version: "1",
    session_id: input.session_id,
    exported_revision: input.exported_revision,
    generated_at_ms: input.generated_at_ms,
    spec_ref: specRef,
    evaluations,
    compilations,
  });
}
