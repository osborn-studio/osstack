import { execFile } from "node:child_process";
import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import { promisify } from "node:util";
import {
  getCompliancePack,
  listCompliancePacks,
  renderComplianceReportFromProofDir,
} from "@osstack/compliance";
import {
  validateWorkspaceContracts,
  type ContractValidationReport,
} from "@osstack/contracts";
import { scanFiles } from "@osstack/governance";
import type { LoopReportLanguage } from "@osstack/loop";

const execFileAsync = promisify(execFile);

export interface AssuranceCommandDeps {
  cwd?: () => string;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
}

export async function handleGovernanceCommand(
  args: string[],
  deps: AssuranceCommandDeps = {},
): Promise<number> {
  const stdout = deps.stdout ?? console.log;
  const stderr = deps.stderr ?? console.error;
  const sub = args[0];
  if (sub === undefined || sub === "help" || args.includes("--help") || args.includes("-h")) {
    stdout(`osstack governance — deterministic run governance checks

  osstack govern check [path...] [--workspace P] [--changed] [--json]
  osstack governance scan <path...> [--json]
`);
    return 0;
  }

  if (sub !== "scan" && sub !== "check") {
    stderr(`osstack: unknown governance subcommand "${sub}"`);
    return 1;
  }

  const paths = positionalValues(args.slice(1), new Set(["--workspace"]))
    .filter((value) => value !== sub);
  if (paths.length === 0) {
    if (sub === "scan") {
      stderr("osstack: governance scan requires at least one path");
      return 1;
    }
    const workspacePath = flagValue(args, "--workspace") ?? (deps.cwd ?? process.cwd)();
    const resolvedPaths = args.includes("--changed") || args.includes("--diff")
      ? await collectChangedGovernanceScanFiles(workspacePath)
      : await collectGovernanceScanFiles(workspacePath);
    if (resolvedPaths instanceof Error) {
      stderr(`osstack: ${resolvedPaths.message}`);
      return 1;
    }
    return await runGovernanceScan(resolvedPaths, args, stdout);
  }

  return await runGovernanceScan(paths, args, stdout);
}

async function runGovernanceScan(
  paths: string[],
  args: string[],
  stdout: (line: string) => void,
): Promise<number> {
  const result = await scanFiles(paths);
  const output = { ...result, scanned_files: paths };
  if (args.includes("--json")) {
    stdout(JSON.stringify(output, null, 2));
  } else {
    printGovernanceScan(result, stdout);
  }
  return result.ok ? 0 : 2;
}

function printGovernanceScan(
  result: Awaited<ReturnType<typeof scanFiles>>,
  stdout: (line: string) => void,
): void {
  if (result.findings.length === 0) {
    stdout("Governance scan clean.");
    return;
  }
  stdout(`Governance findings: ${result.findings.length}`);
  for (const finding of result.findings) {
    const location = finding.file === undefined
      ? `line ${finding.line}`
      : `${finding.file}:${finding.line}`;
    stdout(`- [${finding.severity}] ${finding.rule_id} ${location} - ${finding.message}`);
  }
}

export async function handleContractsCommand(
  args: string[],
  deps: AssuranceCommandDeps = {},
): Promise<number> {
  const stdout = deps.stdout ?? console.log;
  const stderr = deps.stderr ?? console.error;
  const sub = args[0];
  if (sub === undefined || sub === "help" || args.includes("--help") || args.includes("-h")) {
    stdout(`osstack contracts — frontend/backend API contract validation

  osstack contracts check [--workspace P] [--manifest P] [--json]

Contract manifest:
  osstack.contracts.json with kind=osstack.contract_manifest
`);
    return 0;
  }
  if (sub !== "check") {
    stderr(`osstack: unknown contracts subcommand "${sub}"`);
    return 1;
  }
  const workspacePath = flagValue(args, "--workspace") ?? (deps.cwd ?? process.cwd)();
  const manifestPath = flagValue(args, "--manifest");
  try {
    const report = await validateWorkspaceContracts({
      workspacePath,
      ...(manifestPath === undefined ? {} : { manifestPath }),
    });
    if (args.includes("--json")) {
      stdout(JSON.stringify(report, null, 2));
    } else {
      printContractValidation(report, stdout);
    }
    return report.status === "pass" ? 0 : 2;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (args.includes("--json")) {
      stdout(JSON.stringify({
        schema_version: 1,
        kind: "osstack.contract_validation",
        status: "fail",
        service: "unknown",
        workspace_path: resolve(workspacePath),
        manifest_path: manifestPath === undefined
          ? resolve(workspacePath, "osstack.contracts.json")
          : resolve(workspacePath, manifestPath),
        checked_at: new Date().toISOString(),
        endpoints: 0,
        frontend_calls: [],
        backend_routes: [],
        findings: [{
          rule_id: "contract.invalid_manifest",
          severity: "error",
          kind: "invalid_manifest",
          message,
        }],
      }, null, 2));
    } else {
      stderr(`osstack: ${message}`);
    }
    return 1;
  }
}

