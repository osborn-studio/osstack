import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import {
  ProbeEvidenceRefV1,
  ProbeQuestionBatchV1,
  ProbeRestatementFindingsV1,
  ProbeRepositoryRelativePathV1,
  probeSha256,
  type ProbeEvidenceRefV1 as ProbeEvidenceRef,
  type ProbeQuestionBatchV1 as ProbeQuestionBatch,
  type ProbeRestatementFindingsV1 as ProbeRestatementFindings,
} from "@osstack/governance";

export class ProbeDynamicFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProbeDynamicFileError";
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

async function resolveRepoFile(
  rawRepoRoot: string,
  portablePath: string,
): Promise<string> {
  const repoRoot = await realpath(rawRepoRoot);
  const parsed = ProbeRepositoryRelativePathV1.safeParse(portablePath);
  if (!parsed.success) {
    throw new ProbeDynamicFileError(
      "dynamic input paths must be normalized repository-relative paths",
    );
  }
  let path: string;
  try {
    path = await realpath(resolve(repoRoot, parsed.data));
  } catch (error) {
    if (isNotFound(error)) {
      throw new ProbeDynamicFileError(
        `dynamic evidence does not exist: ${portablePath}`,
      );
    }
    throw error;
  }
  if (!isContained(repoRoot, path)) {
    throw new ProbeDynamicFileError(
      `dynamic evidence escapes the repository: ${portablePath}`,
    );
  }
  if (!(await stat(path)).isFile()) {
    throw new ProbeDynamicFileError(
      `dynamic evidence is not a regular file: ${portablePath}`,
    );
  }
  return path;
}

async function readJsonRepoFile(
  repoRoot: string,
  portablePath: string,
): Promise<unknown> {
  const path = await resolveRepoFile(repoRoot, portablePath);
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new ProbeDynamicFileError(
      `invalid dynamic JSON ${portablePath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

export async function readProbeQuestionBatch(
  repoRoot: string,
  portablePath: string,
): Promise<ProbeQuestionBatch> {
  try {
    return ProbeQuestionBatchV1.parse(
      await readJsonRepoFile(repoRoot, portablePath),
    );
  } catch (error) {
    if (error instanceof ProbeDynamicFileError) throw error;
    throw new ProbeDynamicFileError(
      `invalid probe question batch ${portablePath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

export async function readProbeRestatementFindings(
  repoRoot: string,
  portablePath: string,
): Promise<ProbeRestatementFindings> {
  try {
    return ProbeRestatementFindingsV1.parse(
      await readJsonRepoFile(repoRoot, portablePath),
    );
  } catch (error) {
    if (error instanceof ProbeDynamicFileError) throw error;
    throw new ProbeDynamicFileError(
      `invalid restatement findings ${portablePath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

export async function verifyProbeDynamicEvidence(
  repoRoot: string,
  rawEvidence: ProbeEvidenceRef,
): Promise<{ verifiable: boolean }> {
  const evidence = ProbeEvidenceRefV1.parse(rawEvidence);
  if (evidence.kind !== "file" && evidence.kind !== "artifact") {
    return { verifiable: false };
  }
  if (evidence.sha256 === undefined) {
    return { verifiable: false };
  }
  const path = await resolveRepoFile(repoRoot, evidence.ref);
  const actual = probeSha256(await readFile(path));
  if (actual !== evidence.sha256) {
    throw new ProbeDynamicFileError(
      `dynamic evidence hash mismatch: ${evidence.ref}`,
    );
  }
  return { verifiable: true };
}

export interface ProbeRestatementInputV1 {
  label: "spec" | "restatement";
  content: Uint8Array;
  repo_relative_path?: string;
}

function verifyRestatementSide(
  side: ProbeRestatementInputV1,
  evidence: {
    sha256: string;
    path?: string | undefined;
    line?: number | undefined;
    anchor?: string | undefined;
  },
): ProbeEvidenceRef {
  const actual = probeSha256(side.content);
  if (actual !== evidence.sha256) {
    throw new ProbeDynamicFileError(
      `${side.label} evidence hash does not match the supplied input`,
    );
  }
  if (evidence.path !== undefined && evidence.path !== side.repo_relative_path) {
    throw new ProbeDynamicFileError(
      `${side.label} evidence path does not match the supplied input`,
    );
  }
  if (evidence.path === undefined && side.repo_relative_path !== undefined) {
    throw new ProbeDynamicFileError(
      `${side.label} evidence must name its repository-relative input path`,
    );
  }
  const text = Buffer.from(side.content).toString("utf8");
  if (
    evidence.line !== undefined &&
    evidence.line > text.split(/\r?\n/).length
  ) {
    throw new ProbeDynamicFileError(
      `${side.label} evidence line is outside the supplied input`,
    );
  }
  if (evidence.anchor !== undefined && !text.includes(evidence.anchor)) {
    throw new ProbeDynamicFileError(
      `${side.label} evidence anchor is absent from the supplied input`,
    );
  }
  return ProbeEvidenceRefV1.parse({
    kind: side.repo_relative_path === undefined ? "command_output" : "file",
    ref: side.repo_relative_path ?? `probe-restate-${side.label}-input`,
    sha256: evidence.sha256,
    ...(evidence.line === undefined ? {} : { line: evidence.line }),
    ...(evidence.anchor === undefined ? {} : { symbol: evidence.anchor }),
  });
}

export function verifyProbeRestatementEvidence(
  findings: ProbeRestatementFindings,
  spec: ProbeRestatementInputV1,
  restatement: ProbeRestatementInputV1,
): ProbeEvidenceRef[][] {
  return findings.map((finding) => [
    ...(finding.spec_evidence === null
      ? []
      : [verifyRestatementSide(spec, finding.spec_evidence)]),
    ...(finding.restatement_evidence === null
      ? []
      : [verifyRestatementSide(restatement, finding.restatement_evidence)]),
  ]);
}
