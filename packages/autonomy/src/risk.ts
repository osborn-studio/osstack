import { createHash } from "node:crypto";
import {
  AutonomyRiskDecision,
  type AutonomyRiskLevel,
  type AutonomyRiskSignal,
} from "@osstack/protocol";
import {
  AutonomyTaskIntent,
  PostDiffInput,
} from "./types.js";

const RISK_ORDER: Readonly<Record<AutonomyRiskLevel, number>> = {
  R0: 0,
  R1: 1,
  R2: 2,
  R3: 3,
  R4: 4,
};

const READ_ONLY_ACTIONS = new Set([
  "analyze",
  "inspect",
  "read",
  "report",
  "review",
]);

const R3_PATH_RULES: ReadonlyArray<{
  ruleId: string;
  pattern: RegExp;
  message: string;
}> = [
  {
    ruleId: "risk.auth",
    pattern:
      /(^|\/)(?:auth|authentication|authorization|permissions?|login|logout|oauth|oidc|sso|sessions?|jwt|rbac|acl|iam)(?:\/|\.|$)/i,
    message: "authentication or authorization surface changed",
  },
  {
    ruleId: "risk.billing",
    pattern: /(^|\/)(billing|payments?)(\/|\.|$)/i,
    message: "billing or payment surface changed",
  },
  {
    ruleId: "risk.certificate",
    pattern: /\.(?:key|pem|p12|pfx|crt|cer)$/i,
    message: "certificate or private-key material path changed",
  },
  {
    ruleId: "risk.infrastructure",
    pattern: /(^|\/)(infra|terraform|pulumi|k8s|production)(\/|\.|$)/i,
    message: "infrastructure or production configuration changed",
  },
  {
    ruleId: "risk.migration",
    pattern: /(^|\/)(migrations?|schema)(\/|\.|$)/i,
    message: "database migration or schema surface changed",
  },
  {
    ruleId: "risk.policy",
    pattern: /^\.osstack\/(?:repo|policy)\.ya?ml$/i,
    message: "effective osstack repository policy changed",
  },
  {
    ruleId: "risk.secret",
    pattern:
      /(^|\/)(?:\.env(?:\.[^/]*)?|secrets?|credentials?|certs?)(?:\/|$)/i,
    message: "secret-bearing path changed",
  },
  {
    ruleId: "risk.workflow",
    pattern: /^\.github\/(?:workflows|actions)\//i,
    message: "GitHub workflow permissions or execution changed",
  },
];

const OSSTACK_TRUST_KERNEL_PATH =
  /^packages\/(?:(?:autonomy\/src\/(?:approval|core-persistence|engine|git-candidate|progress-budget|risk|state-machine|types|index))|(?:protocol\/src\/(?:autonomy|delivery-contract))|(?:knowledge\/src\/context-budget)|(?:github\/src\/delivery)|(?:cli\/src\/(?:autonomy-command|guarded-git-runtime|guarded-open-db|delivery-contract-host|deliver-command|execution-context))|(?:core\/src\/(?:delivery-contract|policy\/profile|state\/(?:autonomy-runs|contract-approvals|migrations|schema)))|(?:agents\/src\/adapters\/kimi-code)|(?:loop\/src\/(?:review-boundary|reviewer-isolation|loop-engine)))\.(?:ts|js)$/;

const SENSITIVE_PACKAGE_SCRIPTS = new Set([
  "build",
  "check",
  "ci",
  "install",
  "lint",
  "postinstall",
  "prepack",
  "prepare",
  "prepublishOnly",
  "test",
  "typecheck",
  "verify",
]);

const R4_TEXT_RULES: ReadonlyArray<{
  ruleId: string;
  pattern: RegExp;
  message: string;
}> = [
  {
    ruleId: "risk.r4.approval-bypass",
    pattern:
      /\b(?:(?:disable|skip|bypass).{0,40}(?:approval|review|verification|tests?|policy)|(?:approval|review|verification|tests?|policy).{0,40}(?:disable|skip|bypass))/i,
    message: "explicit policy, review, verification, or approval bypass requested",
  },
  {
    ruleId: "risk.r4.credential-exfiltration",
    pattern:
      /\b(?:send|upload|post|curl|fetch)[a-z0-9_.-]*.{0,80}(?:process\.env|credentials?|secrets?|tokens?|passwords?)\b/i,
    message: "explicit credential exfiltration requested",
  },
  {
    ruleId: "risk.r4.production-data",
    pattern:
      /\b(?:drop\s+table|truncate\s+table|delete\s+from)\s+(?:production|prod[_-])[a-z0-9_.-]*/i,
    message: "explicit destructive production-data operation requested",
  },
];

