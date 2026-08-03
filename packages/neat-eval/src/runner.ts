import { createHash } from "node:crypto";
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { spawn } from "node:child_process";
import { z } from "zod";
import {
  HiddenExecutionBundleV1,
  type DevelopmentCorpusV1,
  type ParityProtocolV1,
} from "./types.js";
import { ParityEvaluationRunV1Schema, type ParityEvaluationRunV1 } from "./scorer.js";
import { hashFrozenBaselineBundleV1 } from "./corpus.js";

const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);

export const ExternalParityAdapterV1 = z.object({
  schema_version: z.literal("1"),
  adapter_id: z.string().min(1),
  arm: z.enum(["A", "B"]),
  model_family: z.enum(["primary", "secondary"]),
  model_id: z.string().min(1),
  executable: z.string().min(1),
  args: z.array(z.string()),
  env_allowlist: z.array(z.string().regex(/^[A-Z][A-Z0-9_]*$/u)),
  budget: z.object({
    max_input_tokens: z.number().int().positive(),
    max_output_tokens: z.number().int().positive(),
    max_calls: z.number().int().positive(),
    max_wall_clock_ms: z.number().int().min(1_000).max(3_600_000),
  }).strict(),
  isolation: z.object({
    kind: z.enum(["container_network_none", "provider_proxy_only"]),
    profile_sha256: sha256,
    attested_by: z.string().min(1),
  }).strict(),
}).strict().superRefine((adapter, context) => {
  if (!isAbsolute(adapter.executable)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["executable"],
      message: "external parity executable must be absolute",
    });
  }
  if (new Set(adapter.env_allowlist).size !== adapter.env_allowlist.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["env_allowlist"],
      message: "environment allowlist entries must be unique",
    });
  }
  const forbidden = new Set([
    "HOME",
    "CODEX_HOME",
    "CLAUDE_CONFIG_DIR",
    "NODE_OPTIONS",
    "OSSTACK_AUTOAPPROVE",
  ]);
  if (adapter.env_allowlist.some((name) => forbidden.has(name))) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["env_allowlist"],
      message: "environment allowlist contains a forbidden authority or injection variable",
    });
  }
});
export type ExternalParityAdapterV1 = z.infer<typeof ExternalParityAdapterV1>;

const externalOutput = z.object({
  schema_version: z.literal("1"),
  findings: z.array(z.object({
    finding_key: z.string().min(1),
    dimension: z.string().min(1),
    paths: z.array(z.string().min(1)).min(1),
  }).strict()),
  coverage: z.array(z.object({
    dimension: z.string().min(1),
    status: z.enum(["complete", "partial", "not_assessed", "failed", "budget_exhausted"]),
  }).strict()),
  rejection_counts: z.record(z.number().int().nonnegative()),
  tokens: z.number().int().nonnegative(),
  calls: z.number().int().nonnegative(),
  plan: z.string(),
  diff: z.string(),
  approval_receipt: z.object({
    actor: z.literal("eval-harness"),
    evaluation_only: z.literal(true),
    plan_id: z.string().min(1),
  }).strict().optional(),
}).strict();

export const ExternalParityArtifactV1Schema = z.object({
  run_id: z.string().min(1),
  coverage: z.array(z.object({
    dimension: z.string().min(1),
    status: z.enum(["complete", "partial", "not_assessed", "failed", "budget_exhausted"]),
  }).strict()),
  rejection_counts: z.record(z.number().int().nonnegative()),
  plan_sha256: sha256.optional(),
  diff_sha256: sha256.optional(),
  diff: z.string(),
}).strict();
export type ExternalParityArtifactV1 = z.infer<typeof ExternalParityArtifactV1Schema>;

export interface ExternalParityCaseResultV1 {
  run: ParityEvaluationRunV1;
  artifact: ExternalParityArtifactV1;
}

export interface ExternalParityMatrixResultV1 {
  schema_version: "1";
  bundle_id: string;
  runs: ParityEvaluationRunV1[];
  artifacts: ExternalParityArtifactV1[];
}

