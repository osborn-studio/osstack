import { createHash, randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  unlink,
} from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import {
  KnowledgeHygieneTransactionPlanV1,
  KnowledgeHygieneTransactionReceiptV1,
  type KnowledgeHygieneTransactionPlanV1 as TransactionPlan,
} from "./transaction-plan.js";

const sha256 = z.string().regex(/^[a-f0-9]{64}$/);

const journalEntry = z.object({
  root_id: z.enum(["repo", "memory"]),
  path: z.string().min(1),
  target: z.string().min(1),
  before_exists: z.boolean(),
  before_sha256: sha256.nullable(),
  after_sha256: sha256,
  backup_path: z.string().min(1).nullable(),
  mode: z.number().int().min(0).max(0o777),
  applied: z.boolean(),
  recovered: z.boolean(),
}).strict();

const recoveryJournal = z.object({
  schema_version: z.literal("1"),
  plan_id: z.string().regex(/^khtp_[a-f0-9]{64}$/),
  revision: z.number().int().positive(),
  manifest_sha256: sha256,
  state: z.enum(["prepared", "recovery_required", "applied", "recovered"]),
  entries: z.array(journalEntry).min(1),
  updated_at: z.string().datetime(),
}).strict();
type RecoveryJournal = z.infer<typeof recoveryJournal>;

export class KnowledgeHygieneTransactionErrorV1 extends Error {
  readonly code:
    | "conflict"
    | "stale"
    | "recovery_required"
    | "apply_failed_recovered";

  constructor(
    code: KnowledgeHygieneTransactionErrorV1["code"],
    message: string,
  ) {
    super(message);
    this.name = "KnowledgeHygieneTransactionErrorV1";
    this.code = code;
  }
}

export class KnowledgeHygieneSimulatedCrashV1 extends Error {
  constructor() {
    super("simulated process termination");
    this.name = "KnowledgeHygieneSimulatedCrashV1";
  }
}

export interface KnowledgeHygieneTransactionApplyHooksV1 {
  before_backup?: (index: number) => void | Promise<void>;
  after_write?: (index: number) => void | Promise<void>;
  after_restore?: (index: number) => void | Promise<void>;
}

export interface KnowledgeHygieneTransactionApplyOptionsV1 {
  state_root: string;
  execute: boolean;
  now?: () => Date;
  hooks?: KnowledgeHygieneTransactionApplyHooksV1;
  evaluation_only?: boolean;
}

export interface KnowledgeHygieneTransactionRecoverOptionsV1 {
  state_root: string;
  now?: () => Date;
  hooks?: KnowledgeHygieneTransactionApplyHooksV1;
  evaluation_only?: boolean;
  allow_applied?: boolean;
}

export interface KnowledgeHygieneTransactionOperationResultV1 {
  plan: TransactionPlan;
  receipt: z.infer<typeof KnowledgeHygieneTransactionReceiptV1>;
}

interface InspectedFile {
  exists: boolean;
  content: Buffer | null;
  sha256: string | null;
  mode: number;
}

function digest(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  return typeof error.code === "string" ? error.code : undefined;
}

function inside(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate);
  return fromRoot === "" || (
    fromRoot !== ".."
    && !fromRoot.startsWith(`..${sep}`)
    && !isAbsolute(fromRoot)
  );
}

async function privateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function atomicPrivateJson(path: string, value: unknown): Promise<void> {
  await privateDirectory(dirname(path));
  const temp = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  const handle = await open(
    temp,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temp, path);
    await syncDirectory(dirname(path));
  } catch (error) {
    await unlink(temp).catch(() => undefined);
    throw error;
  }
}

async function safeTarget(root: string, path: string): Promise<string> {
  const lexical = resolve(root, path);
  if (!inside(root, lexical)) {
    throw new KnowledgeHygieneTransactionErrorV1(
      "conflict",
      `transaction path escapes its allowlisted root: ${path}`,
    );
  }
  const parent = await realpath(dirname(lexical)).catch((error) => {
    throw new KnowledgeHygieneTransactionErrorV1(
      "conflict",
      `transaction target parent is unavailable: ${path}: ${String(error)}`,
    );
  });
  if (!inside(root, parent)) {
    throw new KnowledgeHygieneTransactionErrorV1(
      "conflict",
      `transaction target parent escapes its allowlisted root: ${path}`,
    );
  }
  return join(parent, basename(lexical));
}

