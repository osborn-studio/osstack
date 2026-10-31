import { mkdtempSync, realpathSync } from "node:fs";
import { chmod, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentSessionEvent, AgentSessionInput } from "../session.js";
import type { AgentTask } from "../base.js";
import type { HermesEvent } from "@osstack/hermes-adapter";
import { CodexCliAdapter } from "./codex-cli.js";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "osstack-codex-session-"));
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe("CodexCliAdapter resumable sessions", () => {
  it("captures the native thread id and emits only bounded public session events", async () => {
    const bin = await fakeCodex("codex-start", "019f-thread");
    const adapter = new CodexCliAdapter({ bin, cwd: tmp, sandbox: "workspace-write" });

    const events = await drain(adapter.startSession(task(), new AbortController().signal));

    expect(adapter.sessionCapabilities()).toEqual({ resume: true, snapshot: true });
    expect(events).toContainEqual({
      type: "native_session.started",
      native_session_id: "019f-thread",
    });
    expect(events).toContainEqual({
      type: "assistant.message",
      message_id: "assistant-1",
      text: "已完成接口核对。",
    });
    expect(events.at(-1)).toEqual({ type: "session.terminal", state: "completed" });
    expect(JSON.stringify(events)).not.toContain("command_execution");
    expect(JSON.stringify(events)).not.toContain("secret output");
  });

  it("resumes the exact native thread with verified parent flags", async () => {
    const argsLog = join(tmp, "args.txt");
    const bin = await fakeCodex("codex-resume", "019f-thread", argsLog);
    const adapter = new CodexCliAdapter({ bin, cwd: tmp, sandbox: "workspace-write" });

    const events = await drain(adapter.resumeSession(sessionInput(), new AbortController().signal));

    await expect(readFile(argsLog, "utf-8")).resolves.toBe([
      "exec", "--json", "--skip-git-repo-check", "-s", "workspace-write",
      "-C", tmp, "resume", "019f-thread", "采用方案 B，继续测试",
    ].join(" ") + "\n");
    expect(events).toContainEqual(expect.objectContaining({
      type: "assistant.message",
      text: "已完成接口核对。",
    }));
  });

  it("fails closed when resume reports a different native thread", async () => {
    const bin = await fakeCodex("codex-mismatch", "different-thread");
    const adapter = new CodexCliAdapter({ bin, cwd: tmp });

    const events = await drain(adapter.resumeSession(sessionInput(), new AbortController().signal));

    expect(events).toEqual([
      { type: "session.state", state: "running" },
      {
        type: "session.terminal",
        state: "failed",
        error_code: "native_session_mismatch",
        summary: "Codex resume returned a different native session",
      },
    ]);
  });

  it("uses a no-model resume help preflight and classifies a broken binary", async () => {
    const previousHome = process.env["HOME"];
    process.env["HOME"] = tmp;
    await mkdir(join(tmp, ".codex"));
    const argsLog = join(tmp, "probe-args.txt");
    const good = await fakeCommand("codex-help", `
printf '%s\n' "$*" > ${JSON.stringify(argsLog)}
if [ "$*" = "exec resume --help" ]; then exit 0; fi
exit 9
`);
    const broken = await fakeCommand("codex-broken", "exit 9");

    try {
      await expect(new CodexCliAdapter({ bin: good }).isAvailable()).resolves.toMatchObject({
        available: true,
        status: "available",
      });
      await expect(readFile(argsLog, "utf-8")).resolves.toBe("exec resume --help\n");
      await expect(new CodexCliAdapter({ bin: broken }).isAvailable()).resolves.toMatchObject({
        available: false,
        status: "installed_but_broken",
      });
    } finally {
      if (previousHome === undefined) delete process.env["HOME"];
      else process.env["HOME"] = previousHome;
    }
  });
});

