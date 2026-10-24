import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { lstat, mkdir, open, readlink, realpath, link, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, relative } from "node:path";
import { promisify } from "node:util";
import { assertDeliveryContractPaths, assertFrozenDeliveryContract, deliveryCheckReference, deliveryContractDigest, verifyDeliveryContractReceipt } from "@osstack/core";
import { DeliveryVerificationReceiptV2, type DeliveryCandidateIdentityV2, type DeliveryReceiptReferenceV2, type FrozenDeliveryContractV2 } from "@osstack/protocol";
import type { CommandAudit, ReviewArtifact } from "@osstack/loop";

const exec = promisify(execFile);
export const deliveryBytesDigest = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
export async function deliveryGit(workspace: string, args: string[]): Promise<string> {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  const safeArgs = args[0] === "diff" ? ["diff", "--no-ext-diff", "--no-textconv", ...args.slice(1)] : args;
  return (await exec("git", ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...safeArgs], {
    cwd: workspace, encoding: "utf8", timeout: 30000, maxBuffer: 64 * 1024 * 1024,
    env: { ...env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" },
  })).stdout;
}
export async function captureDeliveryCandidate(workspace: string, baseHead: string): Promise<DeliveryCandidateIdentityV2> {
  const head = (await deliveryGit(workspace, ["rev-parse", "HEAD"])).trim();
  const tree = (await deliveryGit(workspace, ["write-tree"])).trim();
  const diff = await deliveryGit(workspace, ["diff", "--cached", "--binary", baseHead, "--"]);
  return { base_head: baseHead, head, tree_id: tree, diff_digest: deliveryBytesDigest(diff) };
}
export async function persistDeliveryHostRecord(root: string, value: unknown): Promise<DeliveryReceiptReferenceV2> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const canonicalRoot = await realpath(root);
  const body = `${JSON.stringify(value)}\n`;
  const digest = deliveryBytesDigest(body);
  const path = join(canonicalRoot, `${digest}.json`);
  const temporary = join(canonicalRoot, `.receipt-${randomUUID()}.tmp`);
  const file = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try {
    await file.writeFile(body); await file.sync();
    try { await link(temporary, path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      await readDeliveryHostRecord(canonicalRoot, { path, digest });
    }
    const directory = await open(canonicalRoot, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { await directory.sync(); } finally { await directory.close(); }
  } finally { await file.close(); await unlink(temporary); }
  return { path, digest };
}
export async function readDeliveryHostRecord(root: string, ref: DeliveryReceiptReferenceV2): Promise<unknown> {
  const canonicalRoot = await realpath(root);
  if (!isAbsolute(ref.path) || (await lstat(ref.path)).isSymbolicLink()) throw new Error("delivery_receipt_path_invalid");
  const canonicalPath = await realpath(ref.path);
  const local = relative(canonicalRoot, canonicalPath);
  if (local.startsWith("..") || isAbsolute(local) || !/^[a-f0-9]{64}\.json$/.test(local)
    || local !== `${ref.digest}.json`) throw new Error("delivery_receipt_path_invalid");
  const handle = await open(canonicalPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > 1024 * 1024) throw new Error("delivery_receipt_size_invalid");
    const body = Buffer.alloc(info.size + 1);
    const { bytesRead } = await handle.read(body, 0, body.length, 0);
    if (bytesRead !== info.size) throw new Error("delivery_receipt_size_changed");
    const actual = body.subarray(0, bytesRead);
    if (deliveryBytesDigest(actual) !== ref.digest) throw new Error("delivery_receipt_digest_mismatch");
    return JSON.parse(actual.toString("utf8")) as unknown;
  } finally { await handle.close(); }
}
export function buildDeliveryVerificationReceipt(input: {
  frozen: FrozenDeliveryContractV2; runId: string; runKind: "guarded-local" | "guarded-git";
  candidate: DeliveryCandidateIdentityV2; commands: readonly CommandAudit[]; reviews: readonly ReviewArtifact[];
  builderAgentId: string; builderIdentity: Record<string, unknown>; workspaceStateDigest: string; contextReceiptRefs?: readonly DeliveryReceiptReferenceV2[];
}) {
  const { contract, digest } = assertFrozenDeliveryContract(input.frozen);
  const review = input.reviews[0];
  if (!review || input.reviews.some((item) => item.verdict !== "approved") || input.builderIdentity.evidence_source !== "reported"
    || review.runtime_identity.evidence_source !== "reported") throw new Error("delivery_reported_review_missing");
  if (input.reviews.some(item => item.runtime_identity.evidence_source !== "reported"
    || item.reviewer_agent_id === input.builderAgentId
    || (item.runtime_identity.provider_id === input.builderIdentity.provider_id && item.runtime_identity.model_id === input.builderIdentity.model_id)))
    throw new Error("delivery_independent_review_required");
  const checks = input.commands.map((command, index) => {
    const registryRef = deliveryCheckReference(command.command);
    return { id: contract.required_checks.find((check) => check.registry_ref === registryRef)?.id ?? `host:${index}`,
      registry_ref: registryRef, command_digest: registryRef.slice(7), exit_code: command.exit_code, duration_ms: command.duration_ms };
  });
  return DeliveryVerificationReceiptV2.parse({ schema_version: 2, source: "osstack_loop_host", run_id: input.runId,
    task_id: contract.task_id, run_kind: input.runKind, contract_digest: digest, policy_digest: contract.policy_digest,
    candidate: input.candidate, workspace_state_digest: input.workspaceStateDigest, checks, review: { policy_ref: contract.review_policy_ref, verdict: review.verdict,
      builder_agent_id: input.builderAgentId, reviewer_agent_id: review.reviewer_agent_id,
      builder_provider: input.builderIdentity.provider_id, builder_model: input.builderIdentity.model_id,
      reviewer_provider: review.runtime_identity.provider_id, reviewer_model: review.runtime_identity.model_id,
      identity_source: "reported", artifact_digest: deliveryContractDigest(input.reviews) },
    observed_at: new Date().toISOString(), context_receipt_refs: input.contextReceiptRefs ?? [] });
}
/** Trusted host port: load its own immutable record and re-sample actual Git state.
 * A committed candidate may change HEAD, but its verified tree and base-relative diff must not change. */