function safeMode(metadata: Stats, path: string): number {
  if (!metadata.isFile()) {
    throw new KnowledgeHygieneTransactionErrorV1(
      "conflict",
      `transaction target is not a regular file: ${path}`,
    );
  }
  if (metadata.nlink !== 1) {
    throw new KnowledgeHygieneTransactionErrorV1(
      "conflict",
      `transaction target has an unsafe hard-link count: ${path}`,
    );
  }
  return metadata.mode & 0o777;
}

async function inspect(path: string): Promise<InspectedFile> {
  let metadata: Stats;
  try {
    metadata = await lstat(path);
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return { exists: false, content: null, sha256: null, mode: 0o644 };
    }
    throw error;
  }
  const mode = safeMode(metadata, path);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const content = await handle.readFile();
    return { exists: true, content, sha256: digest(content), mode };
  } finally {
    await handle.close();
  }
}

function assertPreimage(
  actual: InspectedFile,
  expected: string | null,
  path: string,
): void {
  if (
    (expected === null && actual.exists)
    || (expected !== null && (!actual.exists || actual.sha256 !== expected))
  ) {
    throw new KnowledgeHygieneTransactionErrorV1(
      "stale",
      `transaction preimage changed: ${path}`,
    );
  }
}

async function atomicReplace(
  target: string,
  content: string | Buffer,
  mode: number,
): Promise<void> {
  const temp = join(dirname(target), `.${basename(target)}.${randomUUID()}.tmp`);
  const handle = await open(
    temp,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    mode,
  );
  try {
    await handle.writeFile(content);
    await handle.chmod(mode);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temp, target);
    await syncDirectory(dirname(target));
  } catch (error) {
    await unlink(temp).catch(() => undefined);
    throw error;
  }
}

function manifestSha(plan: TransactionPlan): string {
  return digest(JSON.stringify({
    plan_id: plan.plan_id,
    revision: plan.revision,
    write_set: plan.write_set,
  }));
}

function receipt(
  plan: TransactionPlan,
  kind: "dry_run" | "apply" | "recovery",
  status: "verified" | "applied" | "already_applied" | "recovered",
  at: string,
  evaluationOnly: boolean | undefined,
) {
  const body = {
    kind,
    revision: plan.revision,
    status,
    manifest_sha256: manifestSha(plan),
    paths: plan.write_set.map((entry) => `${entry.root_id}:${entry.path}`),
    occurred_at: at,
    ...(evaluationOnly === undefined ? {} : { evaluation_only: evaluationOnly }),
  };
  return KnowledgeHygieneTransactionReceiptV1.parse({
    ...body,
    receipt_id: `khtr_${digest(JSON.stringify([plan.plan_id, body]))}`,
  });
}

function withReceipt(
  plan: TransactionPlan,
  value: z.infer<typeof KnowledgeHygieneTransactionReceiptV1>,
  state: TransactionPlan["state"],
): TransactionPlan {
  const receipts = plan.receipts.some((item) => item.receipt_id === value.receipt_id)
    ? plan.receipts
    : [...plan.receipts, value];
  return KnowledgeHygieneTransactionPlanV1.parse({ ...plan, state, receipts });
}

function journalPath(stateRoot: string, planId: string): string {
  return join(stateRoot, "backups", planId, "recovery.json");
}

async function loadJournal(
  stateRoot: string,
  plan: TransactionPlan,
): Promise<RecoveryJournal | undefined> {
  const path = journalPath(stateRoot, plan.plan_id);
  let handle: FileHandle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    throw error;
  }
  try {
    const parsed = recoveryJournal.parse(JSON.parse(await handle.readFile("utf8")));
    if (
      parsed.plan_id !== plan.plan_id
      || parsed.revision !== plan.revision
      || parsed.manifest_sha256 !== manifestSha(plan)
    ) {
      throw new KnowledgeHygieneTransactionErrorV1(
        "conflict",
        "recovery journal does not match the plan revision",
      );
    }
    return parsed;
  } finally {
    await handle.close();
  }
}

async function writeJournal(
  stateRoot: string,
  journal: RecoveryJournal,
): Promise<void> {
  await atomicPrivateJson(journalPath(stateRoot, journal.plan_id), journal);
}

