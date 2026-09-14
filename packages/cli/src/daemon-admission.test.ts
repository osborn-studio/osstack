import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { connect, type Socket } from "node:net";
import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { CapabilitySchema } from "@osstack/core";
import { FifoSemaphore } from "@osstack/autonomy";
import type { AgentAdapter, AgentTask } from "@osstack/agents";
import { encodeFrame, FrameDecoder, type HermesEvent } from "@osstack/hermes-adapter";
import { GovernedExecution } from "./governed-execution.js";
import { startDaemon, type DaemonHandles } from "./daemon.js";
import { main } from "./bin.js";
import { healthyAutonomyHealth } from "./test-healthy-autonomy.js";

const roots: string[] = []; const handles: DaemonHandles[] = []; const sockets: Socket[] = []; const children: ChildProcess[] = [];
const previousHome = process.env["OSSTACK_HOME"];
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.destroy();
  for (const child of children.splice(0)) { if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await once(child, "close"); } }
  for (const handle of handles.splice(0)) await handle.close();
  if (previousHome === undefined) delete process.env["OSSTACK_HOME"]; else process.env["OSSTACK_HOME"] = previousHome;
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })));
});
function request(handle: DaemonHandles, method: string, params: unknown) {
  const socket = connect(handle.socketPath); sockets.push(socket);
  const frames: Array<Record<string, unknown>> = []; const decoder = new FrameDecoder();
  socket.on("connect", () => socket.write(encodeFrame({ id: 1, method, params })));
  socket.on("data", bytes => { frames.push(...decoder.push(bytes) as Array<Record<string, unknown>>); });
  return { frames, socket };
}
async function fixture(adapter: AgentAdapter) {
  const root = await mkdtemp(join(tmpdir(), "daemon-admit-")); roots.push(root);
  const repo = join(root, "repo"); execFileSync("git", ["init", repo], { stdio: "ignore" });
  await mkdir(join(repo, ".osstack")); await writeFile(join(repo, ".osstack", "policy.yaml"), "schema_version: 1\nmode: execute\n");
  process.env["OSSTACK_HOME"] = join(root, "home");
  const identity = {};
  const daemon = await startDaemon({ socketPath: `/tmp/ga-${randomUUID()}.sock`, adapters: [adapter],
    adapterWorkspaces: new Map([[adapter.id, repo]]), autonomyHealth: async () => healthyAutonomyHealth(),
    graphIdentities: new Map([[identity, { workspacePath: repo, authorize: async () => {} }]]),
  }); handles.push(daemon);
  return { daemon, identity, repo };
}
function adapter(invoke: AgentAdapter["invoke"], confirmStopped?: AgentAdapter["confirmStopped"], kind = "code.write"): AgentAdapter {
  return { id: "fixture-writer", display_name: "Fixture", cost_tier: "low", invoke,
    capabilities: () => [CapabilitySchema.parse({ id: "fixture.write", kind, agent_id: "fixture-writer", description: "Fixture writer", cost_tier: "low" })],
    isAvailable: async () => ({ available: true, last_checked_at: 1 }), ...(confirmStopped ? { confirmStopped } : {}),
  };
}
function event(task: AgentTask, terminal: boolean): HermesEvent {
  const base = { event_id: randomUUID(), run_id: task.run_id, session_id: task.session_id, seq: terminal ? 1 : 0, created_at: Date.now() / 1000, terminal };
  return terminal ? { ...base, type: "done", payload: { status: "completed", last_seq: 1 } }
    : { ...base, type: "progress", payload: { phase: "running" } };
}
it("keeps a direct adapter's lease past terminal output until producer cleanup, then admits Loop", async () => {
  let finish: () => void = () => {}; let captured: AgentTask | undefined;
  const producer = new Promise<void>(resolve => { finish = resolve; });
  const f = await fixture(adapter(async function* (task) { captured = task; yield event(task, true); await producer; }));
  try {
    const direct = request(f.daemon, "task.submit", { prompt: "write", agent_id: "fixture-writer", context: { repo_path: f.repo } });
    await expect.poll(() => direct.frames.some(frame => frame.terminal === true)).toBe(true);
    expect(captured?.context?.["repo_path"]).toBe(f.repo);
    const loop = request(f.daemon, "loop.run", { workspacePath: f.repo, sources: [] });
    await new Promise(resolve => setTimeout(resolve, 40)); expect(loop.frames).toHaveLength(0);
    expect(existsSync(join(f.repo, "LOOP-STATE.json"))).toBe(false);
    finish(); await expect.poll(() => loop.frames[0]?.ok).toBe(true);
  } finally { finish(); }
});
it.each([false, true])("cancelled real producer: confirmed=%s controls cross-instance admission", async (confirmed) => {
  let child: ChildProcess | undefined; let taskRun: string | undefined; let closed: Promise<unknown> | undefined;
  const actor = adapter(async function* (task) {
    taskRun = task.run_id;
    child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" }); children.push(child);
    closed = once(child, "close");
    yield event(task, false);
    await new Promise(() => {}); // Simulates an adapter iterator ignoring AbortSignal.
  }, confirmed ? async (runId) => {
    expect(runId).toBe(taskRun); child!.kill("SIGKILL"); await closed;
    return { stopped: true, evidence: `observed child ${child!.pid} close; fixture owns no descendants` };
  } : undefined);
  const f = await fixture(actor);
  request(f.daemon, "task.submit", { prompt: "write", agent_id: actor.id });
  await expect.poll(() => child?.pid).toBeDefined();
  request(f.daemon, "task.cancel", { run_id: taskRun });
  const health = () => request(f.daemon, "health", {});
  await expect.poll(async () => { const h = health(); await expect.poll(() => h.frames.length).toBe(1); return (h.frames[0]?.result as { active_runs: number })?.active_runs; }, { timeout: 4000 }).toBe(0);
  const independent = new GovernedExecution({ reads: new FifoSemaphore(1), writes: new FifoSemaphore(1), repositories: new Map(), checkHealth: async () => {} });
  if (confirmed) { const lease = await independent.acquire({ kind: "write", runId: "after-stop", workspacePath: f.repo }); await lease.release(); }
  else {
    process.kill(child!.pid!, 0); // Real producer is still alive despite cancellation.
    for (const socket of sockets.splice(0)) socket.destroy();
    await f.daemon.close(); handles.splice(handles.indexOf(f.daemon), 1);
    await expect(independent.acquire({ kind: "write", runId: "other-home", workspacePath: f.repo })).rejects.toThrow("locked");
  }
}, 10_000);

