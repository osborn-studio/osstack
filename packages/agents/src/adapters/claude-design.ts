// claude-design adapter — the "Claude Design" product-design agent.
//
// Osstack role: design. Config/probe/fallback are real; execution is scaffolded
// (see _scaffold.ts). isAvailable() mirrors claude-code: present whenever we
// have Anthropic credentials or Hermes auth.

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Capability, CostTier } from "@osstack/core";
import type { HermesEvent } from "@osstack/hermes-adapter";
import { BaseAgentAdapter, type AgentAvailability, type AgentTask } from "../base.js";
import { designCapabilities, now, scaffoldStream } from "./_scaffold.js";

const NOTE =
  "Design execution is scaffolded. Osstack selects/falls back this agent today; " +
  "wire invoke() to a design skill (designer-* / brand-guidelines) in a later sprint.";

export class ClaudeDesignAdapter extends BaseAgentAdapter {
  readonly id = "claude-design";
  readonly display_name = "Claude Design (Anthropic)";
  readonly cost_tier: CostTier = "mid";

  private readonly caps = designCapabilities("claude-design", "mid");

  capabilities(): readonly Capability[] {
    return this.caps;
  }

  async isAvailable(): Promise<AgentAvailability> {
    const hermesHome = process.env["HERMES_HOME"] ?? join(process.env["HOME"] ?? "", ".hermes");
    const ok =
      Boolean(process.env["ANTHROPIC_API_KEY"]) ||
      existsSync(join(hermesHome, "config.yaml")) ||
      existsSync(join(hermesHome, "auth.json"));
    if (ok) return { available: true, last_checked_at: Math.floor(now()) };
    return {
      available: false,
      reason: "No ANTHROPIC_API_KEY and no Hermes auth. Run `hermes login anthropic` or export ANTHROPIC_API_KEY.",
      last_checked_at: Math.floor(now()),
    };
  }

  async *invoke(task: AgentTask, signal: AbortSignal): AsyncIterable<HermesEvent> {
    const status = signal.aborted ? "cancelled" : "completed";
    for (const ev of scaffoldStream(task, this.display_name, NOTE, status)) yield ev;
  }
}