async function resolvedRoots(plan: TransactionPlan): Promise<{
  repo: string;
  memory?: string;
}> {
  const repo = await realpath(plan.repo.root_realpath);
  if (repo !== plan.repo.root_realpath) {
    throw new KnowledgeHygieneTransactionErrorV1(
      "stale",
      "repository root realpath changed",
    );
  }
  if (plan.memory_root === undefined) return { repo };
  const memory = await realpath(plan.memory_root.root_realpath);
  if (memory !== plan.memory_root.root_realpath) {
    throw new KnowledgeHygieneTransactionErrorV1(
      "stale",
      "memory root realpath changed",
    );
  }
  return { repo, memory };
}

async function targetsFor(plan: TransactionPlan): Promise<Array<{
  target: string;
  before: InspectedFile;
}>> {
  const roots = await resolvedRoots(plan);
  const results = [];
  for (const entry of plan.write_set) {
    const root = entry.root_id === "repo" ? roots.repo : roots.memory;
    if (root === undefined) {
      throw new KnowledgeHygieneTransactionErrorV1(
        "conflict",
        "plan references memory without an approved memory root",
      );
    }
    const target = await safeTarget(root, entry.path);
    const before = await inspect(target);
    assertPreimage(before, entry.preimage_sha256, `${entry.root_id}:${entry.path}`);
    if (before.exists && before.mode !== entry.mode) {
      throw new KnowledgeHygieneTransactionErrorV1(
        "stale",
        `transaction file mode changed: ${entry.root_id}:${entry.path}`,
      );
    }
    results.push({ target, before });
  }
  return results;
}