describe("CodexCliAdapter strict candidate completion", () => {
  it.each([
    ["empty zero exit", "exit 0", "failed"],
    ["truncated turn", `printf '{"type":"thread.started","thread_id":"thread"}\\n'; exit 0`, "failed"],
    ["completed then nonzero exit", `printf '{"type":"turn.completed"}\\n'; exit 7`, "failed"],
    ["completed with zero exit", `printf '{"type":"turn.completed"}\\n'; exit 0`, "completed"],
  ])("requires native completion and successful process exit: %s", async (_label, body, expected) => {
    const bin = await fakeCommand("codex-strict", body!);
    const adapter = new CodexCliAdapter({ bin, cwd: tmp, strictCompletion: true });
    const events: HermesEvent[] = [];
    for await (const event of adapter.invoke(task(), new AbortController().signal)) events.push(event);
    expect(events.filter((event) => event.type === "done").map((event) => (event.payload as { status: string }).status)).toEqual([expected]);
  });

  it("replaces inherited child environment consistently for probe, session and invoke", async () => {
    const log = join(tmp, "environment.log");
    await mkdir(join(tmp, ".codex"));
    const bin = await fakeCommand("codex-environment", `
printf '%s|%s|%s\\n' "$OSSTACK_HOME" "$OSSTACK_AUTOAPPROVE" "\${AMBIENT_SECRET:-absent}" >> '${log}'
if [ "$*" = "exec resume --help" ]; then exit 0; fi
printf '{"type":"thread.started","thread_id":"thread"}\\n{"type":"turn.completed"}\\n'
`);
    const adapter = new CodexCliAdapter({ bin, cwd: tmp, strictCompletion: true,
      env: { PATH: process.env["PATH"], HOME: tmp, OSSTACK_HOME: join(tmp, "control"), OSSTACK_AUTOAPPROVE: "0" } });
    expect((await adapter.isAvailable()).available).toBe(true);
    await drain(adapter.startSession(task(), new AbortController().signal));
    for await (const _event of adapter.invoke(task(), new AbortController().signal)) { /* drain */ }
    expect((await readFile(log, "utf8")).trim().split("\n")).toEqual(Array(3).fill(`${join(tmp, "control")}|0|absent`));
  });

  it("reports a missing binary as failure without an unhandled process error", async () => {
    const adapter = new CodexCliAdapter({ bin: join(tmp, "does-not-exist"), cwd: tmp, strictCompletion: true });
    const events: HermesEvent[] = [];
    for await (const event of adapter.invoke(task(), new AbortController().signal)) events.push(event);
    expect((events.at(-1)?.payload as { status: string }).status).toBe("failed");
  });
});