const R3_TEXT_RULES: ReadonlyArray<{
  ruleId: string;
  pattern: RegExp;
  message: string;
}> = [
  {
    ruleId: "risk.command.destructive",
    pattern: /\b(?:delete|destroy|truncate|wipe)\b/i,
    message: "destructive command or intent requires Owner review",
  },
  {
    ruleId: "risk.command.force-push",
    pattern: /\bgit\s+push\b[^\n]*(?:--force(?:-with-lease)?|-f)\b/i,
    message: "Git history rewrite requested",
  },
  {
    ruleId: "risk.command.privilege",
    pattern: /(?:^|\s)sudo(?:\s|$)/i,
    message: "privilege escalation requested",
  },
  {
    ruleId: "risk.diff.ddl",
    pattern: /\b(?:create|alter|drop|truncate)\s+(?:table|database|schema|index)\b/i,
    message: "SQL DDL changed",
  },
  {
    ruleId: "risk.diff.network-destination",
    pattern: /\bhttps?:\/\/[A-Za-z0-9.-]+(?::\d+)?(?:\/|\b)/i,
    message: "new network destination introduced",
  },
];

export interface RiskClassificationContext {
  policy_sha256: string;
  now: () => string;
  repo_id?: string;
  protected_policy_paths?: readonly string[];
}

export function maxRisk(
  left: AutonomyRiskLevel,
  right: AutonomyRiskLevel,
): AutonomyRiskLevel {
  return RISK_ORDER[left] >= RISK_ORDER[right] ? left : right;
}

export function classifyPreflightRisk(
  input: unknown,
  context: RiskClassificationContext,
): AutonomyRiskDecision {
  const intent = AutonomyTaskIntent.parse(input);
  const signals: AutonomyRiskSignal[] = [];
  const isReadOnly =
    intent.expected_paths.length === 0 &&
    intent.requested_actions.every((action) => READ_ONLY_ACTIONS.has(action));

  if (!isReadOnly) {
    addBaselineSignal(signals, intent.expected_paths, "preflight intent");
  }
  addPathSignals(signals, intent.expected_paths);
  addTextSignals(
    signals,
    [intent.goal, ...intent.requested_actions],
    "preflight request",
  );
  addProtectedPolicySignals(
    signals,
    intent.expected_paths,
    context.protected_policy_paths ?? [],
  );
  addOsstackKernelSignals(signals, intent.expected_paths, intent.repo_id);

  return decision(
    "preflight",
    signals,
    context,
    {
      intent,
      protected_policy_paths: canonicalStrings(
        context.protected_policy_paths ?? [],
      ),
    },
  );
}

export function classifyPostDiffRisk(
  input: unknown,
  context: RiskClassificationContext,
): AutonomyRiskDecision {
  const postDiff = PostDiffInput.parse(input);
  const signals: AutonomyRiskSignal[] = [];

  addBaselineSignal(signals, postDiff.changed_paths, "staged diff");
  addPathSignals(signals, postDiff.changed_paths);
  addProtectedPolicySignals(
    signals,
    postDiff.changed_paths,
    context.protected_policy_paths ?? [],
  );
  addOsstackKernelSignals(
    signals,
    postDiff.changed_paths,
    context.repo_id ?? "",
  );

  for (const change of postDiff.dependency_changes) {
    if (!change.major) continue;
    signals.push({
      rule_id: "risk.dependency.major",
      level: "R3",
      message: `major dependency change: ${change.name}`,
    });
  }

  addTextSignals(
    signals,
    [...addedDiffLines(postDiff.staged_diff_binary), ...postDiff.commands],
    "staged diff or command",
  );
  addPackageScriptSignals(signals, postDiff);

  return decision(
    "post_diff",
    signals,
    context,
    {
      post_diff: postDiff,
      repo_id: context.repo_id ?? "",
      protected_policy_paths: canonicalStrings(
        context.protected_policy_paths ?? [],
      ),
    },
  );
}

