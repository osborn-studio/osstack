import { mkdtempSync } from "node:fs";
import { chmod, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CapabilitySchema } from "@osstack/core";
import { HermesEventSchema, type HermesEvent } from "@osstack/hermes-adapter";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentAdapter, AgentTask } from "./base.js";
import { ClaudeCliAdapter } from "./adapters/claude-cli.js";
import { DeepSeekVerifyAdapter } from "./adapters/ds-verify.js";
import { KimiCodeAdapter } from "./adapters/kimi-code.js";
import { defaultAdapters } from "./index.js";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "osstack-adapter-conformance-"));
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe("adapter conformance", () => {
  it("keeps the default registry capability metadata self-consistent", () => {
    const adapters = defaultAdapters();
    expect(adapters).toHaveLength(11);

    for (const adapter of adapters) {
      expect(adapter.id).toMatch(/^[a-z0-9][a-z0-9-]*$/);
      expect(adapter.display_name.trim()).not.toEqual("");
      expect(["low", "mid", "high"]).toContain(adapter.cost_tier);

      const capabilities = adapter.capabilities();
      expect(capabilities.length, `${adapter.id} must advertise at least one capability`).toBeGreaterThan(0);

      for (const capability of capabilities) {
        const parsed = CapabilitySchema.parse(capability);
        expect(parsed.agent_id).toBe(adapter.id);
        expect(parsed.id).toBe(`${adapter.id}.${parsed.kind}`);
        expect(parsed.cost_tier).toBe(adapter.cost_tier);
        expect(parsed.description.trim()).not.toEqual("");
      }
    }
  });

  it("emits schema-valid terminal failure streams for subprocess adapter families", async () => {
    const claudeBin = await fakeCommand("claude", `
if [ "\${1:-}" = "--version" ]; then echo "claude fake"; exit 0; fi
echo "claude failure" >&2
exit 9
`);
    const dsVerifyBin = await fakeCommand("ds-verify", `
if [ "\${1:-}" = "--help" ]; then echo help; exit 0; fi
echo "verify failure" >&2
exit 7
`);
    const kimiBin = await fakeCommand("kimi", `
if [ "\${1:-}" = "--version" ]; then echo "0.29.1"; exit 0; fi
echo "not a structured review"
`);

    await expectConformingFailure(
      new ClaudeCliAdapter({ bin: claudeBin }),
      task("claude-cli.code.write"),
      "claude_cli_failed",
    );
    await expectConformingFailure(
      new DeepSeekVerifyAdapter({ bin: dsVerifyBin }),
      task("ds-verify.verify.alignment"),
      "deepseek_command_failed",
    );
    await expectConformingFailure(
      new KimiCodeAdapter({ bin: kimiBin, timeoutMs: 5_000 }),
      kimiTask(),
      "kimi_review_invalid",
    );
  });
});

async function expectConformingFailure(
  adapter: AgentAdapter,
  taskInput: AgentTask,
  expectedCode: string,
): Promise<void> {
  const capability = adapter.capabilities().find((item) => item.id === taskInput.capability_id);
  expect(capability, `${adapter.id} must advertise ${taskInput.capability_id}`).toBeDefined();

  const events = await drain(adapter.invoke(taskInput, new AbortController().signal));
  expect(events.length).toBeGreaterThanOrEqual(3);
  expect(events[0]).toMatchObject({
    type: "run.started",
    run_id: taskInput.run_id,
    session_id: taskInput.session_id,
    terminal: false,
  });

  for (const event of events) {
    const parsed = HermesEventSchema.parse(event);
    expect(parsed.run_id).toBe(taskInput.run_id);
    expect(parsed.session_id).toBe(taskInput.session_id);
  }
  expect(events.map((event) => event.seq)).toEqual(events.map((_, index) => index));

  const error = events.find((event) => event.type === "error");
  expect(error).toMatchObject({
    terminal: true,
    payload: {
      code: expectedCode,
      terminal: true,
    },
  });

  expect(events.at(-1)).toMatchObject({
    type: "done",
    terminal: true,
    payload: {
      status: "failed",
      last_seq: events.length - 2,
    },
  });
}

async function drain(it: AsyncIterable<HermesEvent>): Promise<HermesEvent[]> {
  const events: HermesEvent[] = [];
  for await (const event of it) events.push(event);
  return events;
}

function task(capabilityId: string): AgentTask {
  return {
    run_id: `run_${capabilityId.replaceAll(".", "_")}`,
    task_id: "task-1",
    session_id: "session-1",
    capability_id: capabilityId,
    prompt: "adapter conformance failure fixture",
    context: { repo_path: tmp },
  };
}

function kimiTask(): AgentTask {
  return {
    ...task("kimi-code.code.review"),
    context: {
      repo_path: tmp,
      kimi_review_input: {
        schema_version: 1,
        task: "Review the bounded fixture.",
        evaluation_criteria: [{
          id: "correctness",
          requirement: "The fixture is correct.",
        }],
        changed_paths: [],
        diff: "",
        deterministic_results: [],
        evidence_refs: [],
      },
    },
  };
}

async function fakeCommand(name: string, body: string): Promise<string> {
  const bin = join(tmp, name);
  await writeFile(bin, `#!/usr/bin/env bash\nset -euo pipefail\n${body}\n`, "utf-8");
  await chmod(bin, 0o755);
  return bin;
}
