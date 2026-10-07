import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { join } from "node:path";

type Entry = { flag: string; value?: string };
type Defaults = {
  schemaVersion: 1;
  enabled: boolean;
  run: Entry[];
  enqueue: Entry[];
};
const MAX_BYTES = 65_536;
const RUN_SCALARS = new Set([
  "--execute",
  "--agent",
  "--profile",
  "--max-iter",
  "--command-timeout-ms",
  "--discovery-policy",
  "--max-runtime-ms",
  "--max-tokens",
  "--max-cost-usd",
  "--no-progress-limit",
]);
const RUN_REPEATED = new Set([
  "--verify",
  "--reviewer",
  "--checker",
  "--target-path",
  "--forbid-path",
  "--role",
  "--source",
]);
const RUN_BOOLEAN = new Set([
  "--worktree",
  "--artifact-verification",
  "--auto-agent",
]);
const ENQUEUE_SCALARS = new Set(["--capability", "--priority"]);
const EXECUTION = new Set([
  "--execute",
  "--agent",
  "--auto-agent",
  "--profile",
  "--role",
]);
const DIRECT_EXECUTION = new Set(["--execute", "--agent", "--auto-agent"]);
const refusal = () => new Error("LOOP_DEFAULTS_INVALID");
function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw refusal();
  return value as Record<string, unknown>;
}
function entries(value: unknown, enqueue: boolean): Entry[] {
  if (!Array.isArray(value) || value.length > 64) throw refusal();
  const scalars = enqueue ? ENQUEUE_SCALARS : RUN_SCALARS;
  const repeated = enqueue ? new Set<string>() : RUN_REPEATED;
  const booleans = enqueue ? new Set<string>() : RUN_BOOLEAN;
  const seen = new Set<string>();
  const result: Entry[] = [];
  for (const raw of value) {
    const item = object(raw);
    if (typeof item["flag"] !== "string") throw refusal();
    const flag = item["flag"];
    if (booleans.has(flag)) {
      if (Object.keys(item).length !== 1 || seen.has(flag)) throw refusal();
      result.push({ flag });
    } else {
      if (
        (!scalars.has(flag) && !repeated.has(flag)) ||
        Object.keys(item).length !== 2 ||
        typeof item["value"] !== "string" ||
        item["value"].trim() === "" ||
        item["value"].trimStart().startsWith("--") ||
        item["value"].length > 16_384 ||
        item["value"].includes("\0")
      )
        throw refusal();
      const integer = new Set([
        "--priority",
        "--max-iter",
        "--command-timeout-ms",
        "--max-runtime-ms",
        "--max-tokens",
        "--no-progress-limit",
      ]);
      if (
        integer.has(flag) &&
        (!Number.isInteger(Number(item["value"])) ||
          Number(item["value"]) < 1 ||
          (flag === "--priority" && Number(item["value"]) > 100))
      )
        throw refusal();
      if (
        flag === "--max-cost-usd" &&
        (!Number.isFinite(Number(item["value"])) || Number(item["value"]) <= 0)
      )
        throw refusal();
      if (scalars.has(flag) && seen.has(flag)) throw refusal();
      result.push({ flag, value: item["value"] });
    }
    seen.add(flag);
  }
  if (
    !enqueue &&
    ([...DIRECT_EXECUTION].filter((flag) => seen.has(flag)).length > 1 ||
      (seen.has("--execute") && (seen.has("--profile") || seen.has("--role"))))
  )
    throw refusal();
  return result;
}
function parse(value: unknown): Defaults {
  const item = object(value);
  if (
    Object.keys(item).sort().join(",") !==
      "enabled,enqueue,run,schemaVersion" ||
    item["schemaVersion"] !== 1 ||
    typeof item["enabled"] !== "boolean"
  )
    throw refusal();
  return {
    schemaVersion: 1,
    enabled: item["enabled"],
    run: entries(item["run"], false),
    enqueue: entries(item["enqueue"], true),
  };
}

