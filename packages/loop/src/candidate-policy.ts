import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { REVIEWER_GIT_ARGS, reviewerGitEnvironment } from "./reviewer-isolation.js";

const fingerprint = z.string().regex(/^[a-f0-9]{64}$/);
const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,95}$/);
export const CandidateBatchBinding = z.object({
  batchId: identifier, scopeId: identifier, branch: z.string().min(1),
  policyFingerprint: fingerprint, environmentFingerprint: fingerprint,
  testsFingerprint: fingerprint,
}).strict();
export type CandidateBatchBinding = z.infer<typeof CandidateBatchBinding>;
const commands = z.array(z.string().trim().min(1)).min(1).max(64);
export const CandidatePolicy = CandidateBatchBinding.extend({
  maxTasks: z.number().int().min(1).max(16),
  scopePaths: z.array(z.string().min(1).refine(p => !isAbsolute(p) && !p.split("/").includes("..") && !p.includes("\\") && p !== ".", "relative scope required")).min(1).max(256),
  profiles: z.object({ local: commands, prepush: commands, final: commands }).strict(),
  stateDirectory: z.string().refine(isAbsolute, "absolute private state directory required"),
}).strict();
export type CandidatePolicy = z.infer<typeof CandidatePolicy>;
export const CandidateEvidence = z.object({
  stage: z.enum(["final_preflight_ready", "final_preflight_failed"]),
  headSha: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/), treeSha: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
  tupleHash: fingerprint, policyHash: fingerprint, recordDirectory: z.string(),
  accepted: z.literal(false), remoteCI: z.literal("pending"),
}).strict();
const sha = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export function candidateBinding(policy: CandidatePolicy): CandidateBatchBinding {
  return CandidateBatchBinding.parse(Object.fromEntries(Object.keys(CandidateBatchBinding.shape).map(k => [k, policy[k as keyof CandidatePolicy]])));
}
function gitRaw(workspace: string, args: string[]): string {
  return execFileSync("git", ["-C", workspace, ...REVIEWER_GIT_ARGS, ...args], { env: reviewerGitEnvironment(workspace), encoding: "utf8", timeout: 10_000, maxBuffer: 1_048_576 });
}
const git = (workspace: string, args: string[]) => gitRaw(workspace, args).trim();
export function freezeCandidate(workspace: string) {
  if (gitRaw(workspace, ["ls-files", "-v", "-z"]).split("\0").some(entry => /^[a-zS] /.test(entry))) throw Error("CANDIDATE_HIDDEN_INDEX_ENTRY");
  if (git(workspace, ["status", "--porcelain", "--untracked-files=all"]) !== "") throw Error("CANDIDATE_DIRTY");
  const headSha = git(workspace, ["rev-parse", "HEAD"]), treeSha = git(workspace, ["rev-parse", "HEAD^{tree}"]), branch = git(workspace, ["branch", "--show-current"]);
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(headSha) || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(treeSha) || !branch) throw Error("CANDIDATE_GIT_IDENTITY_INVALID");
  return { headSha, treeSha, branch };
}
export function assertCandidateFrozen(workspace: string, frozen: ReturnType<typeof freezeCandidate>): void {
  const actual = freezeCandidate(workspace);
  if (actual.headSha !== frozen.headSha || actual.treeSha !== frozen.treeSha || actual.branch !== frozen.branch) throw Error("CANDIDATE_STALE");
}
export function validateCandidateBatch(policy: CandidatePolicy, tasks: readonly { task_id: string; candidateBatch?: CandidateBatchBinding | undefined }[], workspace: string): void {
  if (tasks.length === 0 || tasks.length > policy.maxTasks) throw Error("CANDIDATE_BATCH_SIZE");
  const binding = JSON.stringify(candidateBinding(policy));
  if (new Set(tasks.map(t => t.task_id)).size !== tasks.length) throw Error("CANDIDATE_DUPLICATE_TASK");
  for (const task of tasks) if (JSON.stringify(CandidateBatchBinding.parse(task.candidateBatch)) !== binding) throw Error("CANDIDATE_BATCH_MISMATCH");
  if (git(workspace, ["branch", "--show-current"]) !== policy.branch) throw Error("CANDIDATE_BRANCH_MISMATCH");
  freezeCandidate(workspace);
}
export function assertCandidateScope(workspace: string, policy: CandidatePolicy, startHead: string): void {
  const tracked = gitRaw(workspace, ["diff", startHead, "--no-renames", "--name-only", "-z"]).split("\0");
  const untracked = gitRaw(workspace, ["ls-files", "--others", "--exclude-standard", "-z"]).split("\0");
  const files = [...tracked, ...untracked].filter(Boolean);
  if (!files.length) throw Error("CANDIDATE_EMPTY_DIFF");
  for (const file of files) if (!policy.scopePaths.some(p => file === p || (p.endsWith("/") && file.startsWith(p)))) throw Error("CANDIDATE_SCOPE_MISMATCH");
}
export async function assertCandidateStateDirectory(directory: string): Promise<void> {
  const st = await lstat(directory);
  if (!st.isDirectory() || st.isSymbolicLink() || await realpath(directory) !== directory || (st.mode & 0o777) !== 0o700 || st.uid !== process.getuid?.()) throw Error("CANDIDATE_STATE_UNSAFE");
}
export async function assertCandidateStateFile(path: string): Promise<void> {
  let st: Awaited<ReturnType<typeof lstat>>;
  try { st = await lstat(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1 || st.uid !== process.getuid?.() || (st.mode & 0o777) !== 0o600 || await realpath(path) !== path) throw Error("CANDIDATE_STATE_FILE_UNSAFE");
}
/** Create-only run directory and append-only stage files. No cache is trusted as validation. */
export async function openCandidateRecord(policy: CandidatePolicy, workspace: string, tasks: readonly unknown[]) {
  const root = resolve(policy.stateDirectory);
  const within = relative(await realpath(workspace), root);
  if (within !== ".." && !within.startsWith(".." + sep) && !isAbsolute(within)) throw Error("CANDIDATE_STATE_INSIDE_WORKSPACE");
  const st = await lstat(root);
  if (!st.isDirectory() || st.isSymbolicLink() || await realpath(root) !== root || (st.mode & 0o777) !== 0o700 || st.uid !== process.getuid?.()) throw Error("CANDIDATE_STATE_UNSAFE");
  const policyHash = sha(policy), tupleHash = sha({ binding: candidateBinding(policy), policyHash, orderedTasks: tasks.map(sha) });
  // A batch ID is one-shot even when another caller proposes a different task tuple.
  // This claim is retained after failure; no PID/timeout guess steals persistent state ownership.
  const batchDirectory = join(root, "batch-" + policy.batchId);
  try { await mkdir(batchDirectory, { mode: 0o700 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") throw Error("CANDIDATE_BATCH_ALREADY_CLAIMED"); throw error; }
  const batchIdentity = await lstat(batchDirectory);
  const batchRoot = await open(root, "r"); try { await batchRoot.sync(); } finally { await batchRoot.close(); }
  const directory = join(root, tupleHash);
  await mkdir(directory, { mode: 0o700 }); // Existing run, including a failed run, is never silently resumed.
  const directoryIdentity = await lstat(directory);
  const syncRoot = await open(root, "r"); try { await syncRoot.sync(); } finally { await syncRoot.close(); }
  const identity = async () => {
    const current = await lstat(directory), currentRoot = await lstat(root), currentBatch = await lstat(batchDirectory);
    if (currentBatch.isSymbolicLink() || !currentBatch.isDirectory() || currentBatch.dev !== batchIdentity.dev || currentBatch.ino !== batchIdentity.ino || (currentBatch.mode & 0o777) !== 0o700 || currentBatch.uid !== st.uid || await realpath(batchDirectory) !== batchDirectory) throw Error("CANDIDATE_BATCH_CLAIM_CHANGED");
    if (current.isSymbolicLink() || current.dev !== directoryIdentity.dev || current.ino !== directoryIdentity.ino || (current.mode & 0o777) !== 0o700 || current.uid !== st.uid || currentRoot.dev !== st.dev || currentRoot.ino !== st.ino || currentRoot.isSymbolicLink() || (currentRoot.mode & 0o777) !== 0o700 || currentRoot.uid !== st.uid || await realpath(root) !== root || await realpath(directory) !== directory) throw Error("CANDIDATE_STATE_CHANGED");
  };
  let sequence = 0;
  const record = async (stage: string, details: Record<string, unknown> = {}) => {
    if (!["local_validation_pending", "candidate_commit", "local_validation_failed", "candidate_frozen", "prepush_verified", "final_verified", "final_preflight_ready", "final_preflight_failed"].includes(stage)) throw Error("CANDIDATE_STAGE_INVALID");
    await identity();
    const file = await open(join(directory, String(++sequence).padStart(4, "0") + ".json"), "wx", 0o600);
    try { await file.writeFile(JSON.stringify({ ...details, schemaVersion: 1, tupleHash, policyHash, stage, accepted: false, remoteCI: "pending" }) + "\n"); await file.sync(); } finally { await file.close(); }
    const dir = await open(directory, "r"); try { await dir.sync(); } finally { await dir.close(); }
    await identity();
  };
  await record("local_validation_pending");
  return { directory, tupleHash, policyHash, record };
}
