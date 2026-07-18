import { randomUUID } from "node:crypto";
import {
  open,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import {
  ProbeRenderManifestV1,
  ProbeRepositoryRelativePathV1,
  canonicalProbeJson,
  probeSha256,
  verifyProbeRenderArtifacts,
  type ProbeRenderBundleV1,
} from "@osstack/governance";

export type ProbeRenderWriteErrorCodeV1 =
  | "unsafe_path"
  | "forbidden_path"
  | "protected_input"
  | "artifact_conflict"
  | "invalid_artifact";

export class ProbeRenderWriteError extends Error {
  readonly code: ProbeRenderWriteErrorCodeV1;

  constructor(code: ProbeRenderWriteErrorCodeV1, message: string) {
    super(message);
    this.name = "ProbeRenderWriteError";
    this.code = code;
  }
}

export interface WriteProbeRenderBundleInputV1 {
  repo_root: string;
  out_dir: string;
  bundle: ProbeRenderBundleV1;
  protected_input_paths: readonly string[];
  before_manifest?: () => Promise<void>;
}

export interface WriteProbeRenderBundleResultV1 {
  out_dir: string;
  manifest_path: string;
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
  return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`));
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

async function atomicWrite(path: string, content: string): Promise<void> {
  const temporary = resolve(dirname(path), `.probe-tmp-${randomUUID()}`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function readExistingManifest(path: string) {
  try {
    return ProbeRenderManifestV1.parse(
      JSON.parse(await readFile(path, "utf8")),
    );
  } catch (error) {
    if (isNotFound(error)) return undefined;
    if (error instanceof SyntaxError || (error instanceof Error && error.name === "ZodError")) {
      throw new ProbeRenderWriteError(
        "invalid_artifact",
        "existing render manifest is invalid",
      );
    }
    throw error;
  }
}

async function verifyExistingCommittedSet(
  outDir: string,
  expectedSessionId: string,
  planned: ReadonlyMap<string, string>,
): Promise<Set<string> | undefined> {
  const manifest = await readExistingManifest(
    resolve(outDir, "render-manifest.json"),
  );
  if (manifest === undefined) return undefined;
  if (manifest.session_id !== expectedSessionId) {
    throw new ProbeRenderWriteError(
      "artifact_conflict",
      "render directory belongs to a different probe session",
    );
  }
  try {
    for (const file of manifest.files) {
      const content = await readFile(resolve(outDir, file.path));
      const matchesPrevious =
        content.byteLength === file.bytes && probeSha256(content) === file.sha256;
      const plannedContent = planned.get(file.path);
      const matchesPlanned =
        plannedContent !== undefined &&
        Buffer.from(plannedContent).equals(content);
      if (!matchesPrevious && !matchesPlanned) {
        throw new Error(`artifact differs: ${file.path}`);
      }
    }
  } catch {
    throw new ProbeRenderWriteError(
      "artifact_conflict",
      "existing render artifacts were modified or are incomplete",
    );
  }
  return new Set(manifest.files.map((file) => file.path));
}

async function prepareDirectory(
  outDir: string,
  bundle: ProbeRenderBundleV1,
): Promise<void> {
  let entries: string[] = [];
  try {
    const info = await stat(outDir);
    if (!info.isDirectory()) {
      throw new ProbeRenderWriteError(
        "artifact_conflict",
        "render output exists and is not a directory",
      );
    }
    entries = await readdir(outDir);
  } catch (error) {
    if (!isNotFound(error)) throw error;
    await mkdir(outDir, { recursive: true });
  }
  const planned = new Map(
    bundle.files.map((file) => [file.path, file.content]),
  );
  const previousFiles = await verifyExistingCommittedSet(
    outDir,
    bundle.manifest.session_id,
    planned,
  );
  for (const entry of entries) {
    if (entry.startsWith(".probe-tmp-")) {
      await rm(resolve(outDir, entry), { force: true });
      continue;
    }
    if (entry === "render-manifest.json") continue;
    if (previousFiles?.has(entry)) continue;
    const expected = planned.get(entry);
    if (expected === undefined) {
      throw new ProbeRenderWriteError(
        "artifact_conflict",
        `unexpected file in render directory: ${entry}`,
      );
    }
    if ((await readFile(resolve(outDir, entry), "utf8")) !== expected) {
      throw new ProbeRenderWriteError(
        "artifact_conflict",
        `partial render file differs from retry content: ${entry}`,
      );
    }
  }
  if (previousFiles !== undefined) {
    for (const previous of previousFiles) {
      if (!planned.has(previous)) {
        await rm(resolve(outDir, previous), { force: true });
      }
    }
  }
}

export async function writeProbeRenderBundle(
  input: WriteProbeRenderBundleInputV1,
): Promise<WriteProbeRenderBundleResultV1> {
  const repoRoot = await realpath(input.repo_root);
  const parsedOut = ProbeRepositoryRelativePathV1.safeParse(input.out_dir);
  if (!parsedOut.success) {
    throw new ProbeRenderWriteError(
      "unsafe_path",
      "render output must be a normalized repository-relative directory",
    );
  }
  const firstSegment = parsedOut.data.split("/")[0];
  if (
    firstSegment === ".git" ||
    firstSegment === ".osstack" ||
    firstSegment === "node_modules" ||
    firstSegment === "dist"
  ) {
    throw new ProbeRenderWriteError(
      "forbidden_path",
      `render output cannot be written under ${firstSegment}`,
    );
  }
  const outDir = resolve(repoRoot, parsedOut.data);
  const ancestor = await nearestExistingAncestor(outDir);
  if (!isContained(repoRoot, ancestor)) {
    throw new ProbeRenderWriteError(
      "unsafe_path",
      "render output escapes the repository through a symlink",
    );
  }
  const protectedInputs = new Set(input.protected_input_paths.map((path) => resolve(path)));
  for (const file of [...input.bundle.files.map((candidate) => candidate.path), "render-manifest.json"]) {
    if (protectedInputs.has(resolve(outDir, file))) {
      throw new ProbeRenderWriteError(
        "protected_input",
        `render would overwrite an input source: ${file}`,
      );
    }
  }

  await prepareDirectory(outDir, input.bundle);
  for (const file of input.bundle.files) {
    await atomicWrite(resolve(outDir, file.path), file.content);
  }
  await syncDirectory(outDir);
  await input.before_manifest?.();
  const manifestPath = resolve(outDir, "render-manifest.json");
  await atomicWrite(manifestPath, input.bundle.manifest_content);
  await syncDirectory(outDir);
  return { out_dir: outDir, manifest_path: manifestPath };
}

export async function readProbeRenderDirectory(outDir: string) {
  const manifest = ProbeRenderManifestV1.parse(
    JSON.parse(await readFile(resolve(outDir, "render-manifest.json"), "utf8")),
  );
  const files = new Map<string, Uint8Array>();
  for (const file of manifest.files) {
    files.set(file.path, await readFile(resolve(outDir, file.path)));
  }
  const verified = verifyProbeRenderArtifacts(manifest, files);
  if (canonicalProbeJson(manifest) !== await readFile(resolve(outDir, "render-manifest.json"), "utf8")) {
    throw new ProbeRenderWriteError(
      "invalid_artifact",
      "render manifest is not canonical JSON",
    );
  }
  return verified;
}
