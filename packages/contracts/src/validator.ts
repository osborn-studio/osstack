import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import type {
  ContractEndpoint,
  ContractFinding,
  ContractHttpMethod,
  ContractManifest,
  ContractSourceUsage,
  ContractValidationReport,
} from "./types.js";

const DEFAULT_MANIFEST = "osstack.contracts.json";
const SOURCE_EXTENSIONS = new Set([".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs"]);
const IGNORED_DIRS = new Set([".git", "node_modules", "dist", "build", "coverage", ".next", ".turbo"]);
const METHODS: ContractHttpMethod[] = ["GET", "POST", "PUT", "PATCH", "DELETE"];

export async function validateWorkspaceContracts(options: {
  workspacePath: string;
  manifestPath?: string;
  now?: string | Date;
}): Promise<ContractValidationReport> {
  const workspacePath = resolve(options.workspacePath);
  const manifestPath = resolve(workspacePath, options.manifestPath ?? DEFAULT_MANIFEST);
  const manifest = validateContractManifest(JSON.parse(await readFile(manifestPath, "utf-8")));
  const files = await collectSourceFiles(workspacePath);
  const usages: ContractSourceUsage[] = [];
  for (const file of files) {
    usages.push(...extractContractUsages(await readFile(file, "utf-8"), file));
  }
  const frontendCalls = usages.filter((usage) => isFrontendCall(usage.evidence));
  const backendRoutes = usages.filter((usage) => isBackendRoute(usage.evidence));
  const findings = validateEndpointCoverage(manifest.endpoints, frontendCalls, backendRoutes);
  const checkedAt = options.now instanceof Date
    ? options.now.toISOString()
    : options.now ?? new Date().toISOString();
  return {
    schema_version: 1,
    kind: "osstack.contract_validation",
    status: findings.some((finding) => finding.severity === "error") ? "fail" : "pass",
    service: manifest.service,
    manifest_path: manifestPath,
    workspace_path: workspacePath,
    checked_at: checkedAt,
    endpoints: manifest.endpoints.length,
    frontend_calls: frontendCalls,
    backend_routes: backendRoutes,
    findings,
  };
}

export function validateContractManifest(value: unknown): ContractManifest {
  if (!isRecord(value)) throw new Error("contract manifest must be an object");
  const schemaVersion = requiredNumber(value, "schema_version");
  if (schemaVersion !== 1) throw new Error("contract manifest schema_version must be 1");
  const kind = requiredString(value, "kind");
  if (kind !== "osstack.contract_manifest") throw new Error("contract manifest kind must be osstack.contract_manifest");
  const service = requiredString(value, "service");
  const endpointsRaw = value["endpoints"];
  if (!Array.isArray(endpointsRaw) || endpointsRaw.length === 0) {
    throw new Error("contract manifest endpoints must be a non-empty array");
  }
  const seen = new Set<string>();
  const endpoints = endpointsRaw.map((endpoint, index) => {
    if (!isRecord(endpoint)) throw new Error(`contract endpoint at index ${index} must be an object`);
    const normalized = validateContractEndpoint(endpoint, index);
    const key = endpointKey(normalized.method, normalized.path);
    if (seen.has(key)) throw new Error(`contract endpoint duplicate method/path: ${normalized.method} ${normalized.path}`);
    seen.add(key);
    return normalized;
  });
  return {
    schema_version: 1,
    kind: "osstack.contract_manifest",
    service,
    endpoints,
  };
}

export function extractContractUsages(text: string, file: string): ContractSourceUsage[] {
  const usages: ContractSourceUsage[] = [];
  const lines = text.split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    usages.push(...extractFetchUsages(line, file, index + 1));
    usages.push(...extractRouteUsages(line, file, index + 1));
  }
  return usages;
}

async function collectSourceFiles(dir: string): Promise<string[]> {
  const files: string[] = [];
  await collectSourceFilesInto(dir, files);
  return files.sort();
}

async function collectSourceFilesInto(dir: string, files: string[]): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!IGNORED_DIRS.has(entry.name)) await collectSourceFilesInto(path, files);
      continue;
    }
    if (!entry.isFile()) continue;
    const pathStat = await stat(path);
    if (pathStat.size > 1_000_000) continue;
    const extension = path.slice(path.lastIndexOf("."));
    if (SOURCE_EXTENSIONS.has(extension)) files.push(path);
  }
}

function validateContractEndpoint(value: Record<string, unknown>, index: number): ContractEndpoint {
  const id = requiredString(value, "id");
  const method = normalizeMethod(requiredString(value, "method"));
  const path = normalizePath(requiredString(value, "path"), `contract endpoint ${index}`);
  const owner = optionalString(value, "owner");
  return {
    id,
    method,
    path,
    ...(owner === undefined ? {} : { owner }),
  };
}

