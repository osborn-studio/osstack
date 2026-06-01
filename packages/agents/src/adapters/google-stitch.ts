// google-stitch adapter — the "Google Stitch 2.0" product-design agent.
//
// Osstack role: design. Stitch has no headless CLI, so isAvailable() gates on
// an explicit opt-in (an API key env var or a local marker file). On a machine
// without it, the design role falls back to the next agent in the binding —
// which is exactly the behaviour Osstack's role config is meant to demonstrate.

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Capability, CostTier } from "@osstack/core";
import type { HermesEvent } from "@osstack/hermes-adapter";
import { BaseAgentAdapter, type AgentAvailability, type AgentTask } from "../base.js";
import { designCapabilities, now, scaffoldStream } from "./_scaffold.js";

const NOTE =
  "Design execution is scaffolded. Osstack selects/falls back this agent today; " +
  "wire invoke() to the Stitch pipeline (stitch-skill) in a later sprint.";

function osstackHome(): string {
  return process.env["OSSTACK_HOME"] ?? join(process.env["HOME"] ?? "", ".osstack");
}

export class GoogleStitchAdapter extends BaseAgentAdapter {
  readonly id = "google-stitch";
  readonly display_name = "Google Stitch 2.0";
  readonly cost_tier: CostTier = "mid";

  private readonly caps = designCapabilities("google-stitch", "mid");

  capabilities(): readonly Capability[] {
    return this.caps;
  }

  async isAvailable(): Promise<AgentAvailability> {
    const hasKey = Boolean(process.env["OSSTACK_STITCH_API_KEY"]);
    const hasMarker = existsSync(join(osstackHome(), "stitch.json"));
    if (hasKey || hasMarker) return { available: true, last_checked_at: Math.floor(now()) };
    return {
      available: false,
      reason:
        "Stitch not configured. Set OSSTACK_STITCH_API_KEY or create ~/.osstack/stitch.json to enable.",
      last_checked_at: Math.floor(now()),
    };
  }

  async *invoke(task: AgentTask, signal: AbortSignal): AsyncIterable<HermesEvent> {
    const status = signal.aborted ? "cancelled" : "completed";
    for (const ev of scaffoldStream(task, this.display_name, NOTE, status)) yield ev;
  }
}
