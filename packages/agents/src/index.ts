// @osstack/agents — sub-agent adapter library.
//
// S1.5 ships claude-code (via @anthropic-ai/claude-agent-sdk).
// S2 adds codex-cli (via headless `codex exec --json` subprocess).
// + AutoResearchAdapter (karpathy/autoresearch single-GPU ML loop).
// + ClaudeDesignAdapter / GoogleStitchAdapter (Osstack "design" role).

import type { AgentAdapter } from "./base.js";
import { ClaudeCodeAdapter } from "./adapters/claude-code.js";
import { ClaudeCliAdapter } from "./adapters/claude-cli.js";
import { CodexCliAdapter } from "./adapters/codex-cli.js";
import { OpenCodeCliAdapter } from "./adapters/opencode-cli.js";
import { AutoResearchAdapter } from "./adapters/autoresearch.js";
import { ClaudeDesignAdapter } from "./adapters/claude-design.js";
import { DeepSeekReviewAdapter } from "./adapters/ds-review.js";
import { DeepSeekVerifyAdapter } from "./adapters/ds-verify.js";
import { GoogleStitchAdapter } from "./adapters/google-stitch.js";
import { KimiCodeAdapter } from "./adapters/kimi-code.js";

export * from "./base.js";
export * from "./child-env.js";
export * from "./metadata.js";
export * from "./adapters/kimi-contract.js";
export * from "./adapters/kimi-stream.js";
export * from "./session.js";
export { ClaudeCodeAdapter } from "./adapters/claude-code.js";
export { ClaudeCliAdapter } from "./adapters/claude-cli.js";
export { CodexCliAdapter } from "./adapters/codex-cli.js";
export { OpenCodeCliAdapter } from "./adapters/opencode-cli.js";
export { ClaudeDesignAdapter } from "./adapters/claude-design.js";
export { DeepSeekReviewAdapter } from "./adapters/ds-review.js";
export { DeepSeekVerifyAdapter } from "./adapters/ds-verify.js";
export { GoogleStitchAdapter } from "./adapters/google-stitch.js";
export { KimiCodeAdapter } from "./adapters/kimi-code.js";
export {
  AnthropicNoToolsSemanticJudge,
  type AnthropicNoToolsSemanticJudgeOptions,
} from "./semantic/anthropic-no-tools.js";
export {
  BUILT_IN_SEMANTIC_JUDGE_IDS,
  createBuiltInSemanticJudge,
  type BuiltInSemanticJudgeFactoryOptions,
  type BuiltInSemanticJudgeId,
} from "./semantic/built-in-judges.js";
export {
  DeepSeekNoToolsSemanticJudge,
  type OpenAICompatibleNoToolsSemanticJudgeOptions,
} from "./semantic/openai-compatible-no-tools.js";
export {
  cleanupOrphanedWorktrees,
  cleanupWorktree,
  commitWorktreeChanges,
  createWorktree,
  mergeWorktree,
  type CleanupOrphanedWorktreesResult,
  type CleanupWorktreeOptions,
  type CommitWorktreeResult,
  type CreateWorktreeOptions,
  type WorktreeHandle,
} from "./worktree.js";
export {
  AutoResearchAdapter, parseTrainLog,
  type AutoResearchConfig, type TrainResult,
  type ProposeContext, type ProposeResult, type ProposeFn, type TrainFn, type GitFn,
} from "./adapters/autoresearch.js";

/**
 * The default adapter registry shared by the daemon and the `osstack config` CLI.
 * Single source of truth for "which agents exist". Each adapter's
 * isAvailable() decides whether it's actually usable on this machine.
 */
export function defaultAdapters(): AgentAdapter[] {
  return [
    new ClaudeCodeAdapter(),
    new ClaudeCliAdapter(),
    new CodexCliAdapter(),
    new OpenCodeCliAdapter(),
    new DeepSeekReviewAdapter(),
    new DeepSeekVerifyAdapter(),
    new AutoResearchAdapter(),
    new ClaudeDesignAdapter(),
    new GoogleStitchAdapter(),
    new KimiCodeAdapter(),
  ];
}

export const AGENTS_VERSION = "0.0.0";