const ExternalParityMatrixResultV1Schema = z.object({
  schema_version: z.literal("1"),
  bundle_id: z.string().min(1),
  runs: z.array(ParityEvaluationRunV1Schema),
  artifacts: z.array(ExternalParityArtifactV1Schema),
}).strict();

export function parseExternalParityMatrixResultV1(value: unknown): ExternalParityMatrixResultV1 {
  return ExternalParityMatrixResultV1Schema.parse(value);
}

export interface BlindDiffPacketV1 {
  schema_version: "1";
  bundle_id: string;
  pairs: Array<{
    pair_id: string;
    case_id: string;
    model_family: "primary" | "secondary";
    repetition: number;
    left_diff: string;
    right_diff: string;
  }>;
}

export interface BlindDiffKeyV1 {
  schema_version: "1";
  bundle_id: string;
  pairs: Array<{
    pair_id: string;
    left_arm: "A" | "B";
    right_arm: "A" | "B";
    left_run_id: string;
    right_run_id: string;
  }>;
}

function digest(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function boundedFailureReason(result: { code: number; stdout: string; stderr: string }): string {
  const text = result.stderr.trim() || result.stdout.trim() || `process exited ${result.code}`;
  return text.replaceAll(/[\r\n\t]+/gu, " ").slice(0, 512);
}

export async function hashSnapshotTreeV1(root: string): Promise<string> {
  const authority = await realpath(root);
  const entries: Array<{ path: string; mode: number; sha256: string }> = [];
  let totalBytes = 0;
  async function visit(directory: string): Promise<void> {
    for (const name of (await readdir(directory)).sort()) {
      const absolute = join(directory, name);
      const stats = await lstat(absolute);
      const portable = relative(authority, absolute).split("\\").join("/");
      if (stats.isSymbolicLink() || (!stats.isDirectory() && !stats.isFile())) {
        throw new Error(`hidden snapshot contains unsupported entry: ${portable}`);
      }
      if (stats.isDirectory()) {
        await visit(absolute);
        continue;
      }
      if (stats.nlink !== 1) throw new Error(`hidden snapshot contains hard-linked file: ${portable}`);
      if (entries.length >= 10_000) throw new Error("hidden snapshot exceeds 10000 files");
      if (stats.size > 16 * 1024 * 1024) throw new Error(`hidden snapshot file exceeds 16 MiB: ${portable}`);
      totalBytes += stats.size;
      if (totalBytes > 128 * 1024 * 1024) throw new Error("hidden snapshot exceeds 128 MiB");
      entries.push({
        path: portable,
        mode: stats.mode & 0o777,
        sha256: digest(await readFile(absolute)),
      });
    }
  }
  await visit(authority);
  return digest(JSON.stringify(entries));
}

function allowedEnvironment(names: readonly string[]): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const name of ["PATH", "LANG", "LC_ALL", ...names]) {
    const value = process.env[name];
    if (value !== undefined) environment[name] = value;
  }
  return environment;
}

async function runProcess(input: {
  executable: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeout_ms: number;
}): Promise<{ stdout: string; stderr: string; code: number; elapsed_ms: number }> {
  const started = Date.now();
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(input.executable, input.args, {
      cwd: input.cwd,
      env: input.env,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (Buffer.byteLength(stdout, "utf8") > 8 * 1024 * 1024) child.kill("SIGKILL");
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
      if (Buffer.byteLength(stderr, "utf8") > 2 * 1024 * 1024) child.kill("SIGKILL");
    });
    child.once("error", reject);
    const timeout = setTimeout(() => child.kill("SIGKILL"), input.timeout_ms);
    child.once("close", (code) => {
      clearTimeout(timeout);
      resolvePromise({
        stdout,
        stderr,
        code: code ?? 3,
        elapsed_ms: Date.now() - started,
      });
    });
  });
}

