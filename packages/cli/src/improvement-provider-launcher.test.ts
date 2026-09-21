import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";

const launcher = fileURLToPath(new URL("../../../scripts/smoke-improvement-providers.mjs", import.meta.url));
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((p) => rm(p, { recursive: true, force: true }))); });

it.each([0, 7, "missing"])("isolates the launcher and propagates child outcome %s without providers", async (outcome) => {
  const root = await mkdtemp(join(tmpdir(), "pilot-launcher-test-")); dirs.push(root);
  const bin = join(root, "bin"), temporary = join(root, "tmp"), observation = join(root, "child.json");
  await mkdir(bin); await mkdir(temporary);
  if (outcome !== "missing") {
    const pnpm = join(bin, "pnpm");
    await writeFile(pnpm, `#!${process.execPath}\nconst fs=require('node:fs'); fs.writeFileSync(process.env.PILOT_OBSERVATION, JSON.stringify({ args:process.argv.slice(2), home:process.env.OSSTACK_HOME, homeExists:fs.existsSync(process.env.OSSTACK_HOME), socket:process.env.OSSTACK_SOCKET??null, live:process.env.OSSTACK_PROVIDER_LIVE_SMOKE })); process.exit(${outcome});\n`);
    await chmod(pnpm, 0o700);
  }
  const env = { ...process.env, PATH: outcome === "missing" ? bin : `${bin}${delimiter}${process.env["PATH"] ?? ""}`, TMPDIR: temporary, TMP: temporary, TEMP: temporary,
    OSSTACK_HOME: "must-not-use", OSSTACK_SOCKET: "must-not-use.sock", PILOT_OBSERVATION: observation };
  const result = await new Promise<{ code: number; stderr: string }>((resolve) => {
    execFile(process.execPath, [launcher], { env, timeout: 15_000 }, (error, _stdout, stderr) => {
      resolve({ code: error && "code" in error && typeof error.code === "number" ? error.code : error ? -1 : 0, stderr });
    });
  });
  expect(result.code, result.stderr).toBe(outcome === "missing" ? 1 : outcome);
  expect(await readdir(temporary)).toEqual([]);
  if (outcome !== "missing") {
    const seen = JSON.parse(await readFile(observation, "utf8"));
    expect(seen).toMatchObject({ args: ["--filter", "@osstack/cli", "test", "src/improvement-provider-live.test.ts"], homeExists: true, socket: null, live: "1" });
    expect(seen.home).toContain("osstack-provider-launcher-");
    expect(seen.home).not.toBe("must-not-use");
  }
});
