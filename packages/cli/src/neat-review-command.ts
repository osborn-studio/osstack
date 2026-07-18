import {
  assertKnowledgeHygieneReviewArtifactMatchesReport,
  KnowledgeHygieneReportV1,
  KnowledgeHygieneResolutionV1,
  KnowledgeHygieneReviewArtifactV1,
  KnowledgeHygieneReviewError,
  type KnowledgeHygieneEvidenceRefV1,
} from "@osstack/governance";
import { AgentCommandResult } from "@osstack/protocol";
import { constants } from "node:fs";
import { open, rename, unlink, type FileHandle } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";

const outcomes = [
  "fixed",
  "reviewed_no_change",
  "accepted_risk",
  "suppressed",
  "obsolete",
] as const;
type ReviewOutcome = (typeof outcomes)[number];
type ActorKind = "human" | "agent";

interface ParsedReviewCommand {
  help: boolean;
  report_path?: string;
  finding?: string;
  outcome?: ReviewOutcome;
  reason?: string;
  actor?: string;
  actor_kind: ActorKind;
  output_path?: string;
  output_label?: string;
}

export interface NeatReviewCommandDependencies {
  cwd: () => string;
  stdout: (value: string) => void;
  now: () => Date;
}

export class NeatReviewInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NeatReviewInputError";
  }
}

export function renderNeatReviewHelp(): string {
  return `osstack neat review — record a finding resolution

Usage:
  osstack neat review --report <path> --finding <fingerprint> \\
    --outcome <outcome> --reason <text> --actor <id> --output <path>

Options:
  --report <path>                JSON report or successful CLI JSON envelope
  --finding <fingerprint>        Finding fingerprint from the report
  --outcome <outcome>            fixed|reviewed_no_change|accepted_risk|suppressed|obsolete
  --reason <text>                Required resolution rationale
  --actor <id>                   Human or agent identifier
  --actor-kind <human|agent>     Actor kind (default: human)
  --output <path>                Review artifact to create or update atomically
  --help                         Show this help`;
}

function inputError(message: string): never {
  throw new NeatReviewInputError(message);
}

function requireValue(args: readonly string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) {
    return inputError(`${flag} requires a value`);
  }
  return value;
}

function parseReviewCommand(
  args: readonly string[],
  cwd: string,
): ParsedReviewCommand {
  if (args.includes("--help") || args.includes("-h")) {
    return { help: true, actor_kind: "human" };
  }

  const values = new Map<string, string>();
  const seen = new Set<string>();
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === undefined) continue;
    if (![
      "--report",
      "--finding",
      "--outcome",
      "--reason",
      "--actor",
      "--actor-kind",
      "--output",
    ].includes(flag)) {
      return inputError(`unknown review option: ${flag}`);
    }
    if (seen.has(flag)) return inputError(`duplicate flag: ${flag}`);
    seen.add(flag);
    values.set(flag, requireValue(args, index, flag));
    index += 1;
  }

  const required = [
    "--report",
    "--finding",
    "--outcome",
    "--reason",
    "--actor",
    "--output",
  ] as const;
  for (const flag of required) {
    if (!values.has(flag)) return inputError(`${flag} is required`);
  }

  const rawOutcome = values.get("--outcome");
  if (!outcomes.includes(rawOutcome as ReviewOutcome)) {
    return inputError(`unsupported review outcome: ${rawOutcome}`);
  }
  const rawActorKind = values.get("--actor-kind") ?? "human";
  if (rawActorKind !== "human" && rawActorKind !== "agent") {
    return inputError(`unsupported actor kind: ${rawActorKind}`);
  }
  const reportLabel = values.get("--report") as string;
  const outputLabel = values.get("--output") as string;
  const reportPath = resolve(cwd, reportLabel);
  const outputPath = resolve(cwd, outputLabel);
  if (reportPath === outputPath) {
    return inputError("--report and --output must reference different paths");
  }

  return {
    help: false,
    report_path: reportPath,
    finding: values.get("--finding") as string,
    outcome: rawOutcome as ReviewOutcome,
    reason: values.get("--reason") as string,
    actor: values.get("--actor") as string,
    actor_kind: rawActorKind,
    output_path: outputPath,
    output_label: outputLabel,
  };
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

async function readRegularFile(path: string, label: string): Promise<string> {
  let handle: FileHandle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (isNodeError(error) && (error.code === "ENOENT" || error.code === "ELOOP")) {
      return inputError(`${label} is missing or is a symbolic link: ${path}`);
    }
    throw error;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) return inputError(`${label} must be a regular file: ${path}`);
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

function parseJson(text: string, label: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return inputError(`${label} is not valid JSON`);
  }
}