function configuredPackageScripts(commands: readonly string[]): Set<string> {
  const names = new Set(SENSITIVE_PACKAGE_SCRIPTS);
  for (const command of commands) {
    const tokens = command.trim().split(/\s+/);
    const managerIndex = tokens.findIndex((token) =>
      ["pnpm", "npm", "yarn", "bun"].includes(token)
    );
    if (managerIndex < 0) continue;
    let candidate: string | undefined;
    for (let index = managerIndex + 1; index < tokens.length; index += 1) {
      const token = tokens[index]!;
      if (token === "--") break;
      if (token === "run") {
        candidate = tokens[index + 1];
        break;
      }
      if (!token.startsWith("-")) candidate = token;
    }
    if (candidate !== undefined && /^[A-Za-z0-9_.:-]+$/.test(candidate)) {
      names.add(candidate);
    }
  }
  return names;
}

function addPackageScriptSignals(
  signals: AutonomyRiskSignal[],
  postDiff: ReturnType<typeof PostDiffInput.parse>,
): void {
  const manifests = postDiff.changed_paths.filter(
    (path) => path === "package.json" || path.endsWith("/package.json"),
  );
  if (manifests.length === 0) return;
  const scriptNames = configuredPackageScripts(postDiff.commands);
  for (const line of addedDiffLines(postDiff.staged_diff_binary)) {
    const match = line.match(/^\s*"([^"]+)"\s*:/);
    const script = match?.[1];
    if (script === undefined || !scriptNames.has(script)) continue;
    for (const path of manifests) {
      signals.push({
        rule_id: "risk.verification-script",
        level: "R3",
        message: `verification or lifecycle package script changed: ${script}`,
        path,
      });
    }
  }
}

function addBaselineSignal(
  signals: AutonomyRiskSignal[],
  paths: readonly string[],
  source: string,
): void {
  if (paths.length === 0) {
    if (source === "preflight intent") {
      signals.push({
        rule_id: "risk.baseline.source",
        level: "R2",
        message: "write intent has no bounded expected path",
      });
    }
    return;
  }

  if (paths.every(isDocumentationPath)) {
    signals.push({
      rule_id: "risk.baseline.docs",
      level: "R1",
      message: `${source} changes documentation only`,
    });
    return;
  }
  if (paths.every(isTestPath)) {
    signals.push({
      rule_id: "risk.baseline.tests",
      level: "R1",
      message: `${source} changes tests only`,
    });
    return;
  }
  signals.push({
    rule_id: "risk.baseline.source",
    level: "R2",
    message: `${source} changes source or configuration`,
  });
}

function addPathSignals(
  signals: AutonomyRiskSignal[],
  paths: readonly string[],
): void {
  for (const path of paths) {
    for (const rule of R3_PATH_RULES) {
      if (!rule.pattern.test(path)) continue;
      signals.push({
        rule_id: rule.ruleId,
        level: "R3",
        message: rule.message,
        path,
      });
    }
  }
}

function addProtectedPolicySignals(
  signals: AutonomyRiskSignal[],
  paths: readonly string[],
  protectedPaths: readonly string[],
): void {
  const normalizedProtected = new Set(
    protectedPaths.map(normalizeRepositoryPath),
  );
  for (const path of paths) {
    if (!normalizedProtected.has(normalizeRepositoryPath(path))) continue;
    signals.push({
      rule_id: "risk.policy-referenced-script",
      level: "R3",
      message: "script referenced by effective base policy changed",
      path,
    });
  }
}

function addOsstackKernelSignals(
  signals: AutonomyRiskSignal[],
  paths: readonly string[],
  repoId: string,
): void {
  if (!/(?:^|\/)osstack$/i.test(repoId)) return;
  for (const path of paths) {
    if (!OSSTACK_TRUST_KERNEL_PATH.test(path)) continue;
    signals.push({
      rule_id: "risk.osstack-trust-kernel",
      level: "R3",
      message: "osstack risk, approval, or state-machine trust kernel changed",
      path,
    });
  }
}