describe("CodexCliAdapter explicit writable roots", () => {
  it.each(["invoke", "start", "resume"] as const)("passes canonical deduplicated directories as parent flags for %s", async (route) => {
    const root = join(tmp, "owned scratch");
    const alias = join(tmp, "scratch-alias");
    await mkdir(root);
    await symlink(root, alias, "dir");
    const log = join(tmp, "argv.bin");
    const bin = await fakeCommand("codex-roots", `
printf '%s\\0' "$@" > '${log}'
printf '{"type":"thread.started","thread_id":"019f-thread"}\\n{"type":"turn.completed"}\\n'
`);
    const roots = [root, alias, join(root, ".")];
    const adapter = new CodexCliAdapter({ bin, cwd: tmp, sandbox: "workspace-write", writableRoots: roots });
    roots.splice(0, roots.length, "/");
    if (route === "invoke") {
      for await (const _event of adapter.invoke(task(), new AbortController().signal)) { /* drain fake */ }
    } else if (route === "start") {
      await drain(adapter.startSession(task(), new AbortController().signal));
    } else {
      await drain(adapter.resumeSession(sessionInput(), new AbortController().signal));
    }
    const args = (await readFile(log, "utf8")).split("\0").slice(0, -1);
    expect(args).toEqual([
      "exec", "--json", "--skip-git-repo-check", "-s", "workspace-write",
      "-C", tmp, "--add-dir", realpathSync(root),
      ...(route === "resume" ? ["resume", "019f-thread", sessionInput().prompt] : [task().prompt]),
    ]);
  });

  it.each([undefined, "read-only", "danger-full-access"] as const)("rejects nonempty writable roots for sandbox %s", (sandbox) => {
    const options = { writableRoots: [tmp], ...(sandbox === undefined ? {} : { sandbox }) };
    expect(() => new CodexCliAdapter(options)).toThrow(/writableRoots/);
  });

  it.each([
    ["relative", (): unknown => ["relative"]],
    ["empty path", (): unknown => [""]],
    ["root", (): unknown => ["/"]],
    ["root via normalization", (): unknown => ["/tmp/.."]],
    ["NUL", (): unknown => [tmp + "\0bad"]],
    ["control character", (): unknown => [tmp + "\nbad"]],
    ["missing", (): unknown => [join(tmp, "missing")]],
    ["too many", (): unknown => Array(9).fill(tmp)],
    ["non-string", (): unknown => [42]],
    ["not an array", (): unknown => tmp],
    ["null", (): unknown => null],
    ["sparse array", (): unknown => Array(1)],
  ] as const)("rejects %s before spawning", (_label, roots) => {
    const options = { sandbox: "workspace-write" as const, writableRoots: roots() };
    expect((): unknown => new CodexCliAdapter(options as ConstructorParameters<typeof CodexCliAdapter>[0])).toThrow(/writableRoots/);
  });

  it("rejects files and aliases to filesystem root", async () => {
    const file = join(tmp, "plain-file");
    const alias = join(tmp, "root-alias");
    await writeFile(file, "");
    await symlink("/", alias, "dir");
    for (const path of [file, alias]) {
      expect(() => new CodexCliAdapter({ sandbox: "workspace-write", writableRoots: [path] })).toThrow(/writableRoots/);
    }
  });

  it("accepts eight existing distinct directories", async () => {
    const roots = Array.from({ length: 8 }, (_, index) => join(tmp, `root-${index}`));
    await Promise.all(roots.map(root => mkdir(root)));
    expect(() => new CodexCliAdapter({ sandbox: "workspace-write", writableRoots: roots })).not.toThrow();
  });

  it.each(["read-only", "workspace-write", "danger-full-access"] as const)("keeps empty roots legal with sandbox %s", sandbox => {
    expect(() => new CodexCliAdapter({ sandbox, writableRoots: [] })).not.toThrow();
  });

  it.each([["omitted", undefined], ["empty", []]] as const)("keeps default argv unchanged and ignores ambient scratch for roots %s", async (_label, writableRoots) => {
    const log = join(tmp, "argv.bin");
    const bin = await fakeCommand("codex-default-roots", `
printf '%s\\0' "$@" > '${log}'
printf '{"type":"turn.completed"}\\n'
`);
    const previous = process.env["OSSTACK_SCRATCH_ROOT"];
    process.env["OSSTACK_SCRATCH_ROOT"] = "/";
    try {
      const adapter = new CodexCliAdapter({ bin, cwd: tmp, ...(writableRoots === undefined ? {} : { writableRoots }) });
      for await (const _event of adapter.invoke(task(), new AbortController().signal)) { /* drain fake */ }
      expect((await readFile(log, "utf8")).split("\0").slice(0, -1)).toEqual([
        "exec", "--json", "--skip-git-repo-check", "-s", "read-only", "-C", tmp, task().prompt,
      ]);
    } finally {
      if (previous === undefined) delete process.env["OSSTACK_SCRATCH_ROOT"];
      else process.env["OSSTACK_SCRATCH_ROOT"] = previous;
    }
  });

  it("never grants configured roots to the no-model availability probe", async () => {
    const log = join(tmp, "probe-argv.bin");
    const bin = await fakeCommand("codex-root-probe", `printf '%s\\0' "$@" > '${log}'`);
    const adapter = new CodexCliAdapter({ bin, sandbox: "workspace-write", writableRoots: [tmp],
      env: { PATH: process.env["PATH"], CODEX_HOME: tmp } });
    expect((await adapter.isAvailable()).available).toBe(true);
    expect((await readFile(log, "utf8")).split("\0").slice(0, -1)).toEqual(["exec", "resume", "--help"]);
  });
});

function task(): AgentTask {
  return {
    run_id: "run_01",
    task_id: "task_01",
    session_id: "sess_01",
    capability_id: "codex-cli.code.write",
    prompt: "完成接口核对",
    context: { repo_path: tmp },
  };
}

function sessionInput(): AgentSessionInput {
  return {
    session_id: "sess_01",
    task_id: "task_01",
    run_id: "run_01",
    turn_id: "turn_02",
    native_session_id: "019f-thread",
    expected_version: 2,
    message_id: "msg_feishu_01",
    prompt: "采用方案 B，继续测试",
    context: { repo_path: tmp },
  };
}

async function fakeCodex(name: string, threadId: string, argsLog?: string): Promise<string> {
  return fakeCommand(name, `
${argsLog ? `printf '%s\\n' "$*" > ${JSON.stringify(argsLog)}` : ""}
printf '{"type":"thread.started","thread_id":"${threadId}"}\n'
printf '{"type":"item.started","item":{"id":"tool-1","type":"command_execution","command":"cat .env"}}\n'
printf '{"type":"item.completed","item":{"id":"tool-1","type":"command_execution","output":"secret output"}}\n'
printf '{"type":"item.completed","item":{"id":"assistant-1","type":"agent_message","text":"已完成接口核对。"}}\n'
printf '{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":5}}\n'
exit 0
`);
}

async function fakeCommand(name: string, body: string): Promise<string> {
  const bin = join(tmp, name);
  await writeFile(bin, `#!/usr/bin/env bash\nset -euo pipefail\n${body}\n`, "utf-8");
  await chmod(bin, 0o755);
  return bin;
}

async function drain(iterable: AsyncIterable<AgentSessionEvent>): Promise<AgentSessionEvent[]> {
  const events: AgentSessionEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}
