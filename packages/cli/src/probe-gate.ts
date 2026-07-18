import { readFile, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import {
  DEFAULT_PROBE_GATE_POLICY_V1,
  ProbeGatePolicyV1,
  ProbeRepositoryRelativePathV1,
  probeSha256,
  type ProbeDestinationContentV1,
  type ProbeItemV1,
} from "@osstack/governance";
import { parse as parseYaml } from "yaml";
import { readProbeRenderDirectory } from "./probe-render.js";

export class ProbeGateInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProbeGateInputError";
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

function isContained(root: string, path: string): boolean {
  const candidate = relative(root, path);
  return (
    candidate === "" ||
    (!isAbsolute(candidate) &&
      candidate !== ".." &&
      !candidate.startsWith(`..${sep}`))
  );
}

async function resolveRepoFile(
  repoRoot: string,
  portablePath: string,
): Promise<string> {
  const parsed = ProbeRepositoryRelativePathV1.safeParse(portablePath);
  if (!parsed.success) {
    throw new ProbeGateInputError(
      "gate paths must be normalized repository-relative paths",
    );
  }
  const candidate = resolve(repoRoot, parsed.data);
  let canonical: string;
  try {
    canonical = await realpath(candidate);
  } catch (error) {
    if (isNotFound(error)) {
      throw new ProbeGateInputError(`gate input does not exist: ${portablePath}`);
    }
    throw error;
  }
  if (!isContained(repoRoot, canonical)) {
    throw new ProbeGateInputError(
      `gate input escapes the repository: ${portablePath}`,
    );
  }
  if (!(await stat(canonical)).isFile()) {
    throw new ProbeGateInputError(`gate input is not a regular file: ${portablePath}`);
  }
  return canonical;
}

export async function loadProbeGatePolicy(
  rawRepoRoot: string,
  explicitPath?: string,
): Promise<{
  policy: ProbeGatePolicyV1;
  source: "built_in" | string;
}> {
  const repoRoot = await realpath(rawRepoRoot);
  const portablePath = explicitPath ?? ".osstack/probe.yaml";
  let path: string;
  try {
    path = await resolveRepoFile(repoRoot, portablePath);
  } catch (error) {
    if (
      explicitPath === undefined &&
      error instanceof ProbeGateInputError &&
      error.message.includes("does not exist")
    ) {
      return { policy: DEFAULT_PROBE_GATE_POLICY_V1, source: "built_in" };
    }
    throw error;
  }
  try {
    return {
      policy: ProbeGatePolicyV1.parse(
        parseYaml(await readFile(path, "utf8")) as unknown,
      ),
      source: portablePath,
    };
  } catch (error) {
    throw new ProbeGateInputError(
      `invalid probe gate config ${portablePath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

export async function readPortableProbeLedger(
  rawRepoRoot: string,
  ledgerPath: string,
) {
  const repoRoot = await realpath(rawRepoRoot);
  const path = await resolveRepoFile(repoRoot, ledgerPath);
  if (path.split(sep).at(-1) !== "ledger.json") {
    throw new ProbeGateInputError("--ledger must point to ledger.json");
  }
  try {
    return await readProbeRenderDirectory(dirname(path));
  } catch (error) {
    throw new ProbeGateInputError(
      `invalid portable probe artifact set: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

export async function collectProbeDestinationContent(
  rawRepoRoot: string,
  items: readonly ProbeItemV1[],
): Promise<Record<string, ProbeDestinationContentV1>> {
  const repoRoot = await realpath(rawRepoRoot);
  const result: Record<string, ProbeDestinationContentV1> = {};
  for (const item of items) {
    if (
      item.state !== "resolved" ||
      item.destination.role === "session_profile" ||
      item.destination.content_sha256 === undefined
    ) {
      continue;
    }
    const portablePath = item.destination.path;
    try {
      const path = await resolveRepoFile(repoRoot, portablePath);
      const content = await readFile(path);
      result[portablePath] = {
        exists: true,
        sha256: probeSha256(content),
      };
    } catch (error) {
      if (
        error instanceof ProbeGateInputError &&
        error.message.includes("does not exist")
      ) {
        result[portablePath] = { exists: false };
        continue;
      }
      throw error;
    }
  }
  return result;
}
