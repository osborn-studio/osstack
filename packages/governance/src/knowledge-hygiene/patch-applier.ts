import { createHash, randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { link, lstat, open, realpath, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  KnowledgeHygienePatchPlanV1,
  type KnowledgeHygienePatchActionV1,
  type KnowledgeHygienePatchPlanV1 as KnowledgeHygienePatchPlan,
} from "./patch-types.js";

export type KnowledgeHygienePatchConflictErrorCode =
  | "parent_unavailable"
  | "parent_outside_repo"
  | "target_changed";

export class KnowledgeHygienePatchConflictError extends Error {
  readonly code: KnowledgeHygienePatchConflictErrorCode;

  constructor(code: KnowledgeHygienePatchConflictErrorCode, message: string) {
    super(message);
    this.name = "KnowledgeHygienePatchConflictError";
    this.code = code;
  }
}

export interface KnowledgeHygienePatchApplyActionResultV1 {
  action_id: string;
  target_path: string;
  status: "applied" | "already_applied";
  before: {
    exists: boolean;
    sha256: string | null;
  };
  after: {
    exists: true;
    sha256: string;
  };
  applied_at: string;
}

export interface KnowledgeHygienePatchApplyResultV1 {
  schema_version: "1";
  patch_id: string;
  repo: KnowledgeHygienePatchPlan["repo"];
  actions: KnowledgeHygienePatchApplyActionResultV1[];
}

export interface KnowledgeHygienePatchApplyPortsV1 {
  now?: () => Date;
}

interface ExistingTarget {
  exists: boolean;
  sha256: string | null;
  content?: string;
  regular_file: boolean;
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  return typeof error.code === "string" ? error.code : undefined;
}

function isInsideRoot(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return pathFromRoot === "" || (
    !pathFromRoot.startsWith(`..${sep}`) &&
    pathFromRoot !== ".." &&
    !isAbsolute(pathFromRoot)
  );
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

async function inspectTarget(target: string): Promise<ExistingTarget> {
  let metadata: Stats;
  try {
    metadata = await lstat(target);
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return { exists: false, sha256: null, regular_file: false };
    }
    throw error;
  }
  if (!metadata.isFile()) {
    return { exists: true, sha256: null, regular_file: false };
  }
  const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const content = await handle.readFile("utf8");
    return {
      exists: true,
      sha256: sha256(content),
      content,
      regular_file: true,
    };
  } finally {
    await handle.close();
  }
}

function isAlreadyApplied(
  existing: ExistingTarget,
  action: KnowledgeHygienePatchActionV1,
): boolean {
  return (
    existing.regular_file &&
    existing.sha256 === action.after.sha256 &&
    existing.content === action.after.content
  );
}

function targetChanged(action: KnowledgeHygienePatchActionV1): never {
  throw new KnowledgeHygienePatchConflictError(
    "target_changed",
    `patch precondition failed; target is no longer absent: ${action.target_path}`,
  );
}

async function resolveSafeTarget(
  root: string,
  targetPath: string,
): Promise<string> {
  const lexicalTarget = resolve(root, targetPath);
  if (!isInsideRoot(root, lexicalTarget)) {
    throw new KnowledgeHygienePatchConflictError(
      "parent_outside_repo",
      `patch target resolves outside repository: ${targetPath}`,
    );
  }
  let resolvedParent: string;
  try {
    resolvedParent = await realpath(dirname(lexicalTarget));
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      throw new KnowledgeHygienePatchConflictError(
        "parent_unavailable",
        `patch target parent does not exist: ${targetPath}`,
      );
    }
    throw error;
  }
  if (!isInsideRoot(root, resolvedParent)) {
    throw new KnowledgeHygienePatchConflictError(
      "parent_outside_repo",
      `patch target parent resolves outside repository: ${targetPath}`,
    );
  }
  return join(resolvedParent, basename(lexicalTarget));
}

async function createNoReplace(
  target: string,
  action: KnowledgeHygienePatchActionV1,
): Promise<"applied" | "already_applied"> {
  const existing = await inspectTarget(target);
  if (existing.exists) {
    if (isAlreadyApplied(existing, action)) return "already_applied";
    return targetChanged(action);
  }

  const tempPath = join(
    dirname(target),
    `.${basename(target)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let tempExists = false;
  try {
    const handle = await open(
      tempPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o644,
    );
    tempExists = true;
    try {
      await handle.writeFile(action.after.content, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await link(tempPath, target);
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
      const raced = await inspectTarget(target);
      if (isAlreadyApplied(raced, action)) return "already_applied";
      return targetChanged(action);
    }
    return "applied";
  } finally {
    if (tempExists) await unlink(tempPath).catch(() => undefined);
  }
}

export async function applyKnowledgeHygienePatchPlan(
  rawPlan: KnowledgeHygienePatchPlan,
  ports: KnowledgeHygienePatchApplyPortsV1 = {},
): Promise<KnowledgeHygienePatchApplyResultV1> {
  const plan = KnowledgeHygienePatchPlanV1.parse(rawPlan);
  const root = await realpath(resolve(plan.repo.root));
  const now = ports.now ?? (() => new Date());
  const actions: KnowledgeHygienePatchApplyActionResultV1[] = [];

  for (const action of plan.actions) {
    const target = await resolveSafeTarget(root, action.target_path);
    const before = await inspectTarget(target);
    const status = await createNoReplace(target, action);
    actions.push({
      action_id: action.action_id,
      target_path: action.target_path,
      status,
      before: {
        exists: before.exists,
        sha256: before.sha256,
      },
      after: {
        exists: true,
        sha256: action.after.sha256,
      },
      applied_at: now().toISOString(),
    });
  }

  return {
    schema_version: "1",
    patch_id: plan.patch_id,
    repo: plan.repo,
    actions,
  };
}
