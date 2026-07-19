import {
  assertKnowledgeHygieneReviewArtifactMatchesReport,
  knowledgeHygieneReportSha256V2,
  KnowledgeHygieneReportV1,
  KnowledgeHygieneReportV2,
  KnowledgeHygieneResolutionV1,
  KnowledgeHygieneResolutionEventV2,
  KnowledgeHygieneReviewArtifactV1,
  KnowledgeHygieneReviewArtifactV2,
  KnowledgeHygieneReviewError,
  type KnowledgeHygieneEvidenceRefV1,
  type KnowledgeHygieneReportV2 as KnowledgeHygieneReportV2Value,
} from "@osstack/governance";
import { AgentCommandResult } from "@osstack/protocol";
import { constants } from "node:fs";
import { open, rename, unlink, type FileHandle } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";

const outcomes = [
  "fixed",
  "mechanically_applied",
  "mechanically_resolved",
  "semantically_resolved",
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
  suppression_scope?: string;
  suppression_expires_at?: string;
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
  --outcome <outcome>            V1 outcome or explicit V2 lifecycle target
  --reason <text>                Required resolution rationale
  --actor <id>                   Human or agent identifier
  --actor-kind <human|agent>     Actor kind (default: human)
  --output <path>                Review artifact to create or update atomically
  --suppression-scope <scope>    Required for a V2 suppressed event
  --suppression-expires-at <ts>  Optional RFC 3339 V2 suppression expiry
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
      "--suppression-scope",
      "--suppression-expires-at",
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
    ...(values.get("--suppression-scope") === undefined
      ? {}
      : { suppression_scope: values.get("--suppression-scope") as string }),
    ...(values.get("--suppression-expires-at") === undefined
      ? {}
      : {
          suppression_expires_at: values.get("--suppression-expires-at") as string,
        }),
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

type ReviewableReport =
  | ReturnType<typeof KnowledgeHygieneReportV1.parse>
  | ReturnType<typeof KnowledgeHygieneReportV2.parse>;

function parseReviewableReport(value: unknown): ReviewableReport {
  const directV1 = KnowledgeHygieneReportV1.safeParse(value);
  if (directV1.success) return directV1.data;
  const directV2 = KnowledgeHygieneReportV2.safeParse(value);
  if (directV2.success) return directV2.data;
  const envelope = AgentCommandResult.safeParse(value);
  const command = envelope.success ? envelope.data.result?.command : undefined;
  const nestedReport = envelope.success ? envelope.data.result?.report : undefined;
  if (
    !envelope.success
    || envelope.data.status !== "ok"
    || (command !== "knowledge_hygiene.check"
      && command !== "knowledge_hygiene.semantic")
  ) {
    return inputError(
      "--report must contain a V1/V2 knowledge hygiene report or successful check/semantic envelope",
    );
  }
  const nestedV1 = KnowledgeHygieneReportV1.safeParse(nestedReport);
  if (nestedV1.success) return nestedV1.data;
  const nestedV2 = KnowledgeHygieneReportV2.safeParse(nestedReport);
  if (nestedV2.success) return nestedV2.data;
  return inputError("knowledge hygiene envelope contains an invalid V1/V2 report");
}

export async function loadNeatReport(
  path: string,
  label = "--report",
): Promise<KnowledgeHygieneReportV1> {
  return parseReport(parseJson(await readRegularFile(path, label), label));
}

async function loadNeatReportForReview(path: string): Promise<ReviewableReport> {
  return parseReviewableReport(
    parseJson(await readRegularFile(path, "--report"), "--report"),
  );
}

async function readExistingArtifact(
  path: string,
): Promise<
  | ReturnType<typeof KnowledgeHygieneReviewArtifactV1.parse>
  | ReturnType<typeof KnowledgeHygieneReviewArtifactV2.parse>
  | undefined
> {
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
    const v1 = KnowledgeHygieneReviewArtifactV1.safeParse(value);
    if (v1.success) return v1.data;
    const v2 = KnowledgeHygieneReviewArtifactV2.safeParse(value);
    if (v2.success) return v2.data;
    return inputError("existing --output is not a valid V1/V2 review artifact");
  } finally {
    await handle.close();
  }
}

export async function loadNeatReviewArtifact(
  path: string,
): Promise<
  | ReturnType<typeof KnowledgeHygieneReviewArtifactV1.parse>
  | ReturnType<typeof KnowledgeHygieneReviewArtifactV2.parse>