export async function runExternalParityCaseV1(input: {
  adapter: ExternalParityAdapterV1;
  case_id: string;
  rot_root: string;
  baseline_path: string;
  repetition: number;
  expected_baseline_sha256?: string;
  expected_snapshot_sha256?: string;
}): Promise<ExternalParityCaseResultV1> {
  const adapter = ExternalParityAdapterV1.parse(input.adapter);
  const executable = await realpath(adapter.executable);
  const disposable = await mkdtemp(join(tmpdir(), "osstack-neat-parity-arm-"));
  try {
    const workspace = join(disposable, "workspace");
    await cp(input.rot_root, workspace, { recursive: true, dereference: false });
    if (
      input.expected_snapshot_sha256 !== undefined
      && await hashSnapshotTreeV1(workspace) !== input.expected_snapshot_sha256
    ) {
      throw new Error(`hidden snapshot commitment mismatch for ${input.case_id}`);
    }
    const baselineStats = await lstat(input.baseline_path);
    let frozenBaselineRoot: string;
    let frozenBaseline: string;
    let observedBaselineSha256: string;
    if (baselineStats.isDirectory()) {
      frozenBaselineRoot = join(disposable, "frozen-baseline");
      await cp(input.baseline_path, frozenBaselineRoot, {
        recursive: true,
        dereference: false,
      });
      observedBaselineSha256 = (await hashFrozenBaselineBundleV1(frozenBaselineRoot)).bundle_sha256;
      frozenBaseline = join(frozenBaselineRoot, "SKILL.md");
      if (!(await lstat(frozenBaseline)).isFile()) {
        throw new Error("frozen baseline bundle is missing SKILL.md");
      }
    } else if (baselineStats.isFile()) {
      frozenBaselineRoot = join(disposable, "frozen-baseline");
      await mkdir(frozenBaselineRoot, { mode: 0o700 });
      frozenBaseline = join(frozenBaselineRoot, "SKILL.md");
      await writeFile(frozenBaseline, await readFile(input.baseline_path), {
        encoding: "utf8",
        mode: 0o600,
      });
      observedBaselineSha256 = digest(await readFile(frozenBaseline));
    } else {
      throw new Error("frozen baseline must be a file or directory");
    }
    if (
      input.expected_baseline_sha256 !== undefined
      && observedBaselineSha256 !== input.expected_baseline_sha256
    ) {
      throw new Error(
        `frozen baseline commitment mismatch: expected ${input.expected_baseline_sha256}, received ${observedBaselineSha256}`,
      );
    }
    const requestPath = join(disposable, "request.json");
    await writeFile(requestPath, `${JSON.stringify({
      schema_version: "1",
      arm: adapter.arm,
      case_id: input.case_id,
      workspace,
      baseline_path: frozenBaseline,
      baseline_root: frozenBaselineRoot,
      budget: adapter.budget,
      labels_available: false,
    }, null, 2)}\n`, "utf8");
    const args = adapter.args.map((argument) => argument
      .replaceAll("{request}", requestPath)
      .replaceAll("{workspace}", workspace)
      .replaceAll("{baseline}", frozenBaseline));
    const result = await runProcess({
      executable,
      args,
      cwd: disposable,
      env: allowedEnvironment(adapter.env_allowlist),
      timeout_ms: adapter.budget.max_wall_clock_ms,
    });
    const runId = `${adapter.arm}-${input.case_id}-${adapter.model_family}-${input.repetition}`;
    if (result.code !== 0) {
      return { run: {
        arm: adapter.arm,
        case_id: input.case_id,
        run_id: runId,
        repetition: input.repetition,
        model_family: adapter.model_family,
        detected_defect_ids: [],
        false_positive_ids: [],
        finding_keys: [],
        failure: true,
        failure_reason: boundedFailureReason(result),
        tokens: 0,
        calls: 0,
        wall_clock_ms: result.elapsed_ms,
      }, artifact: {
        run_id: runId,
        coverage: [],
        rejection_counts: {},
        diff: "",
      } };
    }
    const output = externalOutput.parse(JSON.parse(result.stdout));
    if (
      output.tokens > adapter.budget.max_input_tokens + adapter.budget.max_output_tokens
      || output.calls > adapter.budget.max_calls
    ) {
      throw new Error("external parity adapter exceeded its preregistered budget");
    }
    if (adapter.arm === "B" && output.diff.length > 0 && output.approval_receipt === undefined) {
      throw new Error("B-arm edit requires an evaluation-only approval receipt");
    }
    const findingKeys = output.findings.map((finding) => finding.finding_key);
    return { run: {
      arm: adapter.arm,
      case_id: input.case_id,
      run_id: runId,
      repetition: input.repetition,
      model_family: adapter.model_family,
      detected_defect_ids: [],
      false_positive_ids: [],
      finding_keys: [...new Set(findingKeys)].sort(),
      failure: false,
      tokens: output.tokens,
      calls: output.calls,
      wall_clock_ms: result.elapsed_ms,
    }, artifact: {
      run_id: runId,
      coverage: output.coverage,
      rejection_counts: output.rejection_counts,
      ...(output.plan.length === 0 ? {} : { plan_sha256: digest(output.plan) }),
      ...(output.diff.length === 0 ? {} : { diff_sha256: digest(output.diff) }),
      diff: output.diff,
    } };
  } finally {
    await rm(disposable, { recursive: true, force: true });
  }
}

