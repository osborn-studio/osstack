import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { afterAll, beforeAll, expect, it } from "vitest";
import { processGroupEmpty, runGroup } from "./codex-proxy.js";

const source = new URL("./codex-proxy.ts", import.meta.url);
const graceMs = 250;
let dir: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "codex-watcher-"));
  await build({ entryPoints: [fileURLToPath(source)], outfile: join(dir, "proxy.mjs"), bundle: true, platform: "node", format: "esm" });
  writeFileSync(join(dir, "executor.cjs"), `
    const { spawn } = require("node:child_process");
    const fs = require("node:fs");
    const [mode, ready] = process.argv.slice(2);
    if (mode === "exit") {
      process.on("exit", () => fs.writeFileSync(ready, String(Date.now())));
    } else {
      const member = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
      member.on("spawn", () => fs.writeFileSync(ready, String(member.pid)));
      setInterval(() => {}, 1000);
    }
  `);
  writeFileSync(join(dir, "daemon.mjs"), `
    import { spawn } from "node:child_process";
    import { runGroup } from "./proxy.mjs";
    const [ready, grace, mode] = process.argv.slice(2);
    await runGroup(process.execPath, ["executor.cjs", "hang", ready], {
      cwd: process.cwd(), env: process.env, graceMs: Number(grace), timeoutMs: 30000,
      onLaunched({ pgid }) {
        const other = mode === "unrelated"
          ? spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" })
          : undefined;
        console.log(JSON.stringify({ pgid, unrelated: other?.pid }));
      },
    });
  `);
});
afterAll(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

function killGroup(pgid: number | undefined) {
  if (pgid) {
    try { process.kill(-pgid, "SIGKILL"); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }
}

it.each(["alone", "unrelated"])("empties the executor group after daemon SIGKILL (%s)", async mode => {
  const ready = join(dir, mode);
  const daemon = spawn(process.execPath, ["daemon.mjs", ready, String(graceMs), mode], {
    cwd: dir, stdio: ["ignore", "pipe", "inherit"],
  });
  const exited = once(daemon, "exit");
  let pgid: number | undefined;
  let unrelated: number | undefined;
  try {
    const lines = createInterface({ input: daemon.stdout });
    const first = await lines[Symbol.asyncIterator]().next();
    if (first.done) throw Error("daemon exited before reporting its launch");
    ({ pgid, unrelated } = JSON.parse(first.value));
    if (!pgid) throw Error("missing executor pgid");
    const group = pgid;
    await expect.poll(() => existsSync(ready), { timeout: 3000 }).toBe(true);
    expect(processGroupEmpty(group)).toBe(false);
    expect(() => process.kill(Number(readFileSync(ready, "utf8")), 0)).not.toThrow();

    const deadline = Date.now() + graceMs + 1000;
    expect(daemon.kill("SIGKILL")).toBe(true);
    expect(await exited).toEqual([null, "SIGKILL"]);
    while (!processGroupEmpty(group) && Date.now() < deadline) await delay(10);
    expect(processGroupEmpty(group)).toBe(true);
    expect(Date.now()).toBeLessThanOrEqual(deadline);
    if (mode === "unrelated") {
      expect(unrelated).toBeDefined();
      expect(() => process.kill(unrelated!, 0)).not.toThrow();
    }
  } finally {
    daemon.kill("SIGKILL");
    killGroup(pgid);
    killGroup(unrelated);
  }
});

it("releases the watcher promptly when the leader exits normally", async () => {
  const stamp = join(dir, "leader-exit");
  let pgid: number | undefined;
  try {
    const run = await runGroup(process.execPath, ["executor.cjs", "exit", stamp], {
      cwd: dir, env: process.env, graceMs, timeoutMs: 5000, onLaunched: launch => { pgid = launch.pgid; },
    });
    expect(Date.now() - Number(readFileSync(stamp, "utf8"))).toBeLessThanOrEqual(graceMs + 500);
    expect(run).toMatchObject({ exit_code: 0, stop: { stop_proof: "group_empty+sandbox_inherited", signals: [] } });
  } finally { killGroup(pgid); }
});

it("keeps watcher signals group-relative and recovery observation-only", () => {
  const script = readFileSync(source, "utf8").match(/^const EXECUTOR_WATCHER_SCRIPT = '([^'\n]*)';$/m)?.[1];
  expect(script).toMatch(/kill -TERM 0;/);
  expect(script).toMatch(/kill -KILL 0 /);
  expect(script).not.toContain("${");
  for (const file of ["contained-mission-host.ts", "contained-mission-runner.ts"]) {
    expect(readFileSync(new URL(`../../../cli/src/${file}`, import.meta.url), "utf8")).not.toContain("process.kill(");
  }
});