function addTextSignals(
  signals: AutonomyRiskSignal[],
  texts: readonly string[],
  source: string,
): void {
  for (const text of texts) {
    let matchedR4 = false;
    if (isRecursiveRootDelete(text)) {
      matchedR4 = true;
      signals.push({
        rule_id: "risk.r4.recursive-root",
        level: "R4",
        message: "explicit recursive root deletion requested",
        command: text,
      });
    }
    for (const rule of R4_TEXT_RULES) {
      if (!rule.pattern.test(text)) continue;
      matchedR4 = true;
      signals.push({
        rule_id: rule.ruleId,
        level: "R4",
        message: rule.message,
        command: text,
      });
    }
    for (const rule of R3_TEXT_RULES) {
      if (!rule.pattern.test(text)) continue;
      if (
        matchedR4 &&
        (rule.ruleId === "risk.command.destructive" ||
          rule.ruleId === "risk.diff.ddl")
      ) {
        continue;
      }
      signals.push({
        rule_id: rule.ruleId,
        level: "R3",
        message: `${rule.message} (${source})`,
        command: text,
      });
    }
  }
}

function decision(
  phase: "preflight" | "post_diff",
  rawSignals: AutonomyRiskSignal[],
  context: RiskClassificationContext,
  digestInput: unknown,
): AutonomyRiskDecision {
  const signals = dedupeAndSortSignals(rawSignals);
  const level = signals.reduce<AutonomyRiskLevel>(
    (current, signal) => maxRisk(current, signal.level),
    "R0",
  );
  return AutonomyRiskDecision.parse({
    phase,
    level,
    signals,
    policy_sha256: context.policy_sha256,
    input_sha256: sha256Canonical(digestInput),
    decided_at: context.now(),
  });
}

function dedupeAndSortSignals(
  signals: readonly AutonomyRiskSignal[],
): AutonomyRiskSignal[] {
  const byKey = new Map<string, AutonomyRiskSignal>();
  for (const signal of signals) byKey.set(signalKey(signal), signal);
  return [...byKey.values()].sort((left, right) => {
    const leftKey = signalKey(left);
    const rightKey = signalKey(right);
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
}

function signalKey(signal: AutonomyRiskSignal): string {
  return [
    signal.rule_id,
    signal.path ?? "",
    signal.command ?? "",
    signal.level,
    signal.message,
  ].join("\u0000");
}

function addedDiffLines(diff: string): string[] {
  return diff
    .split(/\r?\n/)
    .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
    .map((line) => line.slice(1));
}

function isDocumentationPath(path: string): boolean {
  return (
    /(?:^|\/)(?:docs?|documentation)(?:\/|$)/i.test(path) ||
    /\.(?:md|mdx|rst|txt)$/i.test(path)
  );
}

function isTestPath(path: string): boolean {
  return (
    /(?:^|\/)(?:tests?|__tests__)(?:\/|$)/i.test(path) ||
    /\.(?:test|spec)\.[^.]+$/i.test(path)
  );
}

function canonicalStrings(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function normalizeRepositoryPath(value: string): string {
  return value.replaceAll("\\", "/").replace(/^(?:\.\/)+/, "").replace(/\/+/g, "/");
}

function isRecursiveRootDelete(text: string): boolean {
  const tokens = text.trim().split(/\s+/);
  if (tokens[0] === "sudo") tokens.shift();
  if (tokens.shift() !== "rm") return false;

  let recursive = false;
  let forced = false;
  let root = false;
  for (const token of tokens) {
    if (token === "--recursive") {
      recursive = true;
      continue;
    }
    if (token === "--force") {
      forced = true;
      continue;
    }
    if (/^-[^-]/.test(token)) {
      const flags = token.slice(1);
      if (flags.includes("r") || flags.includes("R")) recursive = true;
      if (flags.includes("f")) forced = true;
      continue;
    }
    if (token === "--") continue;
    const unquoted = token.replace(/^(["'])(.*)\1$/, "$2");
    if (unquoted === "/") root = true;
    break;
  }
  return recursive && forced && root;
}

function sha256Canonical(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const entries = Object.keys(record)
    .sort()
    .map(
      (key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`,
    );
  return `{${entries.join(",")}}`;
}
