import { mkdtempSync } from "node:fs";
import { chmod, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HermesEvent } from "@osstack/hermes-adapter";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentTask } from "../base.js";
import { ClaudeCliAdapter } from "./claude-cli.js";
import { OpenCodeCliAdapter } from "./opencode-cli.js";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "osstack-subprocess-cli-"));
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe("ClaudeCliAdapter", () => {
  it("advertises code capabilities with claude-cli ownership", () => {
    const adapter = new ClaudeCliAdapter({ bin: "missing-claude-for-capability-test" });

    expect(adapter.capabilities().map((capability) => capability.kind).sort()).toEqual([
      "code.refactor",
      "code.review",
      "code.test",
      "code.write",
    ]);
    expect(adapter.capabilities().every((capability) => capability.agent_id === "claude-cli")).toBe(true);
  });

  it("probes and invokes a login-reuse CLI subprocess", async () => {
    const bin = await fakeCommand("claude", `
if [ "\${1:-}" = "--version" ]; then echo "claude fake"; exit 0; fi
printf 'claude args:%s\\n' "$*"
`);
    const adapter = new ClaudeCliAdapter({ bin });

    await expect(adapter.isAvailable()).resolves.toMatchObject({ available: true });

    const events = await drain(adapter.invoke(task("claude-cli.code.write"), new AbortController().signal));
    expect(events[0]!.type).toBe("run.started");
    expect(events).toContainEqual(expect.objectContaining({
      type: "token.delta",
      payload: expect.objectContaining({ delta: expect.stringContaining("hello from task") }),
    }));
    expect(doneStatus(events)).toBe("completed");
  });

  it("reports unavailable when the CLI is missing", async () => {
    const adapter = new ClaudeCliAdapter({ bin: join(tmp, "missing-claude") });

    const availability = await adapter.isAvailable();

    expect(availability.available).toBe(false);
    expect(availability.reason).toContain("spawn");
  });
});

describe("OpenCodeCliAdapter", () => {
  it("probes and invokes a login-reuse CLI subprocess", async () => {
    const bin = await fakeCommand("opencode", `
if [ "\${1:-}" = "--version" ]; then echo "opencode fake"; exit 0; fi
printf 'opencode args:%s\\n' "$*"
`);
    const adapter = new OpenCodeCliAdapter({ bin });

    await expect(adapter.isAvailable()).resolves.toMatchObject({ available: true });

    const events = await drain(adapter.invoke(task("opencode-cli.code.test"), new AbortController().signal));
    expect(events).toContainEqual(expect.objectContaining({
      type: "token.delta",
      payload: expect.objectContaining({ delta: expect.stringContaining("hello from task") }),
    }));
    expect(doneStatus(events)).toBe("completed");
  });

  it("can pass prompt on stdin when args omit the prompt template", async () => {
    const bin = await fakeCommand("opencode", `
if [ "\${1:-}" = "--version" ]; then echo "opencode fake"; exit 0; fi
input="$(cat)"
printf 'stdin:%s\\n' "$input"
`);
    const adapter = new OpenCodeCliAdapter({ bin, args: ["run", "--stdin"] });

    const events = await drain(adapter.invoke(task("opencode-cli.code.write"), new AbortController().signal));

    expect(events).toContainEqual(expect.objectContaining({
      type: "token.delta",
      payload: expect.objectContaining({ delta: expect.stringContaining("hello from task") }),
    }));
    expect(doneStatus(events)).toBe("completed");
  });
});

async function drain(it: AsyncIterable<HermesEvent>): Promise<HermesEvent[]> {
  const events: HermesEvent[] = [];
  for await (const event of it) events.push(event);
  return events;
}

function doneStatus(events: HermesEvent[]): string | undefined {
  const done = [...events].reverse().find((event) => event.type === "done");
  return done === undefined ? undefined : String((done.payload as { status?: unknown }).status);
}

function task(capabilityId: string): AgentTask {
  return {
    run_id: `run_${capabilityId.replaceAll(".", "_")}`,
    task_id: "task-1",
    session_id: "session-1",
    capability_id: capabilityId,
    prompt: "hello from task",
    context: { repo_path: tmp },
  };
}

async function fakeCommand(name: string, body: string): Promise<string> {
  const bin = join(tmp, name);
  await writeFile(bin, `#!/usr/bin/env bash\nset -euo pipefail\n${body}\n`, "utf-8");
  await chmod(bin, 0o755);
  return bin;
}