export function validateExternalAdapterMatrixV1(
  adapters: readonly ExternalParityAdapterV1[],
  protocol: ParityProtocolV1,
): Map<string, ExternalParityAdapterV1> {
  if (protocol.primary_model_id === null || protocol.secondary_model_id === null) {
    throw new Error("protocol model ids must be frozen before external runs");
  }
  const expected = new Map([
    ["A/primary", protocol.primary_model_id],
    ["B/primary", protocol.primary_model_id],
    ["A/secondary", protocol.secondary_model_id],
    ["B/secondary", protocol.secondary_model_id],
  ]);
  const matrix = new Map<string, ExternalParityAdapterV1>();
  for (const raw of adapters) {
    const adapter = ExternalParityAdapterV1.parse(raw);
    const key = `${adapter.arm}/${adapter.model_family}`;
    if (matrix.has(key)) throw new Error(`duplicate external adapter ${key}`);
    const modelId = expected.get(key);
    if (modelId === undefined) throw new Error(`unexpected external adapter ${key}`);
    if (adapter.model_id !== modelId) throw new Error(`model mismatch for ${key}`);
    if (JSON.stringify(adapter.budget) !== JSON.stringify(protocol.budgets)) {
      throw new Error(`budget mismatch for ${key}`);
    }
    matrix.set(key, adapter);
  }
  for (const key of expected.keys()) {
    if (!matrix.has(key)) throw new Error(`missing external adapter ${key}`);
  }
  return new Map([...expected.keys()].map((key) => [key, matrix.get(key)!]));
}

export async function runExternalParityMatrixV1(input: {
  bundle: unknown;
  bundle_path: string;
  baseline_path: string;
  adapters: readonly ExternalParityAdapterV1[];
  protocol: ParityProtocolV1;
}): Promise<ExternalParityMatrixResultV1> {
  const bundle = HiddenExecutionBundleV1.parse(input.bundle);
  const matrix = validateExternalAdapterMatrixV1(input.adapters, input.protocol);
  const bundleRoot = await realpath(resolve(input.bundle_path, ".."));
  const runs: ParityEvaluationRunV1[] = [];
  const artifacts: ExternalParityArtifactV1[] = [];
  for (const caseEntry of bundle.cases) {
    const rotRoot = await realpath(resolve(bundleRoot, caseEntry.rot_root));
    const fromAuthority = relative(bundleRoot, rotRoot);
    if (fromAuthority === "" || fromAuthority === ".." || fromAuthority.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(fromAuthority)) {
      throw new Error(`hidden snapshot escapes bundle authority: ${caseEntry.case_id}`);
    }
    if (await hashSnapshotTreeV1(rotRoot) !== caseEntry.snapshot_sha256) {
      throw new Error(`hidden snapshot commitment mismatch for ${caseEntry.case_id}`);
    }
    for (const [key, adapter] of matrix) {
      const repetitions = key.endsWith("/primary") ? 3 : 2;
      for (let repetition = 1; repetition <= repetitions; repetition += 1) {
        const result = await runExternalParityCaseV1({
          adapter,
          case_id: caseEntry.case_id,
          rot_root: rotRoot,
          baseline_path: input.baseline_path,
          repetition,
          expected_baseline_sha256: input.protocol.baseline.sha256,
          expected_snapshot_sha256: caseEntry.snapshot_sha256,
        });
        runs.push(result.run);
        artifacts.push(result.artifact);
      }
    }
  }
  return { schema_version: "1", bundle_id: bundle.bundle_id, runs, artifacts };
}

