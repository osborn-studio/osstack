import { fork, execFileSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { createScratchDir, openDb } from "@osstack/core";
import { encodeFrame, FrameDecoder } from "@osstack/hermes-adapter";
import { afterAll, beforeAll, expect, it } from "vitest";

const repository = fileURLToPath(new URL("../../../", import.meta.url));
const credential = "crash-fixture-credential-not-production-00000000";
let build: string;
let entry: string;
beforeAll(async () => {
  build = await createScratchDir("tests", "eng-build"); entry = join(build, "host.mjs");
  symlinkSync(join(repository, "packages/cli/node_modules"), join(build, "node_modules"), "dir");
  execFileSync(join(repository, "node_modules/.bin/esbuild"), [join(repository, "scripts/fixtures/engineering-crash-host.ts"), "--bundle", "--platform=node", "--format=esm", "--packages=external", `--outfile=${entry}`]);
});
afterAll(() => { if (build) rmSync(build, { recursive: true, force: true }); });
function authority(root: string, scope?: string) {
  writeFileSync(join(root, "authority.json"), JSON.stringify({ version: 1, principals: scope ? [{
    credential_sha256: createHash("sha256").update(credential).digest("hex"), principal_id: "owner", client_session_id: "ui",
    read_scopes: [scope], write_scopes: [scope], stop_scopes: [scope], operator_scopes: [],
  }] : [] }), { mode: 0o600 });
}
async function host(root: string, mode: string) {
  const child = fork(entry, [root, mode], { cwd: repository, stdio: ["ignore", "pipe", "pipe", "ipc"], env: {
    ...process.env, OSSTACK_HOME: join(root, "home"), OSSTACK_SOCKET: join(root, "d.sock"), OSSTACK_DASHBOARD: "0", OSSTACK_UPDATE_CHECK: "0",
    OSSTACK_ATTENTION: "1", OSSTACK_ENGINEERING: "1", OSSTACK_ENGINEERING_AUTH_FILE: join(root, "authority.json"),
  } });
  let logs = ""; child.stdout!.on("data", c => { logs += String(c); }); child.stderr!.on("data", c => { logs += String(c); });
  const info = await new Promise<{ repo: string; dbPath: string }>((resolve, reject) => {
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(Error(`Host startup timeout: ${logs}`)); }, 15000);
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("exit", () => { clearTimeout(timer); reject(Error(`Host exited: ${logs}`)); });
    child.once("message", message => { clearTimeout(timer); resolve(message as { repo: string; dbPath: string }); });
  });
  return { child, ...info };
}
async function kill(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(Error("Child did not exit after SIGKILL")), 5000);
    child.once("exit", (_code, signal) => { clearTimeout(timer); if (signal === "SIGKILL") resolve(); else reject(Error(`Unexpected exit: ${signal}`)); });
    child.kill("SIGKILL");
  });
}
async function rpc(root: string, method: string, params: unknown): Promise<Record<string, unknown>> {
  return await new Promise((resolve, reject) => {
    const socket = connect(join(root, "d.sock")); const decoder = new FrameDecoder();
    const timer = setTimeout(() => { socket.destroy(); reject(Error("RPC timeout")); }, 5000);
    socket.on("connect", () => socket.write(encodeFrame({ id: 1, method, params })));
    socket.on("error", error => { clearTimeout(timer); reject(error); });
    socket.on("data", chunk => { const response = decoder.push(chunk)[0] as { ok: boolean; result: Record<string, unknown>; error?: unknown } | undefined;
      if (response) { clearTimeout(timer); socket.end(); if (response.ok) resolve(response.result); else reject(Error(JSON.stringify(response.error))); }
    });
  });
}
function query(dbPath: string, sql: string) { const db = openDb({ path: dbPath }); try { return db.prepare(sql).get() as Record<string, unknown> | undefined; } finally { db.close(); } }
async function until(check: () => boolean) { const deadline = Date.now() + 10000; while (!check()) { if (Date.now() > deadline) throw Error("Condition timeout"); await sleep(20); } }
it.each(["admission", "invoking"])("WD16: SIGKILL during %s preserves first-dispatch authority across process restart", async mode => {
  const root = await createScratchDir("tests", "eng-crash"); let child: ChildProcess | undefined;
  try {
    authority(root); const first = await host(root, mode); child = first.child;
    await rpc(root, "attention.watch", { task_id: "task", repo_path: first.repo, default_tenant: true });
    const scope = query(first.dbPath, "SELECT scope_id FROM attention_items LIMIT 1")!["scope_id"] as string; authority(root, scope);
    const adopted = await rpc(root, "engineering.adopt", { credential, scope_id: scope, task_id: "task", run_id: "run", session_id: "session", goal: "Observe one reply", request_id: "adopt" });
    const mission = adopted["mission"] as { mission_id: string; revision: number };
    const view = await rpc(root, "engineering.observe", { credential, mission_id: mission.mission_id });
    const wait = (view["waits"] as Array<Record<string, unknown>>)[0]!;
    await rpc(root, "engineering.decide", { credential, mission_id: mission.mission_id, wait_id: wait["wait_id"], if_revision: mission.revision, decision_ref: wait["decision_ref"], interaction_token: wait["interaction_token"], action_id: "answer", answer: { kind: "choice", choice_id: "keep" } });
    const calls = () => existsSync(join(root, "invocations.log")) ? readFileSync(join(root, "invocations.log"), "utf8").trim().split("\n").length : 0;
    if (mode === "invoking") await until(() => calls() === 1);
    expect(query(first.dbPath, "SELECT phase FROM attention_dispatch_phases")!["phase"]).toBe(mode === "admission" ? "reserved" : "dispatch_committed");
    await kill(child); child = undefined;
    const second = await host(root, "complete"); child = second.child;
    if (mode === "admission") await until(() => query(second.dbPath, "SELECT state FROM session_messages")?.["state"] === "applied");
    else await sleep(1300); // Cross the periodic recovery tick; committed remains unknown.
    expect(calls()).toBe(1);
    const observed = await rpc(root, "engineering.observe", { credential, mission_id: mission.mission_id });
    if (mode === "admission") expect(observed["observation_proof"]).toMatchObject({ kind: "observed_turn" });
    else {
      expect(observed["observation_proof"]).toBeNull();
      expect(query(second.dbPath, "SELECT state FROM session_messages")!["state"]).not.toBe("applied");
    }
  } finally { if (child) await kill(child); rmSync(root, { recursive: true, force: true }); }
}, 30000);
