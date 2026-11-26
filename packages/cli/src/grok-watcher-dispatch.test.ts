import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

const dir = fileURLToPath(new URL("../../../deploy/grok-watcher/", import.meta.url));
const script = join(dir, "dispatch-verify.sh");
const repo = "osborn-studio/osstack-bridge-sandbox";
const pulls = `repos/${repo}/pulls`;
const list = `${pulls}?state=open&per_page=100`;
const head = "ab".repeat(20);
const checks = `repos/${repo}/commits/${head}/check-runs?check_name=osstack/verify-actions&filter=all`;
const dispatch = ["workflow", "run", "osstack-verify.yml", "-R", repo, "--ref", "main", "-f"];
const hostile = '"; rm -rf example';
const pr = (number = 42) => ({
  number, title: hostile, state: "open", draft: false,
  head: { sha: head, ref: "osstack/mission/task-1", repo: { full_name: repo } },
  base: { ref: "main", repo: { full_name: repo, default_branch: "main" } },
});

let fixture: string;
let state: string;
function respond(path: string, ...pages: unknown[]) {
  writeFileSync(join(fixture, encodeURIComponent(path)), pages.map(page => JSON.stringify(page)).join("\n"));
}
function run(...args: string[]) {
  return spawnSync("bash", [script, ...args], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${fixture}:${process.env.PATH}`, fixture, OSSTACK_DISPATCH_STATE_DIR: state },
  });
}
function calls(): string[][] {
  return readFileSync(join(fixture, "log"), "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line));
}
function expectLine(action: string, reason: string | null, expectedHead: string | null = head) {
  const result = run("42");
  expect(result.status).toBe(action === "failed" ? 1 : 0);
  expect(result.stderr).toBe("");
  expect(result.stdout.trim().split("\n").map(line => JSON.parse(line))).toEqual([
    { pr: 42, head: expectedHead, action, reason },
  ]);
}

describe("Grok Watcher verification dispatch", () => {
  beforeAll(() => {
    expect(spawnSync("jq", ["--version"]).status, "jq is required on PATH").toBe(0);
  });
  beforeEach(() => {
    fixture = mkdtempSync(join(tmpdir(), "dispatch-"));
    state = join(fixture, "state");
    writeFileSync(join(fixture, "log"), "");
    writeFileSync(join(fixture, "gh"), `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const file = name => path.join(process.env.fixture, name);
const args = process.argv.slice(2);
fs.appendFileSync(file("log"), JSON.stringify(args) + "\\n");
if (args[0] === "api") {
  const response = file(encodeURIComponent(args.at(-1)));
  if (fs.existsSync(response)) {
    process.stdout.write(fs.readFileSync(response));
    process.exitCode = fs.existsSync(file("fail-read")) ? 1 : 0;
  } else process.exitCode = 1;
} else if (args[0] !== "workflow" || fs.existsSync(file("fail-dispatch"))) {
  process.exitCode = 1;
} else console.log("dispatch details");
console.error("private gh diagnostic");
`, { mode: 0o755 });
    respond(`${pulls}/42`, pr());
    respond(checks, { check_runs: [] });
  });
  afterEach(() => rmSync(fixture, { recursive: true, force: true }));

  it.each([["abc"], ["0"], ["01"], ["1234567890"], ["1", "2"]])("rejects invalid arguments %s", (...args) => {
    expect(run(...args).status).toBe(2);
    expect(calls()).toEqual([]);
  });

  it("reports a missing tool before reading GitHub", () => {
    const result = spawnSync("/bin/bash", [script], {
      encoding: "utf8", env: { ...process.env, PATH: fixture },
    });
    expect(result.status).toBe(2);
    expect(result.stdout.trim()).toBe('{"action":"failed","reason":"missing_tool"}');
    expect(calls()).toEqual([]);
  });

  it("dispatches only the number and records the head after success", () => {
    expectLine("dispatched", null);
    expect(calls()).toEqual([
      ["api", `${pulls}/42`], ["api", "--paginate", checks], [...dispatch, "pr=42"],
    ]);
    expect(statSync(state).mode & 0o777).toBe(0o700);
    expect(existsSync(join(state, `42-${head}`))).toBe(true);
  });

  it.each([15368, 123])("checks the writer of a same-named check on a later page (%i)", id => {
    respond(checks, { check_runs: [] }, { check_runs: [{ name: "osstack/verify-actions", app: { id } }] });
    if (id === 15368) expectLine("skipped", "already_verified");
    else expectLine("dispatched", null);
    expect(calls().filter(args => args[0] === "workflow")).toHaveLength(id === 15368 ? 0 : 1);
  });

  it.each([
    ["fork", { head: { ...pr().head, repo: { full_name: "fork/repo" } } }],
    ["draft", { draft: true }],
    ["wrong prefix", { head: { ...pr().head, ref: hostile } }],
    ["wrong base", { base: { ...pr().base, ref: "release" } }],
    ["closed", { state: "closed" }],
    ["invalid SHA", { head: { ...pr().head, sha: hostile } }],
  ] as const)("skips %s without printing PR text", (label, overrides) => {
    respond(`${pulls}/42`, { ...pr(), ...overrides });
    expectLine("skipped", "not_eligible", label === "invalid SHA" ? null : head);
    expect(calls()).toEqual([["api", `${pulls}/42`]]);
  });

  it("suppresses a recent dispatch and retries after 45 minutes", () => {
    mkdirSync(state);
    const marker = join(state, `42-${head}`);
    writeFileSync(marker, "");
    expectLine("skipped", "recently_dispatched");
    expect(calls().filter(args => args[0] === "workflow")).toEqual([]);
    const expired = new Date(Date.now() - 46 * 60_000);
    utimesSync(marker, expired, expired);
    expectLine("dispatched", null);
  });

  it("dispatches five across pages and defers the rest", () => {
    respond(list, [pr(1), pr(2)], [pr(3), pr(4), pr(5), pr(6), pr(7)]);
    const result = run();
    expect(result.status).toBe(0);
    expect(result.stdout.trim().split("\n").map(line => JSON.parse(line))).toEqual(
      Array.from({ length: 7 }, (_, i) => ({
        pr: i + 1, head, action: i < 5 ? "dispatched" : "deferred", reason: i < 5 ? null : "dispatch_limit",
      })),
    );
    expect(calls()[0]).toEqual(["api", "--paginate", list]);
    expect(calls().filter(args => args[0] === "workflow")).toEqual(
      [1, 2, 3, 4, 5].map(n => [...dispatch, `pr=${n}`]),
    );
  });

  it("reports dispatch failure without writing a marker or printing diagnostics", () => {
    writeFileSync(join(fixture, "fail-dispatch"), "");
    expectLine("failed", "dispatch_failed");
    expect(existsSync(join(state, `42-${head}`))).toBe(false);
  });

  it("counts failed attempts toward the scan limit and preserves the failure status", () => {
    respond(list, Array.from({ length: 6 }, (_, i) => pr(i + 1)));
    writeFileSync(join(fixture, "fail-dispatch"), "");
    const result = run();
    expect(result.status).toBe(1);
    expect(result.stdout.trim().split("\n").map(line => JSON.parse(line).reason)).toEqual([
      ...Array(5).fill("dispatch_failed"), "dispatch_limit",
    ]);
    expect(calls().filter(args => args[0] === "workflow")).toHaveLength(5);
  });

  it.each(["scan", "checks"])("fails closed on a failed %s read", kind => {
    if (kind === "scan") {
      respond(list, [pr()]);
      writeFileSync(join(fixture, "fail-read"), "");
    } else rmSync(join(fixture, encodeURIComponent(checks)));
    const result = kind === "scan" ? run() : run("42");
    expect(result.status).toBe(1);
    expect(result.stdout.trim()).toBe('{"action":"failed","reason":"read_failed"}');
    expect(result.stderr).toBe("");
    expect(calls().filter(args => args[0] === "workflow")).toEqual([]);
  });

  it("pins the script bytes and restricts workflow dispatch to the sandbox", () => {
    const bytes = readFileSync(script);
    const digest = createHash("sha256").update(bytes).digest("hex");
    expect(readFileSync(join(dir, "SHA256SUMS"), "utf8")).toBe(`${digest}  dispatch-verify.sh\n`);
    const source = bytes.toString("utf8");
    expect(source).not.toMatch(/auth\s+token|hosts\.yml|pull_request_target/);
    expect(source.match(/gh\s+workflow\s+run[^\n]*/g)).toEqual([
      `gh workflow run osstack-verify.yml -R ${repo} --ref main -f "pr=$pr" >/dev/null 2>&1; then`,
    ]);
  });
});