export async function verifyPersistedDeliveryReceipt(input: {
  root: string; ref: DeliveryReceiptReferenceV2; frozen: FrozenDeliveryContractV2; runId: string; workspace: string; expectedHeads?: readonly string[];
}) {
  const raw = await readDeliveryHostRecord(input.root, input.ref);
  const receipt = DeliveryVerificationReceiptV2.parse(raw);
  const current = await captureDeliveryCandidate(input.workspace, input.frozen.contract.base_head);
  if (receipt.candidate.head !== input.frozen.contract.base_head
    || !(input.expectedHeads ?? [input.frozen.contract.base_head]).includes(current.head)) throw new Error("delivery_candidate_head_mismatch");
  if (current.tree_id !== receipt.candidate.tree_id || current.diff_digest !== receipt.candidate.diff_digest)
    throw new Error("delivery_candidate_changed_after_verification");
  if ((await snapshotDeliveryWorkspace(input.workspace, input.frozen.contract.base_head)).digest !== receipt.workspace_state_digest)
    throw new Error("delivery_workspace_changed_after_verification");
  // Unstaged/untracked edits were never part of the reviewed tree.
  if ((await deliveryGit(input.workspace, ["diff", "--name-only"])).trim()
    || (await deliveryGit(input.workspace, ["ls-files", "--others", "--exclude-standard"])).trim())
    throw new Error("delivery_candidate_has_unverified_changes");
  verifyDeliveryContractReceipt(input.frozen, raw, { runId: input.runId, candidate: { ...current, head: receipt.candidate.head },
    policyDigest: input.frozen.contract.policy_digest });
  return { receipt, current };
}