export function blindExternalDiffsV1(
  result: ExternalParityMatrixResultV1,
  seed: number,
): { packet: BlindDiffPacketV1; key: BlindDiffKeyV1 } {
  const artifacts = new Map(result.artifacts.map((entry) => [entry.run_id, entry]));
  const packet: BlindDiffPacketV1 = { schema_version: "1", bundle_id: result.bundle_id, pairs: [] };
  const key: BlindDiffKeyV1 = { schema_version: "1", bundle_id: result.bundle_id, pairs: [] };
  const aRuns = result.runs.filter((run) => run.arm === "A");
  for (const aRun of aRuns) {
    if (aRun.model_family === "deterministic") throw new Error("A run cannot be deterministic");
    const bRun = result.runs.find((candidate) =>
      candidate.arm === "B"
      && candidate.case_id === aRun.case_id
      && candidate.model_family === aRun.model_family
      && candidate.repetition === aRun.repetition
    );
    if (bRun === undefined) throw new Error(`missing B pair for ${aRun.run_id}`);
    const aArtifact = artifacts.get(aRun.run_id);
    const bArtifact = artifacts.get(bRun.run_id);
    if (aArtifact === undefined || bArtifact === undefined) {
      throw new Error(`missing diff artifact for ${aRun.run_id}`);
    }
    const identity = `${result.bundle_id}|${aRun.case_id}|${aRun.model_family}|${aRun.repetition}`;
    const pairId = `pair_${digest(identity).slice(0, 20)}`;
    const aFirst = Number.parseInt(digest(`${seed}|${identity}`).slice(0, 2), 16) % 2 === 0;
    packet.pairs.push({
      pair_id: pairId,
      case_id: aRun.case_id,
      model_family: aRun.model_family,
      repetition: aRun.repetition,
      left_diff: aFirst ? aArtifact.diff : bArtifact.diff,
      right_diff: aFirst ? bArtifact.diff : aArtifact.diff,
    });
    key.pairs.push({
      pair_id: pairId,
      left_arm: aFirst ? "A" : "B",
      right_arm: aFirst ? "B" : "A",
      left_run_id: aFirst ? aRun.run_id : bRun.run_id,
      right_run_id: aFirst ? bRun.run_id : aRun.run_id,
    });
  }
  packet.pairs.sort((left, right) => left.pair_id.localeCompare(right.pair_id));
  key.pairs.sort((left, right) => left.pair_id.localeCompare(right.pair_id));
  if (packet.pairs.length !== result.runs.filter((run) => run.arm === "B").length) {
    throw new Error("unpaired B runs remain in matrix result");
  }
  return { packet, key };
}

function normalizedMechanicalOutput(value: unknown): {
  findings: Array<{ rule_id?: string; location?: { path?: string }; fingerprint?: string }>;
} {
  const envelope = value as {
    result?: { report?: { findings?: Array<{
      rule_id?: string;
      location?: { path?: string };
      fingerprint?: string;
    }> } };
  };
  return { findings: envelope.result?.report?.findings ?? [] };
}

