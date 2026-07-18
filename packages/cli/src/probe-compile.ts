import { randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  stat,
} from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import {
  ProbeEvaluationCompilationBatchV1,
  ProbeEvaluationCompilationDeltaV1,
  ProbeRepositoryRelativePathV1,
  canonicalProbeJson,
  probeSha256,
  type ProbeEvaluationCompilationBatchV1 as ProbeCompilationBatch,
  type ProbeEvaluationCompilationDeltaV1 as ProbeCompilationDelta,
  type ProbeEvaluationCompilerEnvironmentV1,
} from "@osstack/governance";

export type ProbeCompileFileErrorCodeV1 =
  | "invalid_input"
  | "unsafe_path"
  | "artifact_conflict";

export class ProbeCompileFileError extends Error {
  readonly code: ProbeCompileFileErrorCodeV1;

  constructor(code: ProbeCompileFileErrorCodeV1, message: string) {
    super(message);
    this.name = "ProbeCompileFileError";
    this.code = code;
  }
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

function isContained(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return (
    path === "" ||
    (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`))
  );
}

async function nearestExistingAncestor(path: string): Promise<string> {
  let candidate = path;
  while (true) {
    try {
      return await realpath(candidate);
    } catch (error) {
      if (!isNotFound(error)) throw error;
      const parent = dirname(candidate);
      if (parent === candidate) throw error;
      candidate = parent;
    }
  }
}

async function safePortablePath(
  rawRepoRoot: string,
  portablePath: string,
): Promise<{ repo_root: string; path: string; portable_path: string }> {
  const repoRoot = await realpath(rawRepoRoot);
  const parsed = ProbeRepositoryRelativePathV1.safeParse(portablePath);
  if (!parsed.success) {
    throw new ProbeCompileFileError(
      "unsafe_path",
      "compile paths must be normalized repository-relative paths",
    );
  }
  const path = resolve(repoRoot, parsed.data);
  const ancestor = await nearestExistingAncestor(path);
  if (!isContained(repoRoot, ancestor)) {
    throw new ProbeCompileFileError(
      "unsafe_path",
      `compile path escapes the repository: ${portablePath}`,
    );
  }
  return { repo_root: repoRoot, path, portable_path: parsed.data };
}

async function regularRepoFile(
  repoRoot: string,
  portablePath: string,
): Promise<string> {
  const safe = await safePortablePath(repoRoot, portablePath);
  let canonical: string;
  try {
    canonical = await realpath(safe.path);
  } catch (error) {
    if (isNotFound(error)) {
      throw new ProbeCompileFileError(
        "invalid_input",
        `compile input does not exist: ${portablePath}`,
      );
    }
    throw error;
  }
  if (!isContained(safe.repo_root, canonical)) {
    throw new ProbeCompileFileError(
      "unsafe_path",
      `compile input escapes the repository: ${portablePath}`,
    );
  }
  if (!(await stat(canonical)).isFile()) {
    throw new ProbeCompileFileError(
      "invalid_input",
      `compile input is not a regular file: ${portablePath}`,
    );
  }
  return canonical;
}

export async function readProbeCompilationBatch(
  repoRoot: string,
  portablePath: string,
): Promise<ProbeCompilationBatch> {
  try {
    return ProbeEvaluationCompilationBatchV1.parse(
      JSON.parse(
        await readFile(await regularRepoFile(repoRoot, portablePath), "utf8"),
      ),
    );
  } catch (error) {
    if (error instanceof ProbeCompileFileError) throw error;
    throw new ProbeCompileFileError(
      "invalid_input",
      `invalid compilation request ${portablePath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

export function createProbeCompilerEnvironment(
  repoRoot: string,
): ProbeEvaluationCompilerEnvironmentV1 {
  return {
    verify_package_script: async (packagePath, script) => {
      const manifestPath = `${packagePath}/package.json`;
      let manifest: unknown;
      try {
        manifest = JSON.parse(
          await readFile(
            await regularRepoFile(repoRoot, manifestPath),
            "utf8",
          ),
        );
      } catch (error) {
        if (error instanceof ProbeCompileFileError) throw error;
        throw new ProbeCompileFileError(
          "invalid_input",
          `invalid package manifest: ${manifestPath}`,
        );
      }
      const scripts =
        typeof manifest === "object" &&
        manifest !== null &&
        "scripts" in manifest &&
        typeof manifest.scripts === "object" &&
        manifest.scripts !== null
          ? (manifest.scripts as Record<string, unknown>)
          : {};
      if (typeof scripts[script] !== "string") {
        throw new ProbeCompileFileError(
          "invalid_input",
          `package script is not registered: ${packagePath}#${script}`,
        );
      }
    },
    verify_artifact_path: async (path) => {
      await safePortablePath(repoRoot, path);
    },
    verify_contract_manifest: async (manifestPath, manifestId) => {
      let manifest: unknown;
      try {
        manifest = JSON.parse(
          await readFile(
            await regularRepoFile(repoRoot, manifestPath),
            "utf8",
          ),
        );
      } catch (error) {
        if (error instanceof ProbeCompileFileError) throw error;
        throw new ProbeCompileFileError(
          "invalid_input",
          `invalid contract manifest: ${manifestPath}`,
        );
      }
      const record =
        typeof manifest === "object" && manifest !== null
          ? (manifest as Record<string, unknown>)
          : {};
      if (
        !["id", "manifest_id", "contract_id", "pack_id"].some(
          (key) => record[key] === manifestId,
        )
      ) {
        throw new ProbeCompileFileError(
          "invalid_input",
          `contract manifest id is not registered: ${manifestId}`,
        );
      }
    },
  };
}

export async function writeProbeCompilationDelta(
  repoRoot: string,
  outPath: string,
  rawDelta: ProbeCompilationDelta,
  protectedPaths: readonly string[],
): Promise<{
  path: string;
  portable_path: string;
  sha256: string;
  created: boolean;
}> {
  const delta = ProbeEvaluationCompilationDeltaV1.parse(rawDelta);
  const safe = await safePortablePath(repoRoot, outPath);
  const firstSegment = safe.portable_path.split("/")[0];
  if (
    firstSegment === ".git" ||
    firstSegment === ".osstack" ||
    firstSegment === "node_modules" ||
    firstSegment === "dist"
  ) {
    throw new ProbeCompileFileError(
      "unsafe_path",
      `compile output cannot be written under ${firstSegment}`,
    );
  }
  if (
    protectedPaths.some(
      (protectedPath) => resolve(safe.repo_root, protectedPath) === safe.path,
    )
  ) {
    throw new ProbeCompileFileError(
      "unsafe_path",
      "compile output cannot overwrite an input",
    );
  }
  const content = canonicalProbeJson(delta);
  try {
    const existing = await readFile(safe.path, "utf8");
    if (existing !== content) {
      throw new ProbeCompileFileError(
        "artifact_conflict",
        `compile output already exists with different content: ${outPath}`,
      );
    }
    return {
      path: safe.path,
      portable_path: safe.portable_path,
      sha256: probeSha256(content),
      created: false,
    };
  } catch (error) {
    if (error instanceof ProbeCompileFileError) throw error;
    if (!isNotFound(error)) throw error;
  }
  await mkdir(dirname(safe.path), { recursive: true });
  const temporary = resolve(
    dirname(safe.path),
    `.probe-compile-${randomUUID()}`,
  );
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, safe.path);
  const directory = await open(dirname(safe.path), "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
  return {
    path: safe.path,
    portable_path: safe.portable_path,
    sha256: probeSha256(content),
    created: true,
  };
}

export async function verifyProbeCompilationDelta(
  repoRoot: string,
  portablePath: string,
  expectedSha256: string,
): Promise<ProbeCompilationDelta> {
  const content = await readFile(
    await regularRepoFile(repoRoot, portablePath),
    "utf8",
  );
  if (probeSha256(content) !== expectedSha256) {
    throw new ProbeCompileFileError(
      "artifact_conflict",
      "compiled evaluation delta was modified after its receipt",
    );
  }
  const delta = ProbeEvaluationCompilationDeltaV1.parse(JSON.parse(content));
  if (canonicalProbeJson(delta) !== content) {
    throw new ProbeCompileFileError(
      "artifact_conflict",
      "compiled evaluation delta is not canonical JSON",
    );
  }
  return delta;
}
