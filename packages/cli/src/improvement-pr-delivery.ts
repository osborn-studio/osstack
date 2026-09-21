import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildAgentChildEnv } from "@osstack/agents";
import { ImprovementPrTarget, type ImprovementPrDeliveryRepository, type ImprovementExecutionView } from "@osstack/core";
import { githubDeliveryEnvironment } from "@osstack/github";
import { z } from "zod";
import { assertImprovementTreeUnchanged, validateImprovementPaths } from "./improvement-candidate-artifacts.js";

const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const Sha = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
const Hash = z.string().regex(/^[a-f0-9]{64}$/);
export interface ImprovementPrTransport {
  run(binary: "git" | "gh", args: string[], cwd: string, timeoutMs?: number): Promise<Buffer>;
}
export const improvementPrTransport: ImprovementPrTransport = {
  run(binary, args, cwd, timeoutMs = 30_000) {
    return new Promise((resolve, reject) => {
      execFile(binary, args, { cwd, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, encoding: "buffer",
        env: { ...githubDeliveryEnvironment(), GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_CONFIG_SYSTEM: "/dev/null", GIT_NO_REPLACE_OBJECTS: "1", GH_HOST: "github.com" },
      }, (error, stdout) => error ? reject(new Error(`${binary} command failed (result may be uncertain)`)) : resolve(stdout));
    });
  },
};
const gitOptions = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "core.attributesFile=/dev/null",
  "-c", "commit.gpgSign=false", "-c", "protocol.ext.allow=never", "-c", "credential.helper=",
  "-c", "credential.helper=!gh auth git-credential"];
const git = (transport: ImprovementPrTransport, cwd: string, args: string[]) => transport.run("git", [...gitOptions, ...args], cwd, 120_000);
const api = async (transport: ImprovementPrTransport, cwd: string, endpoint: string, extra: string[] = []) =>
  JSON.parse((await transport.run("gh", ["api", "--hostname", "github.com", endpoint, ...extra], cwd)).toString("utf8")) as unknown;
const Repo = z.object({ id: z.number().int().positive(), full_name: z.string(), default_branch: z.string(), archived: z.boolean(), permissions: z.object({ push: z.boolean() }) });

export async function prepareImprovementPrTarget(
  input: { repoPath: string; baseSha: string; executionId: string; title: string; base?: string },
  transport: ImprovementPrTransport = improvementPrTransport,
): Promise<ImprovementPrTarget> {
  const remote = (await git(transport, input.repoPath, ["remote", "get-url", "origin"])).toString().trim();
  const name = /^(?:https:\/\/github\.com\/|git@github\.com:)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(remote)?.[1];
  if (!name) throw new Error("PR delivery requires an origin on github.com using HTTPS or git@github.com");
  const repo = Repo.parse(await api(transport, input.repoPath, `repos/${name}`));
  if (repo.archived || !repo.permissions.push) throw new Error("Repository must be writable and not archived");
  const target = ImprovementPrTarget.parse({ repository_id: repo.id, repository: repo.full_name,
    base: input.base ?? repo.default_branch, branch: `codex/improve-pr-${sha256(`${repo.id}:${input.executionId}`).slice(0, 24)}`,
    title: input.title, draft: true,
  });
  await git(transport, input.repoPath, ["check-ref-format", `refs/heads/${target.base}`]);
  await assertTarget(transport, input.repoPath, target, input.baseSha);
  return target;
}

async function assertTarget(transport: ImprovementPrTransport, cwd: string, target: ImprovementPrTarget, baseSha?: string) {
  const repo = Repo.parse(await api(transport, cwd, `repos/${target.repository}`));
  if (repo.id !== target.repository_id || repo.full_name !== target.repository || repo.archived || !repo.permissions.push) {
    throw new Error("GitHub repository identity or write authorization changed");
  }
  if (baseSha !== undefined) {
    const ref = z.object({ object: z.object({ sha: Sha }) }).parse(await api(transport, cwd, `repos/${target.repository}/git/ref/heads/${target.base}`));
    if (ref.object.sha !== baseSha) throw new Error("GitHub base moved; a new preview is required, no automatic rebase");
  }
}

const Candidate = z.object({ base_sha: Sha, head_sha: Sha, patch: z.string(), patch_sha256: Hash,
  changed_paths: z.array(z.string()).min(1), files: z.array(z.object({ path: z.string(), sha256: Hash.nullable() })) });
const Result = z.object({ request_sha256: Hash, candidate_patch_sha256: Hash, base_sha: Sha,
  evidence_directory: z.string(), artifacts: z.array(z.object({ name: z.string(), sha256: Hash })) });

async function readArtifact(directory: string, name: string, expectedHash: string): Promise<Buffer> {
  const path = join(directory, name);
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024 * 1024) throw new Error("Invalid candidate artifact file");
  const bytes = await readFile(path);
  if (sha256(bytes) !== expectedHash) throw new Error(`Candidate ${name} digest changed`);
  return bytes;
}

