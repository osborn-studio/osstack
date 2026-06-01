// @osstack/skill-registry — external skill ingestion.
//
// S6 first cut: manifest + watcher + CLI.
// Future: ingester (LLM-normalize SKILL.md), proposer (open PR), batcher
// (npm release once N updates accumulated), compat (schema breaking
// change detector). See docs/V2_REFACTOR_PLAN.md §7.5.

export * from "./manifest.js";
export * from "./watcher.js";

export const SKILL_REGISTRY_VERSION = "0.0.0";