> {
  const value = parseJson(
    await readRegularFile(path, "--review-file"),
    "--review-file",
  );
  const v1 = KnowledgeHygieneReviewArtifactV1.safeParse(value);
  if (v1.success) return v1.data;
  const v2 = KnowledgeHygieneReviewArtifactV2.safeParse(value);
  if (v2.success) return v2.data;
  return inputError("--review-file is not a valid V1/V2 review artifact");
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

function createResolutionEventV2(
  parsed: ParsedReviewCommand,
  report: KnowledgeHygieneReportV2Value,
  existing: ReturnType<typeof KnowledgeHygieneReviewArtifactV2.parse> | undefined,
  now: Date,
) {
  const finding = [
    ...report.findings,
    ...(report.resolved_findings ?? []).map((item) => item.finding),
  ].find((candidate) => candidate.fingerprint === parsed.finding);
  if (finding === undefined) return inputError(`report has no finding ${parsed.finding}`);
  if (parsed.outcome === "fixed") {
    return inputError(
      "V2 review does not accept ambiguous 'fixed'; use an explicit lifecycle outcome",
    );
  }
  const prior = existing?.resolution_events.filter(
    (event) => event.fingerprint === finding.fingerprint,
  ).at(-1);
  const fromState = prior?.to_state ?? "open";
  const reportSha = knowledgeHygieneReportSha256V2(report);
  if (parsed.outcome === "suppressed" && parsed.suppression_scope === undefined) {
    return inputError("V2 suppressed events require --suppression-scope");
  }
  if (
    parsed.outcome !== "suppressed"
    && (parsed.suppression_scope !== undefined
      || parsed.suppression_expires_at !== undefined)
  ) {
    return inputError("suppression flags require --outcome suppressed");
  }
  const body = {
    schema_version: "2" as const,
    repo_id: report.repo.repo_id ?? report.repo.root,
    fingerprint: finding.fingerprint,
    from_state: fromState,
    to_state: parsed.outcome,
    actor: { kind: parsed.actor_kind, id: parsed.actor as string },
    reason: parsed.reason as string,
    evidence_refs: [{
      kind: "report" as const,
      ref: `inline-report:${reportSha}`,
      sha256: reportSha,
    }],
    occurred_at: now.toISOString(),
    ...(parsed.outcome !== "suppressed"
      ? {}
      : {
          suppression: {
            scope: parsed.suppression_scope as string,
            ...(parsed.suppression_expires_at === undefined
              ? {}
              : { expires_at: parsed.suppression_expires_at }),
          },
        }),
  };
  const event = KnowledgeHygieneResolutionEventV2.safeParse({
    ...body,
    event_id: `khev_${createHash("sha256").update(JSON.stringify(body)).digest("hex")}`,
  });
  if (!event.success) {
    return inputError(
      `invalid V2 lifecycle event: ${event.error.issues.map((issue) => issue.message).join("; ")}`,
    );
  }
  return event.data;
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

  const report = await loadNeatReportForReview(parsed.report_path as string);
  const outputPath = parsed.output_path as string;
  const existing = await readExistingArtifact(outputPath);
  if (report.schema_version === "2") {
    if (existing?.schema_version === "1") {
      return inputError("a V1 review artifact cannot be updated from a V2 report");
    }
    const reportSha = knowledgeHygieneReportSha256V2(report);
    if (
      existing !== undefined
      && (existing.report_sha256 !== reportSha
        || existing.repo_id !== (report.repo.repo_id ?? report.repo.root))
    ) {
      return inputError("existing V2 review artifact does not match the report");
    }
    const event = createResolutionEventV2(parsed, report, existing, deps.now());
    const artifact = KnowledgeHygieneReviewArtifactV2.parse({
      schema_version: "2",
      report_sha256: reportSha,
      repo_id: report.repo.repo_id ?? report.repo.root,
      resolution_events: [
        ...(existing?.resolution_events ?? []),
        event,
      ],
    });
    await writeAtomic(outputPath, `${JSON.stringify(artifact, null, 2)}\n`);
    deps.stdout(`created ${parsed.output_label}`);
    return 0;
  }
  if (existing?.schema_version === "2") {
    return inputError("a V2 review artifact cannot be updated from a V1 report");
  }
  if (
    parsed.suppression_scope !== undefined
    || parsed.suppression_expires_at !== undefined
  ) {
    return inputError("suppression metadata flags are available only for V2 reports");
  }
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