async function writeBackup(
  path: string,
  content: Buffer,
): Promise<void> {
  await privateDirectory(dirname(path));
  try {
    const handle = await open(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await handle.writeFile(content);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await syncDirectory(dirname(path));
  } catch (error) {
    if (errorCode(error) !== "EEXIST") throw error;
    const existing = await inspect(path);
    if (existing.sha256 !== digest(content)) {
      throw new KnowledgeHygieneTransactionErrorV1(
        "conflict",
        `backup collision: ${path}`,
      );
    }
  }
}

async function createJournal(
  plan: TransactionPlan,
  stateRoot: string,
  targets: Awaited<ReturnType<typeof targetsFor>>,
  now: () => Date,
  hooks: KnowledgeHygieneTransactionApplyHooksV1,
): Promise<RecoveryJournal> {
  const backupRoot = join(stateRoot, "backups", plan.plan_id);
  await privateDirectory(backupRoot);
  const entries: RecoveryJournal["entries"] = [];
  for (const [index, entry] of plan.write_set.entries()) {
    await hooks.before_backup?.(index);
    const before = targets[index]!.before;
    const backupPath = before.exists
      ? join(backupRoot, `${String(index).padStart(4, "0")}-${before.sha256}.bak`)
      : null;
    if (before.exists && before.content !== null && backupPath !== null) {
      await writeBackup(backupPath, before.content);
    }
    entries.push({
      root_id: entry.root_id,
      path: entry.path,
      target: targets[index]!.target,
      before_exists: before.exists,
      before_sha256: before.sha256,
      after_sha256: entry.after_sha256,
      backup_path: backupPath,
      mode: entry.mode,
      applied: false,
      recovered: false,
    });
  }
  const journal = recoveryJournal.parse({
    schema_version: "1",
    plan_id: plan.plan_id,
    revision: plan.revision,
    manifest_sha256: manifestSha(plan),
    state: "prepared",
    entries,
    updated_at: now().toISOString(),
  });
  await writeJournal(stateRoot, journal);
  return journal;
}

async function withPlanLock<T>(
  stateRoot: string,
  planIdValue: string,
  operation: () => Promise<T>,
): Promise<T> {
  const lockRoot = join(stateRoot, "locks");
  await privateDirectory(lockRoot);
  const lockPath = join(lockRoot, `${planIdValue}.lock`);
  const acquire = async () => open(
    lockPath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  let handle: FileHandle;
  try {
    handle = await acquire();
  } catch (error) {
    if (errorCode(error) !== "EEXIST") throw error;
    const metadata = await lstat(lockPath);
    if (!metadata.isFile() || metadata.nlink !== 1) {
      throw new KnowledgeHygieneTransactionErrorV1(
        "conflict",
        `transaction lock is unsafe: ${planIdValue}`,
      );
    }
    const rawPid = await readFile(lockPath, "utf8");
    const pid = Number.parseInt(rawPid.trim(), 10);
    let alive = Number.isSafeInteger(pid) && pid > 0;
    if (alive) {
      try {
        process.kill(pid, 0);
      } catch (signalError) {
        if (errorCode(signalError) === "ESRCH") alive = false;
      }
    }
    if (alive) {
      throw new KnowledgeHygieneTransactionErrorV1(
        "conflict",
        `transaction plan is already locked: ${planIdValue}`,
      );
    }
    await unlink(lockPath);
    handle = await acquire();
  }
  try {
    await handle.writeFile(`${process.pid}\n`, "utf8");
    await handle.sync();
    return await operation();
  } finally {
    await handle.close();
    await unlink(lockPath).catch(() => undefined);
  }
}

async function assertAfterImages(plan: TransactionPlan): Promise<void> {
  const roots = await resolvedRoots(plan);
  for (const entry of plan.write_set) {
    const root = entry.root_id === "repo" ? roots.repo : roots.memory;
    if (root === undefined) throw new Error("memory root unavailable");
    const target = await safeTarget(root, entry.path);
    const current = await inspect(target);
    if (!current.exists || current.sha256 !== entry.after_sha256) {
      throw new KnowledgeHygieneTransactionErrorV1(
        "conflict",
        `applied transaction after-image changed: ${entry.root_id}:${entry.path}`,
      );
    }
  }
}

async function recoverJournal(
  plan: TransactionPlan,
  stateRoot: string,
  journal: RecoveryJournal,
  now: () => Date,
  hooks: KnowledgeHygieneTransactionApplyHooksV1,
): Promise<RecoveryJournal> {
  const roots = await resolvedRoots(plan);
  const entries = [...journal.entries];
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]!;
    if (!entry.applied || entry.recovered) continue;
    const root = entry.root_id === "repo" ? roots.repo : roots.memory;
    if (root === undefined) throw new Error("memory root unavailable during recovery");
    const expectedTarget = await safeTarget(root, entry.path);
    if (expectedTarget !== entry.target) {
      throw new KnowledgeHygieneTransactionErrorV1(
        "conflict",
        `recovery target changed: ${entry.root_id}:${entry.path}`,
      );
    }
    const current = await inspect(entry.target);
    if (entry.before_exists && current.sha256 === entry.before_sha256) {
      entries[index] = { ...entry, recovered: true };
    } else if (!entry.before_exists && !current.exists) {
      entries[index] = { ...entry, recovered: true };
    } else {
      if (!current.exists || current.sha256 !== entry.after_sha256) {
        throw new KnowledgeHygieneTransactionErrorV1(
          "conflict",
          `recovery after-image changed: ${entry.root_id}:${entry.path}`,
        );
      }
      if (entry.before_exists) {
        if (entry.backup_path === null || entry.before_sha256 === null) {
          throw new Error("recovery journal is missing a required backup");
        }
        const backup = await readFile(entry.backup_path);
        if (digest(backup) !== entry.before_sha256) {
          throw new KnowledgeHygieneTransactionErrorV1(
            "conflict",
            `recovery backup changed: ${entry.root_id}:${entry.path}`,
          );
        }
        await atomicReplace(entry.target, backup, entry.mode);
      } else {
        await unlink(entry.target);
        await syncDirectory(dirname(entry.target));
      }
      await hooks.after_restore?.(index);
      entries[index] = { ...entry, recovered: true };
    }
    journal = recoveryJournal.parse({
      ...journal,
      state: "recovery_required",
      entries,
      updated_at: now().toISOString(),
    });
    await writeJournal(stateRoot, journal);
  }
  journal = recoveryJournal.parse({
    ...journal,
    state: "recovered",
    entries,
    updated_at: now().toISOString(),
  });
  await writeJournal(stateRoot, journal);
  return journal;
}