/** Run only explicitly previewed local verification, without ambient GitHub/env authority. */
async function verifyRebuilt(command: string, cwd: string, home: string, timeout: number, environment?: unknown): Promise<void> {
  const preparedEnv = environment === undefined ? undefined
    : (await import("./improvement-environment.js")).improvementVerificationEnvironment(home, environment);
  await new Promise<void>((resolve, reject) => {
    execFile("/bin/sh", ["-c", command], { cwd, timeout, maxBuffer: 4 * 1024 * 1024,
      env: preparedEnv ?? buildAgentChildEnv({ HOME: home, OSSTACK_HOME: home, OSSTACK_AUTOAPPROVE: "0",
        GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" }),
    }, (error) => error ? reject(new Error("Clean reconstruction verification failed or was interrupted")) : resolve());
  });
}

export async function deliverImprovementPr(
  execution: ImprovementExecutionView, ledger: ImprovementPrDeliveryRepository,
  transport: ImprovementPrTransport = improvementPrTransport,
): Promise<void> {
  const id = execution.execution_id;
  const worker = execution.worker;
  if (!worker) throw new Error("PR delivery requires a bound worker");
  if (!ledger.begin(id, worker, Date.now() / 1000)) return;
  try {
    const result = Result.parse(execution.result);
    if (result.request_sha256 !== execution.request_sha256 || result.base_sha !== execution.request.base_sha) throw new Error("Candidate request binding changed");
    const entry = result.artifacts.filter((item) => item.name === "candidate.json");
    if (entry.length !== 1) throw new Error("Exactly one candidate artifact is required");
    const candidate = Candidate.parse(JSON.parse((await readArtifact(result.evidence_directory, "candidate.json", entry[0]!.sha256)).toString("utf8")));
    const patch = await readArtifact(result.evidence_directory, "candidate.patch", result.candidate_patch_sha256);
    if (candidate.patch_sha256 !== result.candidate_patch_sha256 || candidate.patch !== patch.toString("utf8")
      || candidate.base_sha !== result.base_sha || candidate.head_sha !== result.base_sha) throw new Error("Patch binding mismatch");
    const allowed = validateImprovementPaths(z.array(z.string()).parse(execution.request.allowed_paths));
    const changed = validateImprovementPaths(candidate.changed_paths);
    if (changed.length !== candidate.changed_paths.length || changed.some((path) => !allowed.includes(path))) throw new Error("Candidate paths exceed authorization");
    const target = ledger.get(id)!.target;
    const directory = await mkdtemp(join(tmpdir(), "osstack-pr-rebuild-"));
    const bare = join(directory, "objects.git");
    const workspace = join(directory, "verify");
    const home = join(directory, "home");
    ledger.recordWorkspace(id, worker, directory, Date.now() / 1000);
    await mkdir(home, { mode: 0o700 });
    await git(transport, directory, ["init", "--bare", bare]);
    await assertTarget(transport, bare, target, result.base_sha);
    const url = `https://github.com/${target.repository}.git`;
    await git(transport, bare, ["fetch", "--no-tags", "--depth=1", url, `refs/heads/${target.base}`]);
    if ((await git(transport, bare, ["rev-parse", "FETCH_HEAD"])).toString().trim() !== result.base_sha) throw new Error("Fetched base differs from authorization");
    await git(transport, bare, ["read-tree", result.base_sha]);
    const patchFile = join(directory, "candidate.patch");
    await writeFile(patchFile, patch, { mode: 0o600, flag: "wx" });
    await git(transport, bare, ["apply", "--cached", "--binary", "--whitespace=nowarn", patchFile]);
    const tree = Sha.parse((await git(transport, bare, ["write-tree"])).toString().trim());
    const actualPaths = (await git(transport, bare, ["diff-tree", "--no-commit-id", "--name-only", "--no-renames", "-r", "-z", result.base_sha, tree])).toString().split("\0").filter(Boolean).sort();
    if (JSON.stringify(actualPaths) !== JSON.stringify(changed) || candidate.files.length !== changed.length) throw new Error("Rebuilt tree paths differ from reviewed candidate");
    for (const path of changed) {
      const files = candidate.files.filter((file) => file.path === path);
      if (files.length !== 1) throw new Error("Ambiguous candidate file binding");
      const entryText = (await git(transport, bare, ["ls-tree", "-z", tree, "--", path])).toString();
      if (files[0]!.sha256 === null) { if (entryText !== "") throw new Error("Deleted candidate file reappeared"); continue; }
      const match = /^(100644|100755) blob ([a-f0-9]+)\t[^\0]+\0$/.exec(entryText);
      if (!match || sha256(await git(transport, bare, ["cat-file", "blob", match[2]!])) !== files[0]!.sha256) throw new Error("Rebuilt file content or mode is invalid");
    }
    const messageFile = join(directory, "commit-message.txt");
    await writeFile(messageFile, `${target.title}\n\nOSStack execution: ${id}\nRequest: ${execution.request_sha256}\n`, { mode: 0o600 });
    const commit = Sha.parse((await git(transport, bare, ["-c", "user.name=OSStack", "-c", "user.email=osstack@users.noreply.github.com",
      "commit-tree", tree, "-p", result.base_sha, "-F", messageFile])).toString().trim());
    await git(transport, bare, ["worktree", "add", "--detach", workspace, commit]);
    if (execution.request.environment !== undefined) {
      const { ImprovementEnvironment, prepareImprovementEnvironment } = await import("./improvement-environment.js");
      await prepareImprovementEnvironment({ contract: ImprovementEnvironment.parse(execution.request.environment), workspace, commit,
        directory: join(directory, "dependency-environment"), timeoutMs: z.number().int().min(1000).max(600000).parse(execution.request.timeout_ms),
        checkActive: () => ledger.assertActive(id, worker) });
    }
    const commands = z.array(z.string().min(1)).min(1).parse(execution.request.verify_commands);
    const timeout = z.number().int().min(1000).max(600000).parse(execution.request.timeout_ms);
    for (const command of commands) {
      ledger.assertActive(id, worker);
      await verifyRebuilt(command, workspace, home, timeout, execution.request.environment);
    }
    await assertImprovementTreeUnchanged(workspace, commit);
    ledger.prepare(id, worker, { base_sha: result.base_sha, commit_sha: commit, tree_sha: tree, patch_sha256: result.candidate_patch_sha256 }, Date.now() / 1000);
    await assertTarget(transport, bare, target, result.base_sha);
    ledger.dispatch(id, worker, "push", Date.now() / 1000);
    // Empty expected ref means create-only, never overwrite or fast-forward an existing branch.
    await git(transport, bare, ["push", `--force-with-lease=refs/heads/${target.branch}:`, url, `${commit}:refs/heads/${target.branch}`]);
    await reconcileImprovementPr(id, ledger, bare, transport);
    if (ledger.get(id)?.state !== "pushed") throw new Error("Push not confirmed");
    await assertTarget(transport, bare, target, result.base_sha);
    const body = `Candidate for: ${target.title}\n\nExecution: ${id}\nRequest SHA-256: ${execution.request_sha256}\nPatch SHA-256: ${result.candidate_patch_sha256}\nTree: ${tree}\n\nVerified candidate only; effectiveness is not yet proven. No merge or release was requested.`;
    const payloadFile = join(directory, "pull.json");
    await writeFile(payloadFile, JSON.stringify({ title: target.title, body, head: target.branch, base: target.base, draft: true, maintainer_can_modify: false }), { mode: 0o600 });
    ledger.dispatch(id, worker, "pr", Date.now() / 1000);
    await api(transport, bare, `repos/${target.repository}/pulls`, ["--method", "POST", "--input", payloadFile]);
    await reconcileImprovementPr(id, ledger, bare, transport);
    if (ledger.get(id)?.state !== "delivered") throw new Error("Draft PR creation is not yet confirmed");
  } catch (error) {
    ledger.recordError(id, error instanceof Error ? error.message : String(error), Date.now() / 1000);
  }
}

/** Reads GitHub only. It can record an observed result, never retry a write. */
export async function reconcileImprovementPr(id: string, ledger: ImprovementPrDeliveryRepository, cwd: string, transport: ImprovementPrTransport = improvementPrTransport): Promise<void> {
  const view = ledger.get(id);
  if (!view?.commit || !["push_dispatched", "pr_dispatched"].includes(view.state)) return;
  await assertTarget(transport, cwd, view.target);
  if (view.state === "push_dispatched") {
    const ref = z.object({ object: z.object({ sha: Sha }) }).parse(await api(transport, cwd, `repos/${view.target.repository}/git/ref/heads/${view.target.branch}`));
    ledger.observePush(id, ref.object.sha, Date.now() / 1000);
    return;
  }
  const endpoint = `repos/${view.target.repository}/pulls?state=all&head=${encodeURIComponent(`${view.target.repository.split("/")[0]}:${view.target.branch}`)}&base=${encodeURIComponent(view.target.base)}&per_page=100`;
  const pulls = z.array(z.object({ number: z.number().int().positive(), html_url: z.string(), state: z.string(), draft: z.boolean(),
    head: z.object({ sha: Sha, ref: z.string(), repo: z.object({ id: z.number() }) }),
    base: z.object({ sha: Sha, ref: z.string(), repo: z.object({ id: z.number() }) }),
  })).parse(await api(transport, cwd, endpoint));
  const pr = pulls[0];
  if (pulls.length !== 1 || !pr || pr.state !== "open" || !pr.draft || pr.head.sha !== view.commit.commit_sha
    || pr.head.ref !== view.target.branch || pr.head.repo.id !== view.target.repository_id || pr.base.repo.id !== view.target.repository_id
    || pr.base.ref !== view.target.base || pr.base.sha !== view.commit.base_sha) throw new Error("Draft PR identity, head or state could not be confirmed");
  ledger.observePr(id, { number: pr.number, url: pr.html_url, head_sha: pr.head.sha }, Date.now() / 1000);
}
