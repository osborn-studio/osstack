import { z } from "zod";

const SHA256 = z.string().regex(/^[a-f0-9]{64}$/);
const GitCommitSha = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);

function canonicalStringList(options: { min?: number } = {}) {
  const schema =
    options.min === undefined
      ? z.array(z.string().min(1))
      : z.array(z.string().min(1)).min(options.min);
  return schema.superRefine((values, context) => {
    if (new Set(values).size !== values.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "list must not contain duplicate values",
      });
    }
    const sorted = [...values].sort();
    if (values.some((value, index) => value !== sorted[index])) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "list must use canonical lexical order",
      });
    }
  });
}

export const AutonomyTaskIntent = z
  .object({
    autonomy_run_id: z.string().min(1),
    task_id: z.string().min(1),
    repo_id: z.string().min(1),
    workspace_path: z.string().min(1),
    goal: z.string().min(1),
    expected_paths: canonicalStringList(),
    requested_actions: canonicalStringList({ min: 1 }),
    contract_sha256: SHA256,
  })
  .strict();
export type AutonomyTaskIntent = z.infer<typeof AutonomyTaskIntent>;

const DependencyChange = z
  .object({
    name: z.string().min(1),
    from: z.string().min(1).optional(),
    to: z.string().min(1).optional(),
    major: z.boolean(),
  })
  .strict();

export const PostDiffInput = z
  .object({
    base_commit_sha: GitCommitSha,
    changed_paths: canonicalStringList(),
    staged_diff_binary: z.string(),
    status_porcelain_v1_z: z.string(),
    commands: z.array(z.string().min(1)),
    dependency_changes: z.array(DependencyChange),
  })
  .strict()
  .superRefine((input, context) => {
    const dependencyNames = input.dependency_changes.map((change) => change.name);
    if (new Set(dependencyNames).size !== dependencyNames.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["dependency_changes"],
        message: "dependency_changes must not contain duplicate package names",
      });
    }
    const sortedNames = [...dependencyNames].sort();
    if (dependencyNames.some((name, index) => name !== sortedNames[index])) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["dependency_changes"],
        message: "dependency_changes must use canonical package-name order",
      });
    }
  });
export type PostDiffInput = z.infer<typeof PostDiffInput>;

export const DeliveryBudget = z
  .object({
    max_builder_iterations: z.number().int().min(1).max(10).default(3),
    max_review_rounds: z.number().int().min(1).max(10).default(3),
    max_wall_time_ms: z
      .number()
      .int()
      .min(1_000)
      .max(86_400_000)
      .default(5_400_000),
    max_no_progress_rounds: z.number().int().min(1).max(5).default(2),
  })
  .strict();
export type DeliveryBudget = z.infer<typeof DeliveryBudget>;