function parseReport(value: unknown): KnowledgeHygieneReportV1 {
  const direct = KnowledgeHygieneReportV1.safeParse(value);
  if (direct.success) return direct.data;

  const envelope = AgentCommandResult.safeParse(value);
  const command = envelope.success ? envelope.data.result?.command : undefined;
  const nestedReport = envelope.success ? envelope.data.result?.report : undefined;
  if (
    !envelope.success ||
    envelope.data.status !== "ok" ||
    command !== "knowledge_hygiene.check"
  ) {
    return inputError(
      "--report must contain a knowledge hygiene report or successful knowledge_hygiene.check envelope",
    );
  }
  const parsed = KnowledgeHygieneReportV1.safeParse(nestedReport);
  if (!parsed.success) {
    return inputError("knowledge_hygiene.check envelope contains an invalid report");
  }
  return parsed.data;
}

async function readExistingArtifact(
  path: string,
): Promise<KnowledgeHygieneReviewArtifactV1 | undefined> {
  let handle: FileHandle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return undefined;
    if (isNodeError(error) && error.code === "ELOOP") {
      return inputError(`--output must not be a symbolic link: ${path}`);
    }
    throw error;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) return inputError(`--output must be a regular file: ${path}`);
    const value = parseJson(await handle.readFile("utf8"), "existing review artifact");
    const parsed = KnowledgeHygieneReviewArtifactV1.safeParse(value);
    if (!parsed.success) return inputError("existing --output is not a valid review artifact");
    return parsed.data;
  } finally {
    await handle.close();
  }
}

export async function loadNeatReviewArtifact(
  path: string,
): Promise<KnowledgeHygieneReviewArtifactV1> {
  const value = parseJson(
    await readRegularFile(path, "--review-file"),
    "--review-file",
  );
  const parsed = KnowledgeHygieneReviewArtifactV1.safeParse(value);
  if (!parsed.success) return inputError("--review-file is not a valid review artifact");
  return parsed.data;
}

async function writeAtomic(path: string, content: string): Promise<void> {
  const tempPath = join(
    dirname(path),
    `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let created = false;
  try {
    const handle = await open(
      tempPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    created = true;
    try {
      await handle.writeFile(content, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tempPath, path);
    created = false;
  } finally {
    if (created) await unlink(tempPath).catch(() => undefined);
  }
}

function createResolution(
  parsed: ParsedReviewCommand,
  report: KnowledgeHygieneReportV1,
  now: Date,
) {
  const finding = report.findings.find(
    (candidate) => candidate.fingerprint === parsed.finding,
  );
  if (!finding) return inputError(`report has no finding ${parsed.finding}`);
  const diffId = report.input.diff_id;
  if (diffId === undefined) return inputError("knowledge hygiene report has no diff_id");

  const resolution = KnowledgeHygieneResolutionV1.safeParse({
    schema_version: "1",
    diff_id: diffId,
    fingerprint: finding.fingerprint,
    outcome: parsed.outcome,
    actor: { kind: parsed.actor_kind, id: parsed.actor },
    reason: parsed.reason,
    evidence_refs: finding.evidence_refs as KnowledgeHygieneEvidenceRefV1[],
    resolved_at: now.toISOString(),
  });
  if (!resolution.success) {
    return inputError(
      `invalid review resolution: ${resolution.error.issues.map((issue) => issue.message).join("; ")}`,
    );
  }
  return resolution.data;
}

export async function handleNeatReviewCommand(
  args: readonly string[],
  deps: NeatReviewCommandDependencies,
): Promise<0> {
  const parsed = parseReviewCommand(args, deps.cwd());
  if (parsed.help) {
    deps.stdout(renderNeatReviewHelp());
    return 0;
  }

  const report = parseReport(parseJson(
    await readRegularFile(parsed.report_path as string, "--report"),
    "--report",
  ));
  const outputPath = parsed.output_path as string;
  const existing = await readExistingArtifact(outputPath);
  try {
    if (existing) assertKnowledgeHygieneReviewArtifactMatchesReport(report, existing);
  } catch (error) {
    if (error instanceof KnowledgeHygieneReviewError) return inputError(error.message);
    throw error;
  }

  const resolution = createResolution(parsed, report, deps.now());
  const replaced = existing?.resolutions.some(
    (candidate) => candidate.fingerprint === resolution.fingerprint,
  ) ?? false;
  const resolutions = [
    ...(existing?.resolutions.filter(
      (candidate) => candidate.fingerprint !== resolution.fingerprint,
    ) ?? []),
    resolution,
  ].sort((left, right) => left.fingerprint.localeCompare(right.fingerprint));
  const artifact = KnowledgeHygieneReviewArtifactV1.parse({
    schema_version: "1",
    diff_id: resolution.diff_id,
    resolutions,
  });
  assertKnowledgeHygieneReviewArtifactMatchesReport(report, artifact);
  const serialized = `${JSON.stringify(artifact, null, 2)}\n`;

  await writeAtomic(outputPath, serialized);
  deps.stdout(`${replaced ? "replaced" : "created"} ${parsed.output_label}`);
  return 0;
}
