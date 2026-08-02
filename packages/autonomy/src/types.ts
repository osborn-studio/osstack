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
    let porcelainPaths: string[] = [];
    try {
      porcelainPaths = parseStagedPorcelainV1ZPaths(
        input.status_porcelain_v1_z,
      );
    } catch (error) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["status_porcelain_v1_z"],
        message:
          error instanceof Error ? error.message : "invalid staged porcelain",
      });
    }
    if (
      JSON.stringify(input.changed_paths) !== JSON.stringify(porcelainPaths)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["changed_paths"],
        message:
          "changed_paths must exactly match status_porcelain_v1_z paths",
      });
    }
    if (
      porcelainPaths.length === 0 &&
      input.staged_diff_binary.length > 0
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["staged_diff_binary"],
        message: "staged diff must be empty when staged porcelain is empty",
      });
    }
    if (
      porcelainPaths.length > 0 &&
      input.staged_diff_binary.length === 0
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["staged_diff_binary"],
        message: "staged diff must not be empty when staged paths exist",
      });
    }

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

/**
 * Parse `git status --porcelain=v1 -z` after `git add -A`.
 *
 * Only fully staged, non-conflicted records are accepted. A non-space worktree
 * status would mean the candidate changed again after staging and is therefore
 * not the material represented by the cached diff.
 */
export function parseStagedPorcelainV1ZPaths(status: string): string[] {
  if (status === "") return [];
  if (!status.endsWith("\0")) {
    throw new Error("staged porcelain must be NUL terminated");
  }

  const records = status.split("\0");
  records.pop();
  const paths: string[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]!;
    if (record.length < 4 || record[2] !== " ") {
      throw new Error("invalid porcelain v1 -z record");
    }
    const code = record.slice(0, 2);
    if (!/^[MADRC] $/.test(code)) {
      throw new Error(
        `porcelain record ${JSON.stringify(code)} is not fully staged`,
      );
    }
    const path = record.slice(3);
    if (path.length === 0) {
      throw new Error("staged porcelain path must not be empty");
    }
    paths.push(path);

    if (code[0] === "R" || code[0] === "C") {
      index += 1;
      const originalPath = records[index];
      if (originalPath === undefined || originalPath.length === 0) {
        throw new Error("rename/copy porcelain record is missing original path");
      }
      paths.push(originalPath);
    }
  }
  return [...new Set(paths)].sort();
}

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
