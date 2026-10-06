import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, expect, it } from "vitest";
import { applyLoopDefaults } from "./loop-defaults.js";
let root: string;
const config = (run: unknown[] = [], enqueue: unknown[] = []) => ({
  schemaVersion: 1,
  enabled: true,
  run,
  enqueue,
});
async function save(value: unknown) {
  await mkdir(join(root, "loop-defaults"), { mode: 0o700 });
  await writeFile(
    join(root, "loop-defaults/config.json"),
    JSON.stringify(value),
    { mode: 0o600 },
  );
}
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "loop-defaults-unit-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
it("keeps missing home/config legacy argv untouched", async () => {
  const args = ["run", "--verify", "old"];
  expect(await applyLoopDefaults(args, join(root, "missing"))).toBe(args);
});
it("does not load configuration for unsupported surfaces", async () => {
  await save({ bad: true });
  for (const args of [
    ["start"],
    ["status"],
    ["run", "--daemon"],
    ["run", "--help"],
  ])
    expect(await applyLoopDefaults(args, root)).toBe(args);
});
it("injects scalar defaults only when absent; keeps original explicit first-match order", async () => {
  await save(config([{ flag: "--max-iter", value: "1" }]));
  expect(await applyLoopDefaults(["run"], root)).toEqual([
    "run",
    "--max-iter",
    "1",
  ]);
  expect(
    await applyLoopDefaults(
      ["run", "--max-iter", "2", "--max-iter", "3"],
      root,
    ),
  ).toEqual(["run", "--max-iter", "2", "--max-iter", "3"]);
});
it("unions mandatory repeated gates and leaves explicit repeats intact", async () => {
  await save(
    config([
      { flag: "--verify", value: "old" },
      { flag: "--reviewer", value: "review" },
      { flag: "--checker", value: "check" },
    ]),
  );
  expect(
    await applyLoopDefaults(
      ["run", "--verify", "new", "--verify", "new"],
      root,
    ),
  ).toEqual([
    "run",
    "--verify",
    "old",
    "--reviewer",
    "review",
    "--checker",
    "check",
    "--verify",
    "new",
    "--verify",
    "new",
  ]);
});
it("uses explicit sources and suppresses configured routing for explicit roles", async () => {
  await save(
    config([
      { flag: "--source", value: "task_queue" },
      { flag: "--role", value: "coder=default" },
    ]),
  );
  expect(
    await applyLoopDefaults(
      ["run", "--source", "git_diff", "--role", "builder=explicit"],
      root,
    ),
  ).toEqual(["run", "--source", "git_diff", "--role", "builder=explicit"]);
});
it("lets explicit execution selection suppress the whole default family", async () => {
  await save(config([{ flag: "--agent", value: "default" }]));
  expect(
    await applyLoopDefaults(["run", "--execute", "literal"], root),
  ).toEqual(["run", "--execute", "literal"]);
});
it("adds native booleans without inventing negation", async () => {
  await save(config([{ flag: "--worktree" }]));
  expect(await applyLoopDefaults(["run", "--worktree"], root)).toEqual([
    "run",
    "--worktree",
  ]);
});
it("enqueue defaults cannot leak a new prompt or id", async () => {
  await save(
    config(
      [],
      [
        { flag: "--capability", value: "code.fix" },
        { flag: "--priority", value: "40" },
      ],
    ),
  );
  expect(
    await applyLoopDefaults(
      ["enqueue", "actual prompt", "--priority", "50"],
      root,
    ),
  ).toEqual([
    "enqueue",
    "--capability",
    "code.fix",
    "actual prompt",
    "--priority",
    "50",
  ]);
});
it.each([
  { bad: true },
  { ...config(), unknown: true },
  { ...config(), enabled: "yes" },
  config([{ flag: "--workspace", value: "/wrong" }]),
  config([
    { flag: "--execute", value: "x" },
    { flag: "--agent", value: "x" },
  ]),
  config([{ flag: "--worktree", value: "yes" }]),
  config([
    { flag: "--max-iter", value: "1" },
    { flag: "--max-iter", value: "2" },
  ]),
  config([], [{ flag: "--id", value: "repeat" }]),
])("rejects strict schema violation %j", async (value) => {
  await save(value);
  await expect(applyLoopDefaults(["run"], root)).rejects.toThrow(
    "LOOP_DEFAULTS_INVALID",
  );
});
it("disabled remains schema/private validated", async () => {
  await save({ ...config(), enabled: false });
  const args = ["run"];
  expect(await applyLoopDefaults(args, root)).toBe(args);
  await chmod(join(root, "loop-defaults/config.json"), 0o644);
  await expect(applyLoopDefaults(args, root)).rejects.toThrow(
    "LOOP_DEFAULTS_INVALID",
  );
});
it("rejects file and dedicated directory unsafe permissions", async () => {
  await save(config());
  await chmod(join(root, "loop-defaults"), 0o755);
  await expect(applyLoopDefaults(["run"], root)).rejects.toThrow(
    "LOOP_DEFAULTS_INVALID",
  );
});
it("rejects dangling and hardlinked configuration", async () => {
  await mkdir(join(root, "loop-defaults"), { mode: 0o700 });
  await symlink(join(root, "absent"), join(root, "loop-defaults/config.json"));
  await expect(applyLoopDefaults(["run"], root)).rejects.toThrow(
    "LOOP_DEFAULTS_INVALID",
  );
  await rm(join(root, "loop-defaults/config.json"));
  await writeFile(join(root, "original"), JSON.stringify(config()), {
    mode: 0o600,
  });
  await link(join(root, "original"), join(root, "loop-defaults/config.json"));
  await expect(applyLoopDefaults(["run"], root)).rejects.toThrow(
    "LOOP_DEFAULTS_INVALID",
  );
});
it("rejects oversized/malformed bytes without echoing contents", async () => {
  await save(config());
  const path = join(root, "loop-defaults/config.json");
  await writeFile(path, "x".repeat(65_537));
  await expect(applyLoopDefaults(["run"], root)).rejects.toThrow(
    /^LOOP_DEFAULTS_INVALID$/,
  );
  await writeFile(path, Buffer.from([0xff]));
  await expect(applyLoopDefaults(["run"], root)).rejects.toThrow(
    /^LOOP_DEFAULTS_INVALID$/,
  );
  expect((await readFile(path)).length).toBe(1);
});