async function read(home: string): Promise<Defaults | undefined> {
  const parent = join(home, "loop-defaults"),
    path = join(parent, "config.json");
  let before: Awaited<ReturnType<typeof lstat>>;
  try {
    before = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw refusal();
    // A genuinely absent preference directory is legacy, not an unsafe existing link.
    let existing: Awaited<ReturnType<typeof lstat>>;
    try {
      existing = await lstat(parent);
    } catch (parentError) {
      if ((parentError as NodeJS.ErrnoException).code !== "ENOENT")
        throw refusal();
      try {
        const existingHome = await lstat(home);
        if (
          existingHome.isSymbolicLink() &&
          !(await realpath(home).catch(() => undefined))
        )
          throw refusal();
      } catch (homeError) {
        if ((homeError as NodeJS.ErrnoException).code !== "ENOENT")
          throw refusal();
      }
      return undefined;
    }
    if (
      !existing.isDirectory() ||
      existing.isSymbolicLink() ||
      existing.uid !== process.getuid?.() ||
      (existing.mode & 0o7777) !== 0o700
    )
      throw refusal();
    return undefined;
  }
  const uid = process.getuid?.();
  const directory = await lstat(parent);
  if (
    uid === undefined ||
    !directory.isDirectory() ||
    directory.isSymbolicLink() ||
    directory.uid !== uid ||
    (directory.mode & 0o7777) !== 0o700 ||
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.uid !== uid ||
    before.nlink !== 1 ||
    (before.mode & 0o7777) !== 0o600 ||
    before.size < 1 ||
    before.size > MAX_BYTES ||
    constants.O_NOFOLLOW === undefined
  )
    throw refusal();
  const canonical = await realpath(parent);
  const file = await open(
    join(canonical, "config.json"),
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const opened = await file.stat();
    const same = (a: typeof before, b: typeof before) =>
      a.dev === b.dev &&
      a.ino === b.ino &&
      a.size === b.size &&
      a.mtimeMs === b.mtimeMs &&
      a.ctimeMs === b.ctimeMs &&
      a.mode === b.mode &&
      a.nlink === b.nlink &&
      a.uid === b.uid;
    if (!same(before, opened)) throw refusal();
    const bytes = Buffer.alloc(MAX_BYTES + 1);
    let length = 0;
    while (length <= MAX_BYTES) {
      const result = await file.read(
        bytes,
        length,
        bytes.length - length,
        length,
      );
      if (result.bytesRead === 0) break;
      length += result.bytesRead;
    }
    if (
      length !== before.size ||
      length > MAX_BYTES ||
      !same(before, await file.stat()) ||
      !same(before, await lstat(path))
    )
      throw refusal();
    const afterParent = await lstat(parent);
    if (
      directory.dev !== afterParent.dev ||
      directory.ino !== afterParent.ino ||
      directory.mode !== afterParent.mode ||
      directory.uid !== afterParent.uid ||
      canonical !== (await realpath(parent))
    )
      throw refusal();
    return parse(
      JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(
          bytes.subarray(0, length),
        ),
      ) as unknown,
    );
  } finally {
    await file.close();
  }
}

function explicitFlags(args: string[], strict = true): Set<string> {
  const valueFlags =
    args[0] === "enqueue"
      ? new Set([
          "--workspace",
          "--capability",
          "--id",
          "--priority",
          "--context-json",
        ])
      : new Set([
          ...RUN_SCALARS,
          ...RUN_REPEATED,
          ...ENQUEUE_SCALARS,
          "--workspace",
          "--id",
          "--context-json",
          "--goal",
          "--state",
          "--markdown",
          "--worktree-root",
          "--cycles",
          "--interval-ms",
          "--lessons-dir",
          "--repo-id",
          "--govern",
          "--govern-scope",
          "--knowledge",
          "--knowledge-source",
          "--knowledge-query",
          "--knowledge-pack",
          "--knowledge-cloud-url",
          "--report-language",
          "--output-dir",
          "--autonomy",
          "--schedule",
        ]);
  const result = new Set<string>();
  for (let index = 1; index < args.length; index++) {
    const flag = args[index]!;
    if (!flag.startsWith("--")) continue;
    if (
      flag === "--govern" &&
      (args[index + 1] === undefined || args[index + 1]!.startsWith("--"))
    ) {
      result.add(flag);
      continue;
    }
    if (valueFlags.has(flag)) {
      if (index + 1 >= args.length && strict) throw refusal();
      result.add(flag);
      index++; // A value that looks like a flag is still one consumed value.
    } else result.add(flag);
  }
  return result;
}

/** Preferences become ordinary argv; original CLI parsers own their semantics. */
export async function applyLoopDefaults(
  args: string[],
  home: string,
): Promise<string[]> {
  if (
    !["run", "enqueue"].includes(args[0] ?? "") ||
    args.includes("--help") ||
    args.includes("--daemon") ||
    (args[0] === "run" &&
      args.indexOf("--autonomy") >= 0 &&
      args[args.indexOf("--autonomy") + 1] !== undefined &&
      args[args.indexOf("--autonomy") + 1] !== "legacy")
  )
    return args;
  let config: Defaults | undefined;
  try {
    config = await read(home);
  } catch {
    throw refusal();
  }
  if (!config?.enabled) return args;
  const defaults = args[0] === "enqueue" ? config.enqueue : config.run;
  const prefix: string[] = [];
  const scalar = args[0] === "enqueue" ? ENQUEUE_SCALARS : RUN_SCALARS;
  const explicit = explicitFlags(args);
  const explicitExecution = [...EXECUTION].some((flag) => explicit.has(flag));
  const added = new Set<string>();
  for (const entry of defaults) {
    if (EXECUTION.has(entry.flag) && explicitExecution) continue;
    if (
      (scalar.has(entry.flag) ||
        RUN_BOOLEAN.has(entry.flag) ||
        entry.flag === "--source") &&
      explicit.has(entry.flag)
    )
      continue;
    const key = JSON.stringify(entry);
    if (added.has(key)) continue;
    added.add(key);
    prefix.push(entry.flag);
    if (entry.value !== undefined) prefix.push(entry.value);
  }
  return [args[0]!, ...prefix, ...args.slice(1)];
}
