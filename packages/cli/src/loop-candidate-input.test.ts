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
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  readLoopCandidateInput,
  withLoopCandidateVerifiers,
} from "./loop-candidate-input.js";
let root: string, path: string, policy: ReturnType<typeof fixture>;
function fixture(state: string) {
  return {
    batchId: "batch-one",
    scopeId: "related",
    branch: "codex/test",
    policyFingerprint: "a".repeat(64),
    environmentFingerprint: "b".repeat(64),
    testsFingerprint: "c".repeat(64),
    maxTasks: 2,
    scopePaths: ["file.txt"],
    stateDirectory: state,
    profiles: { local: ["local"], prepush: ["prepush"], final: ["final"] },
  };
}
const args = () => [
  "run",
  "--source",
  "task_queue",
  "--worktree",
  "--workspace",
  join(root, "repo"),
  "--candidate-policy",
  path,
];
beforeEach(async () => {
  root = realpathSync(await mkdtemp(join(tmpdir(), "candidate-input-")));
  await mkdir(join(root, "repo"));
  await mkdir(join(root, "state"), { mode: 0o700 });
  path = join(root, "policy.json");
  policy = fixture(join(root, "state"));
  await writeFile(path, JSON.stringify(policy), { mode: 0o600 });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
it("reads actual private bytes and unions native gates in every existing stage", async () => {
  const actual = await readLoopCandidateInput(args());
  expect(actual).toEqual(policy);
  const union = withLoopCandidateVerifiers(actual!, ["mandatory", "local"]);
  expect(union.profiles).toEqual({
    local: ["mandatory", "local"],
    prepush: ["mandatory", "local", "prepush"],
    final: ["mandatory", "local", "final"],
  });
  expect(JSON.parse(await readFile(path, "utf8"))).toEqual(policy);
});
it("absence and flag-looking consumed values do not opt in", async () => {
  expect(
    await readLoopCandidateInput(["run", "--verify", "--candidate-policy"]),
  ).toBeUndefined();
  expect(
    await readLoopCandidateInput(["run", "--goal", "--candidate-policy"]),
  ).toBeUndefined();
  expect(
    await readLoopCandidateInput([
      "enqueue",
      "--capability",
      "--candidate-policy",
    ]),
  ).toBeUndefined();
});
it.each([
  "relative",
  "duplicate",
  "missing",
  "no-worktree",
  "no-source",
  "other-source",
  "double-source",
  "unknown-option",
  "start",
])("rejects exact opt-in invalid %s", async (mode) => {
  let input = args();
  if (mode === "relative") input[input.length - 1] = "policy.json";
  if (mode === "duplicate") input.push("--candidate-policy", path);
  if (mode === "missing") input.pop();
  if (mode === "no-worktree") input = input.filter((v) => v !== "--worktree");
  if (mode === "no-source") input.splice(1, 2);
  if (mode === "other-source") input[2] = "git_diff";
  if (mode === "double-source") input.push("--source", "task_queue");
  if (mode === "unknown-option") input.push("--max-tasks", "1");
  if (mode === "start") input[0] = "start";
  await expect(readLoopCandidateInput(input)).rejects.toThrow(
    "LOOP_CANDIDATE_INPUT_INVALID",
  );
});
it.each([
  "unknown",
  "empty-profile",
  "max-tasks",
  "missing-binding",
  "scope-escape",
  "invalid-utf8",
  "oversize",
])("refuses actual file schema/bytes %s", async (mode) => {
  let value: unknown = policy;
  if (mode === "unknown") value = { ...policy, secret: "never echoed" };
  if (mode === "empty-profile")
    value = { ...policy, profiles: { ...policy.profiles, local: [] } };
  if (mode === "max-tasks") value = { ...policy, maxTasks: 17 };
  if (mode === "missing-binding")
    value = { ...policy, environmentFingerprint: undefined };
  if (mode === "scope-escape") value = { ...policy, scopePaths: ["../escape"] };
  await writeFile(
    path,
    mode === "invalid-utf8"
      ? Buffer.from([255])
      : mode === "oversize"
        ? "x".repeat(65537)
        : JSON.stringify(value),
  );
  await expect(readLoopCandidateInput(args())).rejects.toThrow(
    "LOOP_CANDIDATE_INPUT_INVALID",
  );
});
it.each([
  "mode",
  "special-bits",
  "parent",
  "hardlink",
  "symlink",
  "fifo",
  "state-mode",
  "state-alias",
  "state-in-workspace",
])("refuses actual filesystem %s", async (mode) => {
  if (mode === "mode") await chmod(path, 0o644);
  if (mode === "special-bits") await chmod(path, 0o4600);
  if (mode === "parent") await chmod(root, 0o755);
  if (mode === "hardlink") await link(path, join(root, "second"));
  if (mode === "symlink") {
    await rm(path);
    await symlink("missing", path);
  }
  if (mode === "fifo") {
    await rm(path);
    const { execFileSync } = await import("node:child_process");
    execFileSync("mkfifo", [path]);
    await chmod(path, 0o600);
  }
  if (mode === "state-mode") await chmod(policy.stateDirectory, 0o755);
  if (mode === "state-alias") {
    await symlink(policy.stateDirectory, join(root, "alias"));
    policy.stateDirectory = join(root, "alias");
    await writeFile(path, JSON.stringify(policy));
  }
  if (mode === "state-in-workspace") {
    await mkdir(join(root, "repo/state"), { mode: 0o700 });
    policy.stateDirectory = join(root, "repo/state");
    await writeFile(path, JSON.stringify(policy));
  }
  await expect(readLoopCandidateInput(args())).rejects.toThrow(
    "LOOP_CANDIDATE_INPUT_INVALID",
  );
});

it.each([
  "--knowledge",
  "--knowledge-mode",
  "--cache-dir",
  "--cloud-url",
  "--token",
  "--state",
  "--markdown",
  "--lessons-dir",
  "--registry",
  "--discovery-policy",
])("legacy consumed %s value cannot activate candidate input", async (flag) => {
  expect(
    await readLoopCandidateInput(["run", flag, "--candidate-policy"]),
  ).toBeUndefined();
});

it("duplicate scalar candidate flags refuse rather than first-value ambiguity", async () => { await expect(readLoopCandidateInput([...args(), "--workspace", join(root, "repo")])).rejects.toThrow("LOOP_CANDIDATE_INPUT_INVALID"); });
it("native optional govern cannot swallow a real candidate flag", async () => { await expect(readLoopCandidateInput(["run", "--govern", "--candidate-policy"])).rejects.toThrow("LOOP_CANDIDATE_INPUT_INVALID"); });