it("consumes value tokens before detecting explicit flags", async () => {
  await save(config([{ flag: "--agent", value: "default" }]));
  expect(await applyLoopDefaults(["run", "--verify", "--agent"], root)).toEqual(
    ["run", "--agent", "default", "--verify", "--agent"],
  );
});
it("unsafe existing dangling preference parent is not missing configuration", async () => {
  await symlink(join(root, "absent"), join(root, "loop-defaults"));
  await expect(applyLoopDefaults(["run"], root)).rejects.toThrow(
    "LOOP_DEFAULTS_INVALID",
  );
});
it("rejects special permission bits", async () => {
  await save(config());
  await chmod(join(root, "loop-defaults/config.json"), 0o4600);
  await expect(applyLoopDefaults(["run"], root)).rejects.toThrow(
    "LOOP_DEFAULTS_INVALID",
  );
});
it("native home aliases resolve to the same checked private preference tree", async () => {
  const alias = join(root, "alias");
  const actual = join(root, "actual");
  await mkdir(actual);
  await mkdir(join(actual, "loop-defaults"), { mode: 0o700 });
  await writeFile(
    join(actual, "loop-defaults/config.json"),
    JSON.stringify(config([{ flag: "--max-iter", value: "1" }])),
    { mode: 0o600 },
  );
  await symlink(actual, alias);
  expect(await applyLoopDefaults(["run"], alias)).toEqual([
    "run",
    "--max-iter",
    "1",
  ]);
});

it("default values cannot inject flat CLI control flags", async () => {
  await save(config([{ flag: "--verify", value: "--daemon" }]));
  await expect(applyLoopDefaults(["run"], root)).rejects.toThrow(
    "LOOP_DEFAULTS_INVALID",
  );
});

it("permits profile plus role defaults but rejects execute plus routing defaults", async () => {
  await save(
    config([
      { flag: "--profile", value: "synthetic" },
      { flag: "--role", value: "coder=fixture" },
    ]),
  );
  expect(await applyLoopDefaults(["run"], root)).toEqual([
    "run",
    "--profile",
    "synthetic",
    "--role",
    "coder=fixture",
  ]);
  for (const flag of ["--profile", "--role", "--agent"]) {
    await writeFile(
      join(root, "loop-defaults/config.json"),
      JSON.stringify(
        config([
          { flag: "--execute", value: "literal" },
          { flag, value: "synthetic" },
        ]),
      ),
    );
    await expect(applyLoopDefaults(["run"], root)).rejects.toThrow(
      "LOOP_DEFAULTS_INVALID",
    );
  }
});
it("nonlegacy autonomy preserves raw args without reading unsafe preferences", async () => {
  await save({ broken: true });
  for (const mode of ["guarded", "native-unknown"]) {
    const args = ["run", "--autonomy", mode];
    expect(await applyLoopDefaults(args, root)).toBe(args);
  }
  await expect(
    applyLoopDefaults(["run", "--autonomy", "legacy"], root),
  ).rejects.toThrow("LOOP_DEFAULTS_INVALID");
});