export async function applyKnowledgeHygieneTransactionPlanV1(
  rawPlan: TransactionPlan,
  options: KnowledgeHygieneTransactionApplyOptionsV1,
): Promise<KnowledgeHygieneTransactionOperationResultV1> {
  const plan = KnowledgeHygieneTransactionPlanV1.parse(rawPlan);
  const now = options.now ?? (() => new Date());
  const at = now().toISOString();
  if (Date.parse(at) >= Date.parse(plan.expires_at) && plan.state !== "applied") {
    throw new KnowledgeHygieneTransactionErrorV1("stale", "transaction plan is expired");
  }
  if (!options.execute) {
    if (plan.state !== "approved") {
      throw new KnowledgeHygieneTransactionErrorV1(
        "conflict",
        `dry-run requires an approved plan, received ${plan.state}`,
      );
    }
    await targetsFor(plan);
    const verified = receipt(
      plan,
      "dry_run",
      "verified",
      at,
      options.evaluation_only,
    );
    return { plan: withReceipt(plan, verified, "approved"), receipt: verified };
  }
  if (plan.state !== "approved" && plan.state !== "applied") {
    throw new KnowledgeHygieneTransactionErrorV1(
      "conflict",
      `execute requires an approved plan, received ${plan.state}`,
    );
  }
  return withPlanLock(options.state_root, plan.plan_id, async () => {
    const existing = await loadJournal(options.state_root, plan);
    if (existing?.state === "recovery_required" || existing?.state === "prepared") {
      throw new KnowledgeHygieneTransactionErrorV1(
        "recovery_required",
        "transaction has an incomplete journal; recover before applying",
      );
    }
    if (existing?.state === "applied") {
      await assertAfterImages(plan);
      const replayed = receipt(
        plan,
        "apply",
        "already_applied",
        at,
        options.evaluation_only,
      );
      return { plan: withReceipt(plan, replayed, "applied"), receipt: replayed };
    }
    const targets = await targetsFor(plan);
    let journal = await createJournal(
      plan,
      options.state_root,
      targets,
      now,
      options.hooks ?? {},
    );
    try {
      for (const [index, entry] of plan.write_set.entries()) {
        const target = targets[index]!.target;
        const current = await inspect(target);
        assertPreimage(current, entry.preimage_sha256, `${entry.root_id}:${entry.path}`);
        await atomicReplace(target, entry.after_utf8, entry.mode);
        const after = await inspect(target);
        if (!after.exists || after.sha256 !== entry.after_sha256) {
          throw new Error(`transaction after-image verification failed: ${entry.path}`);
        }
        journal.entries[index] = { ...journal.entries[index]!, applied: true };
        journal = recoveryJournal.parse({
          ...journal,
          state: "recovery_required",
          updated_at: now().toISOString(),
        });
        await writeJournal(options.state_root, journal);
        await options.hooks?.after_write?.(index);
      }
      journal = recoveryJournal.parse({
        ...journal,
        state: "applied",
        updated_at: now().toISOString(),
      });
      await writeJournal(options.state_root, journal);
    } catch (error) {
      journal = recoveryJournal.parse({
        ...journal,
        state: "recovery_required",
        updated_at: now().toISOString(),
      });
      await writeJournal(options.state_root, journal);
      if (error instanceof KnowledgeHygieneSimulatedCrashV1) throw error;
      try {
        await recoverJournal(
          plan,
          options.state_root,
          journal,
          now,
          options.hooks ?? {},
        );
      } catch (recoveryError) {
        throw new KnowledgeHygieneTransactionErrorV1(
          "recovery_required",
          `transaction failed and recovery is incomplete: ${String(recoveryError)}`,
        );
      }
      throw new KnowledgeHygieneTransactionErrorV1(
        "apply_failed_recovered",
        `transaction failed and was recovered: ${String(error)}`,
      );
    }
    const applied = receipt(
      plan,
      "apply",
      "applied",
      at,
      options.evaluation_only,
    );
    return { plan: withReceipt(plan, applied, "applied"), receipt: applied };
  });
}

export async function recoverKnowledgeHygieneTransactionPlanV1(
  rawPlan: TransactionPlan,
  options: KnowledgeHygieneTransactionRecoverOptionsV1,
): Promise<KnowledgeHygieneTransactionOperationResultV1> {
  const plan = KnowledgeHygieneTransactionPlanV1.parse(rawPlan);
  const now = options.now ?? (() => new Date());
  return withPlanLock(options.state_root, plan.plan_id, async () => {
    const journal = await loadJournal(options.state_root, plan);
    if (journal === undefined) {
      throw new KnowledgeHygieneTransactionErrorV1(
        "conflict",
        "transaction has no recovery journal",
      );
    }
    if (journal.state === "applied" && options.allow_applied !== true) {
      throw new KnowledgeHygieneTransactionErrorV1(
        "conflict",
        "applied transaction does not require recovery",
      );
    }
    await recoverJournal(
      plan,
      options.state_root,
      journal,
      now,
      options.hooks ?? {},
    );
    const recovered = receipt(
      plan,
      "recovery",
      "recovered",
      now().toISOString(),
      options.evaluation_only,
    );
    return {
      plan: withReceipt(plan, recovered, "recovered"),
      receipt: recovered,
    };
  });
}
