import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { CandidatePolicy, assertCandidateStateDirectory } from "@osstack/loop";

const fail = () => new Error("LOOP_CANDIDATE_INPUT_INVALID");
const MAX_BYTES = 65_536;
const RUN_VALUES = new Set([
  "--workspace",
  "--execute",
  "--agent",
  "--profile",
  "--role",
  "--verify",
  "--reviewer",
  "--checker",
  "--target-path",
  "--forbid-path",
  "--max-iter",
  "--command-timeout-ms",
  "--discovery-policy",
  "--max-runtime-ms",
  "--max-tokens",
  "--max-cost-usd",
  "--no-progress-limit",
  "--source",
  "--worktree-root",
  "--candidate-policy",
]);
const ENQUEUE_VALUES = new Set([
  "--workspace",
  "--capability",
  "--id",
  "--priority",
  "--context-json",
  "--candidate-policy",
]);
const BOOLEANS = new Set([
  "--worktree",
  "--auto-agent",
  "--artifact-verification",
  "--json",
]);
const SCAN_RUN_VALUES = new Set([
  ...RUN_VALUES,
  "--state",
  "--markdown",
  "--goal",
  "--schedule",
  "--autonomy",
  "--cycles",
  "--interval-ms",
  "--lessons-dir",
  "--repo-id",
  "--govern-scope",
  "--knowledge-source",
  "--knowledge-query",
  "--knowledge-pack",
  "--knowledge-cloud-url",
  "--report-language",
  "--output-dir",
  "--knowledge",
  "--knowledge-mode",
  "--govern",
  "--cache-dir",
  "--cloud-url",
  "--token",
  "--registry",
  "--lang",
]);
function candidatePaths(args: string[]): string[] {
  const values = args[0] === "enqueue" ? ENQUEUE_VALUES : SCAN_RUN_VALUES;
  const paths: string[] = [];
  for (let i = 1; i < args.length; i++) {
    const flag = args[i]!;
    if (values.has(flag)) {
      // Native governance is the sole optional-value flag in this scanner.
      if (flag === "--govern" && (args[i + 1] === undefined || args[i + 1]!.startsWith("--"))) continue;
      const value = args[++i];
      if (flag === "--candidate-policy") {
        if (value === undefined) throw fail();
        paths.push(value);
      }
    }
  }
  return paths;
}
function checkFlags(args: string[]): void {
  const seen = new Set<string>();
  const repeated = new Set(["--verify", "--reviewer", "--checker", "--role", "--target-path", "--forbid-path"]);
  const values = args[0] === "enqueue" ? ENQUEUE_VALUES : RUN_VALUES;
  for (let i = 1; i < args.length; i++) {
    const flag = args[i]!;
    if (!flag.startsWith("--")) {
      if (args[0] === "run") throw fail();
      continue;
    }
    if (values.has(flag)) {
      if (!repeated.has(flag) && seen.has(flag)) throw fail();
      seen.add(flag);
      const value = args[++i];
      if (value === undefined || value.startsWith("--")) throw fail();
      if (flag === "--source" && value !== "task_queue") throw fail();
    } else if (
      !BOOLEANS.has(flag) ||
      (args[0] === "enqueue" && flag !== "--json")
    )
      throw fail();
  }
}

/** Explicit opt-in only. Read-only checks finish before lease/queue/checkpoint effects. */
export async function readLoopCandidateInput(
  args: string[],
): Promise<CandidatePolicy | undefined> {
  let paths: string[];
  try {
    paths = candidatePaths(args);
  } catch {
    throw fail();
  }
  if (paths.length === 0) return undefined;
  try {
    if (paths.length !== 1 || !["run", "enqueue"].includes(args[0] ?? ""))
      throw fail();
    checkFlags(args);
    const path = paths[0];
    if (path === undefined || !isAbsolute(path) || path.startsWith("--"))
      throw fail();
    if (
      args[0] === "run" &&
      (!args.includes("--worktree") ||
        args.filter((v) => v === "--source").length !== 1)
    )
      throw fail();
    const uid = process.getuid?.();
    const parent = dirname(path),
      directory = await lstat(parent),
      before = await lstat(path);
    if (
      uid === undefined ||
      constants.O_NOFOLLOW === undefined ||
      !directory.isDirectory() ||
      directory.isSymbolicLink() ||
      directory.uid !== uid ||
      (directory.mode & 0o7777) !== 0o700 ||
      (await realpath(parent)) !== parent ||
      !before.isFile() ||
      before.isSymbolicLink() ||
      before.nlink !== 1 ||
      before.uid !== uid ||
      (before.mode & 0o7777) !== 0o600 ||
      before.size < 1 ||
      before.size > MAX_BYTES ||
      (await realpath(path)) !== path
    )
      throw fail();
    const same = (a: typeof before, b: typeof before) =>
      a.dev === b.dev &&
      a.ino === b.ino &&
      a.mode === b.mode &&
      a.uid === b.uid &&
      a.nlink === b.nlink &&
      a.size === b.size &&
      a.mtimeMs === b.mtimeMs &&
      a.ctimeMs === b.ctimeMs;
    const fd = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    let bytes: Buffer;
    try {
      if (!same(before, await fd.stat())) throw fail();
      bytes = Buffer.alloc(MAX_BYTES + 1);
      let count = 0;
      while (count < bytes.length) {
        const read = await fd.read(bytes, count, bytes.length - count, count);
        if (!read.bytesRead) break;
        count += read.bytesRead;
      }
      if (
        count !== before.size ||
        count > MAX_BYTES ||
        !same(before, await fd.stat()) ||
        !same(before, await lstat(path))
      )
        throw fail();
      bytes = bytes.subarray(0, count);
    } finally {
      await fd.close();
    }
    const after = await lstat(parent);
    if (
      after.dev !== directory.dev ||
      after.ino !== directory.ino ||
      after.uid !== uid ||
      (after.mode & 0o7777) !== 0o700 ||
      (await realpath(parent)) !== parent
    )
      throw fail();
    const policy = CandidatePolicy.parse(
      JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      ) as unknown,
    );
    await assertCandidateStateDirectory(policy.stateDirectory);
    const workspaceIndex = args.indexOf("--workspace");
    const workspace = await realpath(
      resolve(workspaceIndex >= 0 ? args[workspaceIndex + 1]! : process.cwd()),
    );
    const within = relative(workspace, policy.stateDirectory);
    if (
      within !== ".." &&
      !within.startsWith(".." + sep) &&
      !isAbsolute(within)
    )
      throw fail();
    return policy;
  } catch {
    throw fail();
  }
}
/** Union effective parsed CLI/default verifies without replacing evaluations/reviewer/artifact gates. */
export function withLoopCandidateVerifiers(
  policy: CandidatePolicy,
  verifies: string[],
): CandidatePolicy {
  return CandidatePolicy.parse({
    ...policy,
    profiles: Object.fromEntries(
      Object.entries(policy.profiles).map(([stage, commands]) => [
        stage,
        [...new Set([...verifies, ...commands])],
      ]),
    ),
  });
}
