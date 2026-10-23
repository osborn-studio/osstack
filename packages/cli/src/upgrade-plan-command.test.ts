import {
  chmodSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { createScratchDirSync } from "@osstack/core";
import { afterEach, expect, it, vi } from "vitest";
import { handleUpgradePlanCommand } from "./upgrade-plan-command.js";
import { upgradeFixture } from "./upgrade-test-fixture.js";
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});
function fixture() {
  const root = realpathSync(createScratchDirSync("tests", "upgrade-plan-cli"));
  roots.push(root);
  const journal = join(root, "journal");
  mkdirSync(journal, { mode: 0o700 });
  const f = upgradeFixture();
  const request = { ...f.request, expires_at_ms: Date.now() + 60000 };
  const requestPath = join(root, "request.json");
  writeFileSync(requestPath, JSON.stringify(request));
  const registryPath = join(root, "registry.json");
  writeFileSync(
    registryPath,
    JSON.stringify({
      schema_version: 1,
      homes: f.observations.map((row) => ({
        ...row.desired,
        socket: join(root, row.desired.home_id + ".sock"),
      })),
    }),
  );
  const stdout = vi.fn(),
    stderr = vi.fn();
  return { root, journal, requestPath, registryPath, stdout, stderr };
}
it("persists only a plan for unreachable explicit homes and reads status without creating an execution claim", async () => {
  const f = fixture();
  const args = [
    "plan-upgrade",
    "--request",
    f.requestPath,
    "--registry",
    f.registryPath,
    "--journal",
    f.journal,
  ];
  expect(await handleUpgradePlanCommand(args, f)).toBe(0);
  const result = JSON.parse(f.stdout.mock.calls[0]![0] as string);
  expect(result).toMatchObject({
    qualification: "qualification_pending",
    execution_started: false,
    plan: { authority: "none", rollback: "no_database_restore" },
  });
  const before = readdirSync(f.journal);
  expect(before.some((name) => name.includes("claim"))).toBe(false);
  expect(
    await handleUpgradePlanCommand(
      [
        "upgrade-status",
        "--digest",
        result.digest,
        "--group",
        "group",
        "--journal",
        f.journal,
      ],
      f,
    ),
  ).toBe(0);
  expect(JSON.parse(f.stdout.mock.calls.at(-1)![0] as string)).toMatchObject({
    completed: false,
    resume_allowed: false,
  });
  expect(readdirSync(f.journal)).toEqual(before);
  expect(readdirSync(f.root).some((name) => name.endsWith(".db"))).toBe(false);
});
it("rejects implicit authority, unsafe journal and latest version without upgrading anything", async () => {
  const f = fixture();
  const args = [
    "plan-upgrade",
    "--request",
    f.requestPath,
    "--registry",
    f.registryPath,
    "--journal",
    f.journal,
  ];
  expect(await handleUpgradePlanCommand([...args, "--apply"], f)).toBe(1);
  expect(await handleUpgradePlanCommand(["apply", ...args.slice(1)], f)).toBe(
    1,
  );
  chmodSync(f.journal, 0o755);
  expect(await handleUpgradePlanCommand(args, f)).toBe(1);
  chmodSync(f.journal, 0o700);
  const request = JSON.parse(readFileSync(f.requestPath, "utf8"));
  request.target.version = "latest";
  writeFileSync(f.requestPath, JSON.stringify(request));
  expect(await handleUpgradePlanCommand(args, f)).toBe(1);
  expect(readdirSync(f.journal)).toEqual([]);
});
it("routes plan and status through actual main without exposing an apply command", async () => {
  const f = fixture();
  const home = join(f.root, "home");
  mkdirSync(home, { mode: 0o700 });
  vi.stubEnv("OSSTACK_HOME", home);
  vi.stubEnv("OSSTACK_UPDATE_CHECK", "0");
  const { main } = await import("./bin.js");
  const out = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    expect(
      await main([
        "homes",
        "plan-upgrade",
        "--request",
        f.requestPath,
        "--registry",
        f.registryPath,
        "--journal",
        f.journal,
      ]),
    ).toBe(0);
    const plan = JSON.parse(out.mock.calls.at(-1)![0] as string);
    expect(plan.execution_started).toBe(false);
    expect(
      await main([
        "homes",
        "upgrade-status",
        "--digest",
        plan.digest,
        "--group",
        "group",
        "--journal",
        f.journal,
      ]),
    ).toBe(0);
    expect(JSON.parse(out.mock.calls.at(-1)![0] as string)).toMatchObject({
      completed: false,
      resume_allowed: false,
    });
    expect(readdirSync(home)).toEqual([]);
  } finally {
    vi.unstubAllEnvs();
  }
});

it('shows routed subcommand help without requiring a journal or contacting homes',async()=>{const stdout=vi.fn();expect(await handleUpgradePlanCommand(['plan-upgrade','--help'],{stdout})).toBe(0);expect(await handleUpgradePlanCommand(['upgrade-status','--help'],{stdout})).toBe(0);expect(stdout).toHaveBeenCalledTimes(2);});
