import { z } from "zod";

export const CheckState = z.enum(["success", "failure", "pending", "unknown"]);
export type CheckState = z.infer<typeof CheckState>;

export const BranchAction = z.enum(["report", "create_pr", "enable_auto_merge", "escalate"]);
export type BranchAction = z.infer<typeof BranchAction>;

export const BranchCandidate = z.object({
  repo: z.string().min(1),
  base: z.string().min(1),
  head: z.string().min(1),
  remote: z.string().default("origin"),
  aheadBy: z.number().int().min(0),
  behindBy: z.number().int().min(0),
  changedFiles: z.number().int().min(0),
  additions: z.number().int().min(0),
  deletions: z.number().int().min(0),
  hasOpenPr: z.boolean().default(false),
  isDraft: z.boolean().optional(),
  checksState: CheckState.default("unknown"),
  sensitivePaths: z.array(z.string()).default([]),
  author: z.string().optional(),
  updatedAt: z.string().optional(),
  title: z.string().optional(),
  reasons: z.array(z.string()).default([]),
  score: z.number().min(0).max(100).default(0),
  action: BranchAction.default("report"),
});
export type BranchCandidate = z.infer<typeof BranchCandidate>;

export const BranchStewardConfig = z.object({
  repo: z.string().min(1),
  base: z.string().default("main"),
  remote: z.string().default("origin"),
  branchPrefixAllowlist: z.array(z.string()).default(["feat/", "feature/", "codex/"]),
  sensitivePathGlobs: z.array(z.string()).default([
    ".github/workflows/",
    "package.json",
    "pnpm-lock.yaml",
  ]),
  maxChangedFiles: z.number().int().min(1).default(80),
  maxBehindBy: z.number().int().min(0).default(25),
  prThreshold: z.number().min(0).max(100).default(80),
  autoMergeThreshold: z.number().min(0).max(100).default(90),
});
export type BranchStewardConfig = z.infer<typeof BranchStewardConfig>;

export const PullRequestIntent = z.object({
  repo: z.string(),
  base: z.string(),
  head: z.string(),
  title: z.string(),
  body: z.string(),
  labels: z.array(z.string()).default(["osstack/steward", "auto-pr"]),
});
export type PullRequestIntent = z.infer<typeof PullRequestIntent>;

export const BranchStewardReport = z.object({
  repo: z.string(),
  base: z.string(),
  generatedAt: z.string(),
  candidates: z.array(BranchCandidate),
  prIntents: z.array(PullRequestIntent).default([]),
});
export type BranchStewardReport = z.infer<typeof BranchStewardReport>;
