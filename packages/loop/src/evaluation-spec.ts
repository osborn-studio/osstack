// EvaluationSpec — first-class evaluation harness for loop verification.
//
// A task may declare explicit evaluation specs (task queue `evaluation` field).
// Legacy verification inputs are normalized into implicit specs so every
// verification path produces per-evaluation results:
//   --verify CMD                  -> implicit `command` spec
//   artifact verification options -> implicit `artifact` spec
//
// This module owns the schemas plus derivation/aggregation helpers. It must
// not import from ./types.js — types.ts imports these schemas to extend
// Task/Verdict/CompletedTask.

import { z } from "zod";

export const EvaluationMode = z.enum([
  "command",
  "contract",
  "property",
  "e2e",
  "artifact",
  "semantic_review",
  "governance",
]);
export type EvaluationMode = z.infer<typeof EvaluationMode>;

export const EvaluationSpec = z.object({
  id: z.string().min(1),
  mode: EvaluationMode,
  description: z.string(),
  required: z.boolean().default(true),
  command: z.string().optional(),
  target_paths: z.array(z.string()).default([]),
  forbidden_paths: z.array(z.string()).default([]),
  acceptance: z.string().optional(),
  weight: z.number().min(0).max(1).default(1),
});
export type EvaluationSpec = z.infer<typeof EvaluationSpec>;

/** Per-spec outcome surfaced in the Verdict and persisted in CompletedTask. */
export const EvaluationResult = z.object({
  spec_id: z.string(),
  mode: EvaluationMode,
  description: z.string(),
  required: z.boolean(),
  weight: z.number().min(0).max(1),
  pass: z.boolean(),
  summary: z.string(),
  /** True when the spec was derived from legacy flags rather than declared on the task. */
  implicit: z.boolean().default(false),
});
export type EvaluationResult = z.infer<typeof EvaluationResult>;

export function parseEvaluationSpecs(raw: unknown): EvaluationSpec[] {
  return z.array(EvaluationSpec).parse(raw);
}

/** Normalize a legacy `--verify CMD` into an implicit command evaluation spec. */
export function implicitCommandSpec(command: string, index: number): EvaluationSpec {
  return EvaluationSpec.parse({
    id: `verify-command-${index + 1}`,
    mode: "command",
    description: `Shell verifier: ${command}`,
    command,
  });
}

export interface ImplicitArtifactInput {
  requireGitDiff?: boolean;
  targetPaths?: string[];
  forbiddenPaths?: string[];
}

/** Normalize legacy artifact verification options into an implicit artifact spec. */
export function implicitArtifactSpec(input: ImplicitArtifactInput): EvaluationSpec {
  return EvaluationSpec.parse({
    id: "verify-artifact",
    mode: "artifact",
    description: "Artifact verification: git diff and path gates",
    target_paths: input.targetPaths ?? [],
    forbidden_paths: input.forbiddenPaths ?? [],
  });
}

/** Specs a verifier adapter should judge (no local command, not artifact-gated). */
export function isAdapterEvaluationSpec(spec: EvaluationSpec): boolean {
  return spec.command === undefined && spec.mode !== "artifact" && spec.mode !== "command";
}

/** Specs verified by running their shell command locally. */
export function isCommandEvaluationSpec(spec: EvaluationSpec): boolean {
  return spec.command !== undefined && spec.command.trim() !== "";
}

/**
 * Weighted evaluation score in [0, 1]. Zero total weight (or no results)
 * falls back to binary pass so legacy verdict scores stay 0/1.
 */
export function evaluationScore(results: readonly EvaluationResult[], pass: boolean): number {
  const totalWeight = results.reduce((sum, result) => sum + result.weight, 0);
  if (totalWeight === 0) return pass ? 1 : 0;
  const passedWeight = results
    .filter((result) => result.pass)
    .reduce((sum, result) => sum + result.weight, 0);
  return passedWeight / totalWeight;
}

export function failedEvaluationIds(results: readonly EvaluationResult[]): string[] {
  return results.filter((result) => !result.pass).map((result) => result.spec_id);
}