async function deliveryConfig(workspace: string): Promise<string> {
  const config = await deliveryGit(workspace, ["config", "--local", "--null", "--list"]);
  if (config.split("\0").some(entry => /^filter\..*\.(?:clean|smudge|process)\n/i.test(entry)))
    throw new Error("delivery_git_filter_unsupported");
  return config;
}
async function snapshotDeliveryWorkspace(workspace: string, baseHead: string, ignoredDirectories = false) {
  const canonicalWorkspace = await realpath(workspace);
  await deliveryConfig(workspace);
  const flags = (await deliveryGit(workspace, ["ls-files", "-v", "-z"])).split("\0").filter(Boolean);
  if (flags.some(entry => /^[a-zS]/.test(entry))) throw new Error("delivery_hidden_index_flags");
  const tracked = (await deliveryGit(workspace, ["diff", "--no-renames", "--name-only", "-z", baseHead, "--"])).split("\0").filter(Boolean);
  const untracked = (await deliveryGit(workspace, ["ls-files", "--others", "--exclude-standard", "-z"])).split("\0").filter(Boolean);
  const ignored = (await deliveryGit(workspace, ["ls-files", "--others", "--ignored", "--exclude-standard", ...(ignoredDirectories ? ["--directory", "--no-empty-directory"] : []), "-z"])).split("\0").filter(Boolean).sort();
  const paths = [...new Set([...tracked, ...untracked])].sort();
  const allFiles = [...new Set([...flags.map(entry => entry.slice(2)), ...paths])].sort();
  if (allFiles.length + ignored.length > 100000) throw new Error("delivery_candidate_too_many_files");
  const changes: Array<{ path: string; digest: string | null; mode: number | null }> = [];
  let bytes = 0;
  for (const path of allFiles) {
    const absolute = join(workspace, path);
    const parent = await realpath(dirname(absolute)).catch(error => { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; });
    if (parent !== undefined) { const rel = relative(canonicalWorkspace, parent); if (rel === ".." || rel.startsWith("../") || isAbsolute(rel)) throw new Error("delivery_candidate_parent_escape"); }
    const info = await lstat(absolute).catch(error => { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; });
    if (!info) { changes.push({ path, digest: null, mode: null }); continue; }
    if (!info.isFile() && !info.isSymbolicLink()) throw new Error("delivery_candidate_file_invalid");
    bytes += info.size;
    if (bytes > 64 * 1024 * 1024) throw new Error("delivery_candidate_too_large");
    let body: string | Buffer;
    if (info.isSymbolicLink()) body = await readlink(absolute);
    else {
      const file = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const opened = await file.stat();
        if (!opened.isFile() || opened.size !== info.size) throw new Error("delivery_candidate_file_changed");
        body = Buffer.alloc(info.size + 1);
        const { bytesRead } = await file.read(body, 0, body.length, 0);
        if (bytesRead !== info.size) throw new Error("delivery_candidate_file_changed");
        body = body.subarray(0, bytesRead);
      } finally { await file.close(); }
    }
    changes.push({ path, digest: deliveryBytesDigest(body), mode: info.isSymbolicLink() ? 0o120000 : info.mode & 0o111 ? 0o100755 : 0o100644 });
  }
  return { digest: deliveryContractDigest({ baseHead, changes, ignored }), paths, ignored };
}
/** One invocation owns its pre-build baseline and exact check/review snapshot.
 * The same snapshot must survive staging and receipt capture; it is not re-baselined. */
export function createDeliveryVerificationFence(frozen: FrozenDeliveryContractV2) {
  const baselines = new Map<string, { ignored: Set<string>; config: string }>();
  const verified = new Map<string, string>();
  const sample = async (workspace: string) => {
    const baseline = baselines.get(workspace);
    if (!baseline) throw new Error("delivery_verification_baseline_missing");
    if ((await deliveryGit(workspace, ["rev-parse", "HEAD"])).trim() !== frozen.contract.base_head)
      throw new Error("delivery_candidate_base_changed");
    if (await deliveryConfig(workspace) !== baseline.config) throw new Error("delivery_git_config_changed");
    const snapshot = await snapshotDeliveryWorkspace(workspace, frozen.contract.base_head);
    if (snapshot.ignored.some(path => !baseline.ignored.has(path))) throw new Error("delivery_new_ignored_file");
    assertDeliveryContractPaths(frozen, snapshot.paths);
    return snapshot.digest;
  };
  const fence = async (workspace: string): Promise<() => Promise<void>> => {
    verified.delete(workspace);
    const before = await sample(workspace);
    return async () => {
      if (await sample(workspace) !== before) throw new Error("delivery_candidate_changed_during_verification");
      verified.set(workspace, before);
    };
  };
  return Object.assign(fence, {
    prepare: async (workspace: string) => {
      const snapshot = await snapshotDeliveryWorkspace(workspace, frozen.contract.base_head);
      baselines.set(workspace, { ignored: new Set(snapshot.ignored), config: await deliveryConfig(workspace) });
      verified.delete(workspace);
    },
    assertVerified: async (workspace: string) => {
      const digest = verified.get(workspace);
      if (!digest || await sample(workspace) !== digest) throw new Error("delivery_reviewed_candidate_changed");
      return digest;
    },
  });
}

/** Detect changes to the original checkout; this is not a filesystem sandbox.
 * Existing ignored file contents and arbitrary paths outside the checkout are not sampled.
 */
export async function createDeliverySourceFence(workspace: string, baseHead: string): Promise<() => Promise<void>> {
  const sample = async () => {
    const [head, index, snapshot] = await Promise.all([
      deliveryGit(workspace, ["rev-parse", "HEAD"]),
      deliveryGit(workspace, ["ls-files", "--stage", "-z"]),
      snapshotDeliveryWorkspace(workspace, baseHead, true),
    ]);
    return deliveryContractDigest({ head, index, snapshot: snapshot.digest });
  };
  const baseline = await sample();
  return async () => { if (await sample() !== baseline) throw new Error("delivery_source_changed"); };
}
