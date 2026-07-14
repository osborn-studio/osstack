import { mkdtempSync } from "node:fs";
import { chmod, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HermesEvent } from "@osstack/hermes-adapter";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentTask } from "../base.js";
import { ClaudeCliAdapter } from "./claude-cli.js";
import { CodexCliAdapter } from "./codex-cli.js";
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

describe("CodexCliAdapter", () => {
  it("runs in task.context.repo_path instead of the adapter fallback directory", async () => {
    const fallback = join(tmp, "fallback");
    const worktree = join(tmp, "worktree");
    const initialPwdLog = join(tmp, "codex-initial-pwd.txt");
    await mkdir(fallback);
    await mkdir(worktree);
    const bin = await fakeCommand("codex-cwd", `
printf '%s\\n' "$PWD" > ${JSON.stringify(initialPwdLog)}
target=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "-C" ]; then target="$2"; break; fi
  shift
done
cd "$target"
printf 'created by codex\\n' > codex-artifact.txt
printf '{"type":"thread.started","thread_id":"t-cwd"}\\n'
printf '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}\\n'
`);
    const adapter = new CodexCliAdapter({ bin, cwd: fallback, probeTimeoutMs: 1_000 });
    const repoTask = task("codex-cli.code.write");
    repoTask.context = { repo_path: worktree };

    const events = await drain(adapter.invoke(repoTask, new AbortController().signal));

    await expect(readFile(initialPwdLog, "utf-8")).resolves.toBe(`${await realpath(worktree)}\n`);
    await expect(readFile(join(worktree, "codex-artifact.txt"), "utf-8")).resolves.toBe("created by codex\n");
    await expect(readFile(join(fallback, "codex-artifact.txt"), "utf-8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(doneStatus(events)).toBe("completed");
  });

  it("uses an exec resume help preflight for availability", async () => {
    const previousHome = process.env["HOME"];
    process.env["HOME"] = tmp;
    await mkdir(join(tmp, ".codex"));
    const argsLog = join(tmp, "codex-args.txt");
    const bin = await fakeCommand("codex", `
printf '%s\\n' "$*" > ${JSON.stringify(argsLog)}
if [ "\${1:-}" = "exec" ]; then
  printf '{"type":"thread.started","thread_id":"probe"}\\n'
  printf '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}\\n'
  exit 0
fi
exit 9
`);
    const adapter = new CodexCliAdapter({ bin, cwd: tmp, probeTimeoutMs: 5_000 });

    try {
      await expect(adapter.isAvailable()).resolves.toMatchObject({ available: true });
      await expect(readFile(argsLog, "utf-8")).resolves.toBe("exec resume --help\n");
    } finally {
      if (previousHome === undefined) delete process.env["HOME"];
      else process.env["HOME"] = previousHome;
    }
  });

  it("emits usage.final with net tokens from turn.completed (loop budget contract)", async () => {
    // Locks the emission end of the token-accounting chain: the loop budget
    // reads usage.final tokens, so a change that stops emitting them (or gets
    // the net-token math wrong) must fail here rather than silently zero out
    // budget enforcement in production.
    const bin = await fakeCommand("codex-usage", `
if [ "\${1:-}" = "exec" ]; then
  printf '{"type":"thread.started","thread_id":"t1"}\\n'
  printf '{"type":"item.completed","item":{"id":"m1","type":"agent_message","text":"done"}}\\n'
  printf '{"type":"turn.completed","usage":{"input_tokens":120,"cached_input_tokens":20,"output_tokens":50}}\\n'
  exit 0
fi
exit 0
`);
    const adapter = new CodexCliAdapter({ bin, cwd: tmp, probeTimeoutMs: 5_000 });

    const events = await drain(adapter.invoke(task("codex-cli.code.write"), new AbortController().signal));
    const usage = events.find((event) => event.type === "usage.final");
    expect(usage?.payload).toMatchObject({
      tokens_in: 100, // input_tokens (120) - cached_input_tokens (20)
      tokens_out: 50,
    });
    expect(doneStatus(events)).toBe("completed");
  });

  it("classifies a broken resume preflight", async () => {
    const previousHome = process.env["HOME"];
    process.env["HOME"] = tmp;
    await mkdir(join(tmp, ".codex"));
    const bin = await fakeCommand("codex-no-turn", `
printf '{"type":"thread.started","thread_id":"probe"}\\n'
exit 9
`);
    const adapter = new CodexCliAdapter({ bin, cwd: tmp, probeTimeoutMs: 5_000 });

    try {
      const availability = await adapter.isAvailable();
      expect(availability.available).toBe(false);
      expect(availability.status).toBe("installed_but_broken");
      expect(availability.reason).toContain("resume preflight exited 9");
    } finally {
      if (previousHome === undefined) delete process.env["HOME"];
      else process.env["HOME"] = previousHome;
    }
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