it("local Loop refuses a daemon-held lock before checkpoint or report effects", async () => {
  const f = await fixture(adapter(async function* () {}));
  const lease = await f.daemon.acquireGraphAdmission(f.identity, { runId: "graph-held" });
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    await expect(main(["loop", "run", "--workspace", f.repo, "--checkpoint", "--report", "--execute", "touch escaped.txt"])).rejects.toThrow("locked");
    expect(existsSync(join(f.repo, "escaped.txt"))).toBe(false);
    expect(existsSync(join(f.repo, "LOOP-STATE.json"))).toBe(false);
    expect(existsSync(join(f.repo, "reports"))).toBe(false);
  } finally { error.mockRestore(); await lease.release(); }
});

it.each(["code.write", "code.review"])("registered daemon preserves scope semantics for %s", async kind => {
  let called = false; let path: unknown;
  const f = await fixture(adapter(async function* (task) { called = true; path = task.context?.["repo_path"]; yield event(task, true); }, undefined, kind));
  const other = join(f.repo, "..", "other"); execFileSync("git", ["init", other], { stdio: "ignore" });
  const response = request(f.daemon, "task.submit", { prompt: "inspect requested checkout", agent_id: "fixture-writer", context: { repo_path: other } });
  await expect.poll(() => response.frames.some(frame => frame.terminal === true)).toBe(true);
  if (kind === "code.write") { expect(called).toBe(false); expect(JSON.stringify(response.frames)).toContain("does not match host registration"); }
  else { expect(called).toBe(true); expect(path).toBe(other); }
});
