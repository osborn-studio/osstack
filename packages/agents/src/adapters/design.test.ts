import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ClaudeDesignAdapter } from "./claude-design.js";
import { GoogleStitchAdapter } from "./google-stitch.js";
import type { AgentTask } from "../base.js";
import type { HermesEvent } from "@osstack/hermes-adapter";

const task: AgentTask = {
  run_id: "run_test",
  task_id: "task_test",
  session_id: "sess_test",
  capability_id: "x.design.prd",
  prompt: "design a landing page",
};

async function drain(it: AsyncIterable<HermesEvent>): Promise<HermesEvent[]> {
  const out: HermesEvent[] = [];
  for await (const ev of it) out.push(ev);
  return out;
}

describe("ClaudeDesignAdapter", () => {
  const a = new ClaudeDesignAdapter();

  it("advertises the three design capabilities", () => {
    const kinds = a.capabilities().map((c) => c.kind).sort();
    expect(kinds).toEqual(["design.architecture", "design.prd", "design.review"]);
    expect(a.capabilities().every((c) => c.agent_id === "claude-design")).toBe(true);
  });

  it("emits a conforming scaffold stream (run.started → done completed)", async () => {
    const evs = await drain(a.invoke(task, new AbortController().signal));
    expect(evs[0]!.type).toBe("run.started");
    const last = evs[evs.length - 1]!;
    expect(last.type).toBe("done");
    expect(last.terminal).toBe(true);
    expect((last.payload as { status: string }).status).toBe("completed");
  });

  it("reports cancelled when the signal is already aborted", async () => {
    const ac = new AbortController();
    ac.abort();
    const evs = await drain(a.invoke(task, ac.signal));
    const last = evs[evs.length - 1]!;
    expect((last.payload as { status: string }).status).toBe("cancelled");
  });
});

describe("GoogleStitchAdapter", () => {
  const a = new GoogleStitchAdapter();

  beforeEach(() => {
    delete process.env["OSSTACK_STITCH_API_KEY"];
    process.env["OSSTACK_HOME"] = "/nonexistent-osstack-home-for-test";
  });
  afterEach(() => {
    delete process.env["OSSTACK_STITCH_API_KEY"];
    delete process.env["OSSTACK_HOME"];
  });

  it("advertises the three design capabilities", () => {
    expect(a.capabilities().map((c) => c.kind).sort()).toEqual([
      "design.architecture",
      "design.prd",
      "design.review",
    ]);
  });

  it("is unavailable without a key or marker (so design can fall back)", async () => {
    const av = await a.isAvailable();
    expect(av.available).toBe(false);
    expect(av.reason).toContain("Stitch not configured");
  });

  it("is available once a key is set", async () => {
    process.env["OSSTACK_STITCH_API_KEY"] = "test-key";
    const av = await a.isAvailable();
    expect(av.available).toBe(true);
  });
});