function printContractValidation(
  report: ContractValidationReport,
  stdout: (line: string) => void,
): void {
  stdout(`contract_validation=${report.status}`);
  stdout(`service=${report.service}`);
  stdout(`endpoints=${report.endpoints}`);
  stdout(`frontend_calls=${report.frontend_calls.length}`);
  stdout(`backend_routes=${report.backend_routes.length}`);
  for (const finding of report.findings) {
    stdout(`- [${finding.severity}] ${finding.rule_id} ${finding.method ?? "?"} ${finding.path ?? "?"} - ${finding.message}`);
  }
}

export async function handleComplianceCommand(
  args: string[],
  deps: AssuranceCommandDeps = {},
): Promise<number> {
  const stdout = deps.stdout ?? console.log;
  const stderr = deps.stderr ?? console.error;
  const sub = args[0];
  if (sub === undefined || sub === "help" || args.includes("--help") || args.includes("-h")) {
    stdout(`osstack compliance — evidence mapping reports

  osstack compliance list [--json]
  osstack compliance render <run_id> --pack engineering-readiness [--proof-dir P] [--workspace P] [--output P] [--lang en|zh-CN] [--json]

Notes:
  Compliance reports map osstack proof evidence to internal controls.
  They do not claim SOC 2, ISO 27001, EU AI Act, or third-party certification.
`);
    return 0;
  }

  if (sub === "list") {
    const packs = listCompliancePacks().map((pack) => ({
      id: pack.id,
      version: pack.version,
      name: pack.name,
      certification_claim: pack.certification_claim,
      controls: pack.controls.length,
    }));
    if (args.includes("--json")) {
      stdout(JSON.stringify({ packs }, null, 2));
    } else {
      for (const pack of packs) {
        stdout(`${pack.id}@${pack.version} ${pack.name} claim=${pack.certification_claim} controls=${pack.controls}`);
      }
    }
    return 0;
  }

  if (sub === "render") {
    const runId = firstPositionalValue(
      args.slice(1),
      new Set(["--pack", "--proof-dir", "--workspace", "--output", "--lang"]),
    );
    if (runId === undefined) {
      stderr("osstack: compliance render requires a run_id");
      return 1;
    }
    const packId = flagValue(args, "--pack");
    if (packId === undefined) {
      stderr("osstack: compliance render requires --pack");
      return 1;
    }
    let packVersion: string;
    try {
      packVersion = getCompliancePack(packId).version;
    } catch (error) {
      stderr(`osstack: ${error instanceof Error ? error.message : String(error)}`);
      return 1;
    }
    const workspacePath = flagValue(args, "--workspace") ?? (deps.cwd ?? process.cwd)();
    const proofDir = flagValue(args, "--proof-dir")
      ?? join(workspacePath, "release", `osstack-proof-${safeFileSegment(runId)}`);
    const output = flagValue(args, "--output")
      ?? join(workspacePath, "reports", `compliance-${packId}-${safeFileSegment(runId)}.md`);
    const language = resolveLanguage(flagValue(args, "--lang"));
    const markdown = await renderComplianceReportFromProofDir({
      packId,
      runId,
      proofDir,
      language,
    });
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, markdown, "utf-8");
    if (args.includes("--json")) {
      stdout(JSON.stringify({
        run_id: runId,
        pack_id: packId,
        pack_version: packVersion,
        output,
      }, null, 2));
    } else {
      stdout(`compliance=${output}`);
      stdout(`pack=${packId}@${packVersion}`);
    }
    return 0;
  }

  stderr(`osstack: unknown compliance subcommand "${sub}"`);
  return 1;
}

