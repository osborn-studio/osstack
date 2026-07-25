import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  SemanticDecisionV1,
  SemanticEvidencePackV1,
  type SemanticAuditPortsV1,
} from "@osstack/governance";

const cacheKeyPattern = /^khsc_[a-f0-9]{64}$/u;
const runIdPattern = /^khsr_[a-f0-9]{64}$/u;
const MAX_CACHE_BYTES = 1024 * 1024;
const EVIDENCE_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;

function isInsideRoot(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate);
  return fromRoot === ""
    || (fromRoot !== ".."
      && !fromRoot.startsWith(`..${sep}`)
      && !isAbsolute(fromRoot));
}

async function privateDirectory(base: string, ...segments: string[]): Promise<string> {
  const absoluteBase = resolve(base);
  await mkdir(absoluteBase, { recursive: true, mode: 0o700 });
  await chmod(absoluteBase, 0o700);
  const root = await realpath(absoluteBase);
  const target = resolve(root, ...segments);
  await mkdir(target, { recursive: true, mode: 0o700 });
  const resolved = await realpath(target);
  if (!isInsideRoot(root, resolved)) {
    throw new Error("semantic artifact directory resolves outside OSSTACK_HOME");
  }
  await chmod(resolved, 0o700);
  return resolved;
}

async function writePrivateJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } catch (error) {
    await handle.close();
    await rm(temporary, { force: true });
    throw error;
  }
  await handle.close();
  try {
    await rename(temporary, path);
    await chmod(path, 0o600);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

export function createFileSemanticDecisionCacheV1(
  osstackRoot: string,
): NonNullable<SemanticAuditPortsV1["decision_cache"]> {
  const cachePath = async (key: string): Promise<string> => {
    if (!cacheKeyPattern.test(key)) throw new Error("invalid semantic cache key");
    return join(
      await privateDirectory(osstackRoot, "neat", "cache", "semantic"),
      `${key}.json`,
    );
  };
  return {
    async read(key) {
      const path = await cachePath(key);
      let handle: Awaited<ReturnType<typeof open>>;
      try {
        handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      } catch (error) {
        if (
          typeof error === "object"
          && error !== null
          && "code" in error
          && error.code === "ENOENT"
        ) {
          return undefined;
        }
        throw error;
      }
      try {
        const metadata = await handle.stat();
        if (!metadata.isFile() || metadata.size > MAX_CACHE_BYTES) {
          throw new Error("semantic decision cache entry is invalid or too large");
        }
        return SemanticDecisionV1.parse(JSON.parse(await handle.readFile("utf8")));
      } finally {
        await handle.close();
      }
    },
    async write(key, decision) {
      const parsed = SemanticDecisionV1.parse(decision);
      await writePrivateJson(await cachePath(key), parsed);
    },
  };
}

async function pruneExpiredEvidence(
  evidenceRoot: string,
  now: Date,
  currentRunId: string,
): Promise<void> {
  const cutoff = now.getTime() - EVIDENCE_RETENTION_MS;
  for (const entry of await readdir(evidenceRoot, { withFileTypes: true })) {
    if (
      entry.name === currentRunId
      || !runIdPattern.test(entry.name)
      || !entry.isDirectory()
      || entry.isSymbolicLink()
    ) {
      continue;
    }
    const path = join(evidenceRoot, entry.name);
    const metadata = await lstat(path);
    if (metadata.mtimeMs >= cutoff) continue;
    const resolved = await realpath(path);
    if (!isInsideRoot(evidenceRoot, resolved)) {
      throw new Error("semantic evidence run resolves outside evidence root");
    }
    await rm(resolved, { recursive: true, force: true });
  }
}

export function createSemanticEvidenceObserverV1(
  osstackRoot: string,
  options: { now?: () => Date } = {},
): NonNullable<SemanticAuditPortsV1["observe_evidence_pack"]> {
  const now = options.now ?? (() => new Date());
  return async (rawPack, cacheKey, runId) => {
    const pack = SemanticEvidencePackV1.parse(rawPack);
    if (!cacheKeyPattern.test(cacheKey)) throw new Error("invalid semantic cache key");
    if (!runIdPattern.test(runId)) throw new Error("invalid semantic run id");
    const evidenceRoot = await privateDirectory(osstackRoot, "neat", "evidence");
    await pruneExpiredEvidence(evidenceRoot, now(), runId);
    const runRoot = await privateDirectory(evidenceRoot, runId);
    await writePrivateJson(join(runRoot, `${pack.pack_id}.json`), {
      cache_key: cacheKey,
      evidence_pack: pack,
    });
  };
}