export async function runMechanicalControlV1(input: {
  corpus: DevelopmentCorpusV1;
  materialized_root: string;
  cli_entry: string;
}): Promise<{
  runs: ParityEvaluationRunV1[];
  reproducible: boolean;
  result_sha256: string;
}> {
  const cliEntry = await realpath(resolve(input.cli_entry));
  const runs: ParityEvaluationRunV1[] = [];
  for (const caseEntry of input.corpus.cases) {
    const rotRoot = join(input.materialized_root, "cases", caseEntry.case_id, "rot");
    for (let repetition = 1; repetition <= 2; repetition += 1) {
      const result = await runProcess({
        executable: process.execPath,
        args: [
          cliEntry,
          "neat",
          "check",
          "--repo",
          rotRoot,
          "--all",
          "--schema-version",
          "2",
          "--format",
          "json",
          "--fail-on",
          "none",
        ],
        cwd: rotRoot,
        env: allowedEnvironment([]),
        timeout_ms: 30_000,
      });
      let findings: ReturnType<typeof normalizedMechanicalOutput>["findings"] = [];
      let failed = result.code !== 0 && result.code !== 1;
      let failureReason = failed ? boundedFailureReason(result) : undefined;
      if (!failed) {
        try {
          findings = normalizedMechanicalOutput(JSON.parse(result.stdout)).findings;
        } catch (error) {
          failed = true;
          failureReason = `invalid CLI JSON: ${error instanceof Error ? error.message : String(error)}`.slice(0, 512);
        }
      }
      const detected = caseEntry.defects.filter((defect) => findings.some((finding) =>
        defect.expected_rule_ids.includes(finding.rule_id ?? "")
        && (finding.location?.path === undefined
          || defect.paths.includes(finding.location.path))
      )).map((defect) => defect.defect_id).sort();
      const expectedRules = new Set(caseEntry.defects.flatMap((defect) =>
        defect.expected_rule_ids
      ));
      const falsePositives = findings.filter((finding) =>
        !expectedRules.has(finding.rule_id ?? "")
      ).map((finding) => finding.fingerprint ?? digest(JSON.stringify(finding)));
      runs.push({
        arm: "C",
        case_id: caseEntry.case_id,
        run_id: `C-${caseEntry.case_id}-${repetition}`,
        repetition,
        model_family: "deterministic",
        detected_defect_ids: detected,
        false_positive_ids: falsePositives.sort(),
        finding_keys: findings.map((finding) =>
          `${finding.rule_id ?? "unknown"}:${finding.location?.path ?? "unknown"}:${finding.fingerprint ?? ""}`
        ).sort(),
        failure: failed,
        ...(failureReason === undefined ? {} : { failure_reason: failureReason }),
        tokens: 0,
        calls: 0,
        wall_clock_ms: result.elapsed_ms,
      });
    }
  }
  const reproducible = input.corpus.cases.every((caseEntry) => {
    const caseRuns = runs.filter((run) => run.case_id === caseEntry.case_id);
    return caseRuns.length === 2
      && !caseRuns.some((run) => run.failure)
      && JSON.stringify({
        detected: caseRuns[0]!.detected_defect_ids,
        false_positives: caseRuns[0]!.false_positive_ids,
        findings: caseRuns[0]!.finding_keys,
      }) === JSON.stringify({
        detected: caseRuns[1]!.detected_defect_ids,
        false_positives: caseRuns[1]!.false_positive_ids,
        findings: caseRuns[1]!.finding_keys,
      });
  });
  return {
    runs,
    reproducible,
    result_sha256: digest(JSON.stringify(runs.map((run) => ({
      ...run,
      wall_clock_ms: 0,
    })))),
  };
}

export async function loadExternalAdapterV1(path: string): Promise<ExternalParityAdapterV1> {
  return ExternalParityAdapterV1.parse(JSON.parse(await readFile(path, "utf8")));
}

export function externalAdapterDisplayNameV1(adapter: ExternalParityAdapterV1): string {
  return `${adapter.arm}/${adapter.model_family}/${adapter.model_id}/${basename(adapter.executable)}`;
}
