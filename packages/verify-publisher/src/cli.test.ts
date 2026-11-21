import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { runCli } from "./cli.js";
import { config, FakeGithub, marker, now, request, uuid } from "./testkit/fixtures.js";

const dir = join(tmpdir(), randomUUID()), c = join(dir, "config"), q = join(dir, "request"), l = join(dir, "ledger");
const common = ["--config", c, "--ledger", l];
const publish = ["publish", "--request", q, ...common];
const abandon = ["abandon", "--invocation", uuid(2), ...common];

beforeEach(async () => {
  await mkdir(dir);
  await writeFile(c, JSON.stringify(config()));
  await writeFile(q, JSON.stringify(request()));
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

function setup() {
  const github = new FakeGithub();
  let sequence = 100;
  return { github, async run(argv: string[]) {
    const lines: string[] = [];
    const code = await runCli(argv, { github, now, uuid: () => uuid(sequence++), stdout: line => lines.push(line) });
    expect(lines).toHaveLength(1);
    const line = lines[0]!;
    expect(line).not.toMatch(/[\r\n]/u);
    expect(line).not.toContain(dir);
    expect(line).not.toContain(marker);
    return { code, body: JSON.parse(line) as unknown };
  } };
}

it("publishes, repeats without a read, and handles an operator invocation", async () => {
  const h = setup();
  expect(await h.run(publish)).toMatchObject({ code: 0, body: { status: "published", attempt: 1 } });
  expect(await h.run(publish)).toMatchObject({ code: 0, body: { status: "already_published" } });
  await writeFile(q, JSON.stringify(request("passed", 3)));
  expect(await h.run(publish)).toEqual({ code: 1, body: { ok: false, reason: "already_verified", detail: null } });
  expect(await h.run([...publish, "--operator"])).toMatchObject({ code: 0, body: { status: "published", attempt: 2 } });
  expect(h.github.writes).toBe(2);
  expect(new Set(h.github.signals).size).toBe(3);
});

it("abandons an unconfirmed write after a bounded lookup", async () => {
  const h = setup();
  h.github.failCreate = 1;
  expect(await h.run(publish)).toMatchObject({ code: 1, body: { reason: "write_unconfirmed" } });
  expect(await h.run(abandon)).toMatchObject({ code: 0, body: { status: "abandoned", check_run_id: null } });
  expect(await h.run(abandon)).toMatchObject({ code: 1, body: { reason: "not_open" } });
  expect(h.github.writes).toBe(1);
});

it.each([
  [], ["other"], ["publish"], ["abandon"], ["--config", c], [...publish, "stray"], [...abandon, "--operator"],
  [...publish, "--unknown"], [...publish, "--operator", "--operator"], [...publish, "--request", q], [...abandon, "--invocation", uuid(2)],
  [...publish, "--config", c], [...publish, "--ledger", l], [...publish, "--invocation", uuid(2)], [...abandon, "--request", q],
  ["publish", ...common], ["abandon", ...common], ["publish", "--request", q, "--ledger", l], ["publish", "--request", q, "--config", c],
  ["publish", ...common, "--request"], ["publish", ...common, "--request", "--operator"], ["abandon", ...common, "--invocation", "bad"],
].map(argv => ({ argv })))("rejects usage error %#", async ({ argv }) => {
  const h = setup();
  expect(await h.run(argv)).toEqual({ code: 2, body: { ok: false, reason: "usage", detail: null } });
  expect(h.github.paths).toHaveLength(0);
});

it.each(["config", "request"] as const)("bounds and validates the %s file", async which => {
  const h = setup(), path = which === "config" ? c : q;
  const json = JSON.stringify(which === "config" ? config() : request());
  for (const content of [null, marker, "{}", json.padEnd(262145)]) {
    if (content === null) await rm(path);
    else await writeFile(path, content);
    expect(await h.run(publish)).toEqual({ code: 2, body: { ok: false, reason: which + "_invalid", detail: null } });
  }
  expect(h.github.paths).toHaveLength(0);
  await writeFile(path, json.padEnd(262144));
  expect(await h.run(publish)).toMatchObject({ code: 0, body: { status: "published" } });
});
