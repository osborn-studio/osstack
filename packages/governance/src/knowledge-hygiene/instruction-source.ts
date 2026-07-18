import type { Stats } from "node:fs";
import { lstat, readFile, readlink, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

export type InstructionMirrorModeV1 =
  | "import"
  | "symlink"
  | "import_or_symlink";

interface InstructionSourcePathsV1 {
  canonical_path: string;
  mirror_path: string;
}

export type InstructionSourceObservationV1 =
  | (InstructionSourcePathsV1 & { status: "both_missing" })
  | (InstructionSourcePathsV1 & { status: "canonical_missing" })
  | (InstructionSourcePathsV1 & { status: "mirror_missing" })
  | (InstructionSourcePathsV1 & {
      status: "valid_mirror";
      mirror_kind: "import" | "symlink";
    })
  | (InstructionSourcePathsV1 & {
      status: "mirror_drift";
      reason: string;
    });

export interface InspectInstructionSourceInputV1 {
  repo_root: string;
  canonical_path: string;
  mirror_path: string;
  mirror_mode: InstructionMirrorModeV1;
}

export class InstructionSourceInspectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InstructionSourceInspectionError";
  }
}

function isInsideRoot(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return (
    pathFromRoot === "" ||
    (!pathFromRoot.startsWith(`..${sep}`) &&
      pathFromRoot !== ".." &&
      !isAbsolute(pathFromRoot))
  );
}

function resolveInstructionPath(root: string, value: string): string {
  if (
    value.length === 0 ||
    isAbsolute(value) ||
    /^[A-Za-z]:[\\/]/.test(value) ||
    value.includes("\\") ||
    value.split("/").includes("..")
  ) {
    throw new InstructionSourceInspectionError(
      `instruction path must be a confined repository-relative POSIX path: ${value}`,
    );
  }
  const candidate = resolve(root, value);
  if (!isInsideRoot(root, candidate)) {
    throw new InstructionSourceInspectionError(
      `instruction path resolves outside repository: ${value}`,
    );
  }
  return candidate;
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  return typeof error.code === "string" ? error.code : undefined;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false;
    throw error;
  }
}

function paths(input: InspectInstructionSourceInputV1): InstructionSourcePathsV1 {
  return {
    canonical_path: input.canonical_path,
    mirror_path: input.mirror_path,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function inspectInstructionSource(
  input: InspectInstructionSourceInputV1,
): Promise<InstructionSourceObservationV1> {
  let root: string;
  try {
    root = await realpath(resolve(input.repo_root));
  } catch (error) {
    throw new InstructionSourceInspectionError(
      `cannot resolve repository root: ${errorMessage(error)}`,
    );
  }

  const canonical = resolveInstructionPath(root, input.canonical_path);
  const mirror = resolveInstructionPath(root, input.mirror_path);
  const [canonicalExists, mirrorExists] = await Promise.all([
    pathExists(canonical),
    pathExists(mirror),
  ]);
  const sourcePaths = paths(input);

  if (!canonicalExists && !mirrorExists) {
    return { ...sourcePaths, status: "both_missing" };
  }
  if (!canonicalExists) {
    return { ...sourcePaths, status: "canonical_missing" };
  }
  if (!mirrorExists) {
    return { ...sourcePaths, status: "mirror_missing" };
  }

  let mirrorMetadata: Stats;
  try {
    mirrorMetadata = await lstat(mirror);
  } catch (error) {
    return {
      ...sourcePaths,
      status: "mirror_drift",
      reason: errorMessage(error),
    };
  }

  if (mirrorMetadata.isSymbolicLink()) {
    let target: string;
    try {
      target = await readlink(mirror);
    } catch (error) {
      return {
        ...sourcePaths,
        status: "mirror_drift",
        reason: errorMessage(error),
      };
    }
    const lexicalTarget = resolve(dirname(mirror), target);
    if (!isInsideRoot(root, lexicalTarget)) {
      return {
        ...sourcePaths,
        status: "mirror_drift",
        reason: `${input.mirror_path} symlink resolves outside repository`,
      };
    }

    let resolvedTarget: string;
    let resolvedCanonical: string;
    try {
      [resolvedTarget, resolvedCanonical] = await Promise.all([
        realpath(lexicalTarget),
        realpath(canonical),
      ]);
    } catch {
      return {
        ...sourcePaths,
        status: "mirror_drift",
        reason: `${input.mirror_path} symlink points to ${target}`,
      };
    }
    if (!isInsideRoot(root, resolvedTarget)) {
      return {
        ...sourcePaths,
        status: "mirror_drift",
        reason: `${input.mirror_path} symlink resolves outside repository`,
      };
    }
    if (resolvedTarget !== resolvedCanonical) {
      return {
        ...sourcePaths,
        status: "mirror_drift",
        reason: `${input.mirror_path} symlink points to ${target}`,
      };
    }
    if (input.mirror_mode === "import") {
      return {
        ...sourcePaths,
        status: "mirror_drift",
        reason: `${input.mirror_path} must be an import of ${input.canonical_path}`,
      };
    }
    return { ...sourcePaths, status: "valid_mirror", mirror_kind: "symlink" };
  }

  if (input.mirror_mode === "symlink") {
    return {
      ...sourcePaths,
      status: "mirror_drift",
      reason: `${input.mirror_path} must be a symlink to ${input.canonical_path}`,
    };
  }
  if (!mirrorMetadata.isFile()) {
    return {
      ...sourcePaths,
      status: "mirror_drift",
      reason: `${input.mirror_path} is not a regular file or symlink`,
    };
  }

  let content: string;
  try {
    content = (await readFile(mirror, "utf8")).trim();
  } catch (error) {
    return {
      ...sourcePaths,
      status: "mirror_drift",
      reason: errorMessage(error),
    };
  }
  const expectedImport = `@${input.canonical_path}`;
  if (content !== expectedImport) {
    return {
      ...sourcePaths,
      status: "mirror_drift",
      reason: `${input.mirror_path} content is not exactly ${expectedImport}`,
    };
  }
  return { ...sourcePaths, status: "valid_mirror", mirror_kind: "import" };
}