export async function collectGovernanceScanFiles(workspacePath: string): Promise<string[]> {
  const files: string[] = [];
  await collectGovernanceScanFilesInto(workspacePath, files);
  return files;
}

export async function collectChangedGovernanceScanFiles(
  workspacePath: string,
  baselineRevision?: string,
): Promise<string[] | Error> {
  try {
    const [workingTree, staged, sinceBaseline] = await Promise.all([
      execFileAsync(
        "git",
        ["-C", workspacePath, "ls-files", "--modified", "--others", "--exclude-standard"],
        { timeout: 10_000 },
      ),
      execFileAsync(
        "git",
        ["-C", workspacePath, "diff", "--name-only", "--cached", "--diff-filter=ACMRT"],
        { timeout: 10_000 },
      ),
      baselineRevision === undefined
        ? Promise.resolve({ stdout: "" })
        : execFileAsync(
            "git",
            ["-C", workspacePath, "diff", "--name-only", "--diff-filter=ACMRT", baselineRevision, "HEAD"],
            { timeout: 10_000 },
          ),
    ]);
    const relativePaths = uniqueNonEmptyLines(
      `${workingTree.stdout}\n${staged.stdout}\n${sinceBaseline.stdout}`,
    );
    const files: string[] = [];
    for (const relativePath of relativePaths) {
      if (!isGovernanceScannableFile(relativePath)) continue;
      const absolutePath = join(workspacePath, relativePath);
      if (await isRegularFile(absolutePath)) files.push(absolutePath);
    }
    return files;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return new Error(`could not collect changed files with git: ${message}`);
  }
}

export function uniqueNonEmptyLines(value: string): string[] {
  return [...new Set(
    value.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0),
  )];
}

async function isRegularFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function collectGovernanceScanFilesInto(dir: string, files: string[]): Promise<void> {
  if (files.length >= 500) return;
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (files.length >= 500) return;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (isGovernanceExcludedDir(entry.name)) continue;
      await collectGovernanceScanFilesInto(path, files);
      continue;
    }
    if (!entry.isFile()) continue;
    if (!isGovernanceScannableFile(entry.name)) continue;
    files.push(path);
  }
}

export function isGovernanceExcludedDir(name: string): boolean {
  return new Set([
    ".git",
    ".next",
    ".turbo",
    "coverage",
    "dist",
    "node_modules",
    "release",
    "reports",
    "tmp",
    "vendor",
  ]).has(name);
}

export function isGovernanceScannableFile(name: string): boolean {
  if (name === ".env") return true;
  return new Set([
    ".cjs",
    ".css",
    ".html",
    ".js",
    ".json",
    ".jsx",
    ".md",
    ".mjs",
    ".py",
    ".sh",
    ".sql",
    ".ts",
    ".tsx",
    ".yaml",
    ".yml",
  ]).has(extname(name));
}

function resolveLanguage(value = process.env["OSSTACK_LANG"]): LoopReportLanguage {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "zh-cn" || normalized === "zh" || normalized === "cn") return "zh-CN";
  return "en";
}

function safeFileSegment(value: string): string {
  return value.replaceAll(/[^a-zA-Z0-9._-]/g, "-");
}

function flagValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 && index + 1 < args.length ? args[index + 1] : undefined;
}

function firstPositionalValue(args: string[], flagsWithValues: Set<string>): string | undefined {
  return positionalValues(args, flagsWithValues)[0];
}

function positionalValues(args: string[], flagsWithValues: Set<string>): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === undefined) continue;
    if (flagsWithValues.has(value)) {
      index += 1;
      continue;
    }
    if (value.startsWith("--")) continue;
    values.push(value);
  }
  return values;
}
