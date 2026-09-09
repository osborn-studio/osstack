// Explicit network/native-toolchain smoke, excluded from the offline regression suite.
import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { improvementVerificationEnvironment, prepareImprovementEnvironment, previewImprovementEnvironment } from "./improvement-environment.js";

it.skipIf(process.env["OSSTACK_NATIVE_COLD_SMOKE"] !== "1")("prepares two cold OSStack checkouts and loads native SQLite plus esbuild", async () => {
  const exec = promisify(execFile);
  const repo = resolve(import.meta.dirname, "../../..");
  const commit = (await exec("git", ["rev-parse", "HEAD"], { cwd: repo })).stdout.trim();
  const root = await mkdtemp(join(tmpdir(), "osstack-native-cold-"));
  console.log(`Native cold-install artifacts: ${root}`);
  const contract = await previewImprovementEnvironment(repo, commit, ["better-sqlite3@12.10.0", "esbuild@0.25.12", "esbuild@0.28.1", "protobufjs@7.6.5"]);
  const results = [];
  for (const stage of ["candidate", "replay"]) {
    const workspace = join(root, stage);
    const directory = join(root, `${stage}-environment`);
    await exec("git", ["clone", "--quiet", "--no-local", repo, workspace]);
    await exec("git", ["checkout", "--detach", commit], { cwd: workspace });
    await prepareImprovementEnvironment({ contract, workspace, commit, directory, timeoutMs: 240_000, checkActive() {} });
    const env = improvementVerificationEnvironment(join(directory, "home"), contract);
    const sqlite = (await exec("node", ["-e", "const Database=require('better-sqlite3'); const db=new Database(':memory:'); const n=db.prepare('select 42 as answer').get().answer; db.close(); if(n!==42)process.exit(1); console.log(n)"], { cwd: join(workspace, "packages/core"), env })).stdout.trim();
    const esbuild = (await exec("node", ["-e", "const e=require(require.resolve('esbuild',{paths:[require.resolve('tsup/package.json')]})); console.log(e.transformSync('let n: number = 42',{loader:'ts'}).code)"], { cwd: workspace, env })).stdout.trim();
    expect(sqlite).toBe("42"); expect(esbuild).toContain("42");
    results.push({ stage, sqlite, esbuild, receipt: JSON.parse(await readFile(join(directory, "completed.json"), "utf8")) });
    await writeFile(join(root, "results.json"), JSON.stringify({ commit, contract, results }, null, 2));
  }
}, 600_000);