function validateEndpointCoverage(
  endpoints: ContractEndpoint[],
  frontendCalls: ContractSourceUsage[],
  backendRoutes: ContractSourceUsage[],
): ContractFinding[] {
  const findings: ContractFinding[] = [];
  const backendKeys = new Set(backendRoutes.map((route) => endpointKey(route.method, route.path)));
  const frontendKeys = new Set(frontendCalls.map((call) => endpointKey(call.method, call.path)));
  for (const endpoint of endpoints) {
    const key = endpointKey(endpoint.method, endpoint.path);
    const hasFrontendCall = frontendKeys.has(key);
    const hasBackendRoute = backendKeys.has(key);
    if (hasFrontendCall && !hasBackendRoute) {
      findings.push({
        rule_id: "contract.missing_backend",
        severity: "error",
        kind: "missing_backend",
        endpoint_id: endpoint.id,
        method: endpoint.method,
        path: endpoint.path,
        message: `Frontend calls ${endpoint.method} ${endpoint.path}, but no matching backend route was found.`,
      });
    }
    if (!hasFrontendCall && hasBackendRoute) {
      findings.push({
        rule_id: "contract.unused_endpoint",
        severity: "warning",
        kind: "unused_endpoint",
        endpoint_id: endpoint.id,
        method: endpoint.method,
        path: endpoint.path,
        message: `Backend route ${endpoint.method} ${endpoint.path} is declared but no matching frontend call was found.`,
      });
    }
  }
  return findings;
}

function extractFetchUsages(line: string, file: string, lineNumber: number): ContractSourceUsage[] {
  const usages: ContractSourceUsage[] = [];
  const fetchPattern = /\bfetch\s*\(\s*["'`]([^"'`]+)["'`](?:\s*,\s*({[^)]*}))?/g;
  let match = fetchPattern.exec(line);
  while (match !== null) {
    const path = normalizeMaybeApiPath(match[1]);
    if (path !== undefined) {
      const method = extractFetchMethod(match[2] ?? "");
      usages.push({
        method,
        path,
        file,
        line: lineNumber,
        evidence: line.trim(),
      });
    }
    match = fetchPattern.exec(line);
  }
  return usages;
}

function extractRouteUsages(line: string, file: string, lineNumber: number): ContractSourceUsage[] {
  const usages: ContractSourceUsage[] = [];
  const routePattern = /\b(?:app|router|server|fastify)\s*\.\s*(get|post|put|patch|delete)\s*\(\s*["'`]([^"'`]+)["'`]/gi;
  let match = routePattern.exec(line);
  while (match !== null) {
    const methodRaw = match[1];
    const pathRaw = match[2];
    if (methodRaw !== undefined && pathRaw !== undefined) {
      const path = normalizeMaybeApiPath(pathRaw);
      if (path !== undefined) {
        usages.push({
          method: normalizeMethod(methodRaw),
          path,
          file,
          line: lineNumber,
          evidence: line.trim(),
        });
      }
    }
    match = routePattern.exec(line);
  }
  return usages;
}

function extractFetchMethod(optionsText: string): ContractHttpMethod {
  const methodMatch = /\bmethod\s*:\s*["'`](GET|POST|PUT|PATCH|DELETE)["'`]/i.exec(optionsText);
  if (methodMatch?.[1] === undefined) return "GET";
  return normalizeMethod(methodMatch[1]);
}

function normalizeMaybeApiPath(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (!value.startsWith("/")) return undefined;
  return normalizePath(value, "source usage");
}

function normalizePath(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed.startsWith("/")) throw new Error(`${label} path must start with /`);
  return trimmed.length > 1 && trimmed.endsWith("/") ? trimmed.slice(0, -1) : trimmed;
}

function normalizeMethod(value: string): ContractHttpMethod {
  const method = value.toUpperCase();
  if (!METHODS.includes(method as ContractHttpMethod)) {
    throw new Error(`contract endpoint method is invalid: ${value}`);
  }
  return method as ContractHttpMethod;
}

function endpointKey(method: ContractHttpMethod, path: string): string {
  return `${method} ${path}`;
}

function isFrontendCall(evidence: string): boolean {
  return /\bfetch\s*\(/.test(evidence);
}

function isBackendRoute(evidence: string): boolean {
  return /\b(?:app|router|server|fastify)\s*\./i.test(evidence);
}

function requiredString(value: Record<string, unknown>, key: string): string {
  const raw = value[key];
  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw new Error(`contract manifest ${key} must be a non-empty string`);
  }
  return raw.trim();
}

function optionalString(value: Record<string, unknown>, key: string): string | undefined {
  const raw = value[key];
  if (raw === undefined) return undefined;
  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw new Error(`contract manifest ${key} must be a non-empty string when provided`);
  }
  return raw.trim();
}

function requiredNumber(value: Record<string, unknown>, key: string): number {
  const raw = value[key];
  if (typeof raw !== "number") throw new Error(`contract manifest ${key} must be a number`);
  return raw;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function relativeContractUsage(report: ContractValidationReport): ContractValidationReport {
  const relativize = (usage: ContractSourceUsage): ContractSourceUsage => ({
    ...usage,
    file: relative(report.workspace_path, usage.file),
  });
  return {
    ...report,
    manifest_path: relative(report.workspace_path, report.manifest_path),
    frontend_calls: report.frontend_calls.map(relativize),
    backend_routes: report.backend_routes.map(relativize),
  };
}
