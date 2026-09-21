import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { handleDecisionCommand } from "./decision-command.js";

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "decision-cli-"));
  roots.push(root);
  const input = join(root, "input.json");
  await writeFile(
    input,
    JSON.stringify({
      schemaVersion: 1,
      scopeId: "demo",
      taskId: "t",
      taskRevision: 0,
      purpose: "failure_label",
      state: "private failure description",
    }),
  );
  return { root, input };
}
it("dry-run needs no key, never fetches, writes no ledger, and omits state", async () => {
  const { root, input } = await setup();
  const output: string[] = [];
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  expect(
    await handleDecisionCommand(["advise", "--input", input], {
      write: (line) => output.push(line),
      env: {},
    }),
  ).toBe(0);
  expect(fetcher).not.toHaveBeenCalled();
  expect(await readdir(root)).toEqual(["input.json"]);
  expect(output.join("")).toContain('"mode":"dry-run"');
  expect(output.join("")).not.toContain("private failure description");
});
it("initializes a budget and exposes status without network or production DB", async () => {
  const { root } = await setup();
  const store = join(root, "budget");
  const output: string[] = [];
  const deps = { write: (line: string) => output.push(line), env: {} };
  expect(
    await handleDecisionCommand(
      ["init", "--store", store, "--scope", "demo"],
      deps,
    ),
  ).toBe(0);
  expect(
    JSON.parse(await readFile(join(store, "config.json"), "utf8")),
  ).toMatchObject({
    maxCalls: 1000,
    maxMicroUSD: 1_000_000,
    maxInputTokens: 10_000_000,
  });
  expect(await handleDecisionCommand(["status", "--store", store], deps)).toBe(
    0,
  );
  expect(output.join("")).toContain('"calls":0');
});
it("requires explicit live store and key, rejects unknown flags without leaking input", async () => {
  const { input } = await setup();
  const output: string[] = [];
  const deps = { write: (line: string) => output.push(line), env: {} };
  expect(
    await handleDecisionCommand(["advise", "--input", input, "--live"], deps),
  ).toBe(1);
  expect(
    await handleDecisionCommand(["advise", "--input", input, "--force"], deps),
  ).toBe(1);
  expect(output.join("")).not.toContain("private failure description");
});

it("reports missing live credentials and invalid field paths without echoing values", async () => {
  const { root, input } = await setup();
  const output: string[] = [];
  const deps = { write: (line: string) => output.push(line), env: {} };
  expect(
    await handleDecisionCommand(
      [
        "advise",
        "--input",
        input,
        "--live",
        "--store",
        join(root, "not-created"),
      ],
      deps,
    ),
  ).toBe(1);
  expect(output.pop()).toContain("DECISION_API_KEY_REQUIRED");
  const value = JSON.parse(await readFile(input, "utf8"));
  value.taskRevision = "secret-malformed-value";
  await writeFile(input, JSON.stringify(value));
  expect(await handleDecisionCommand(["advise", "--input", input], deps)).toBe(
    1,
  );
  expect(output.join("")).toContain("taskRevision");
  expect(output.join("")).not.toContain("secret-malformed-value");
});
