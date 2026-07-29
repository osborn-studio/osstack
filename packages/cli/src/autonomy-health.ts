import { execFile } from "node:child_process";
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  statfsSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { defaultAdapters } from "@osstack/agents";
import {
  listAutonomyRuns,
  listProductionFreezes,
  listResumableAutonomyRuns,
  summarizeNotificationOutbox,
  type NotificationOutboxSummary,
} from "@osstack/core";
import type Database from "better-sqlite3";

const execFileAsync = promisify(execFile);

export const AUTONOMY_MIN_WRITE_FREE_BYTES = 5 * 1024 ** 3;
export const AUTONOMY_DRAIN_FREE_BYTES = 2 * 1024 ** 3;

export type AutonomyHealthCheckId =
  | "state_db"
  | "daemon_socket"
  | "disk_free"
  | "repo_registry"
  | "repo_locks"
  | "kimi_code"
  | "builder_agents"
  | "github_auth"
  | "github_network"
  | "deploy_freezes"
  | "resumable_runs"
  | "proof_failures"
  | "notification_outbox";

export interface AutonomyHealthCheck {
  id: AutonomyHealthCheckId;
  status: "ok" | "warn" | "blocked";
  scope: "none" | "external" | "writes" | "daemon";
  detail: string;
}

export interface AutonomyAdapterProbe {
  id: string;
  available: boolean;
  capability_kinds: string[];
}

export interface AutonomyHealthDeps {
  db: Database.Database;
  db_path: string;
  home: string;
  socket_path: string;
  repo_registry_path?: string;
  disk_free_bytes?: () => number;
  probe_adapters?: () => Promise<AutonomyAdapterProbe[]>;
  probe_github_auth?: () => Promise<boolean>;
  probe_github_network?: () => Promise<boolean>;
  now?: () => number;
}

export interface AutonomyHealthReport {
  ok: boolean;
  can_run_local: boolean;
  can_merge: boolean;
  can_push_deploy: boolean;
  drain_required: boolean;
  disk_free_bytes: number;
  checks: AutonomyHealthCheck[];
  active_freezes: Array<{
    repo_id: string;
    reason: string;
    source_run_id: string;
    frozen_at: number;
  }>;
  resumable_runs: Array<{
    autonomy_run_id: string;
    repo_id: string;
    state: string;
  }>;
  proof_failures: Array<{
    autonomy_run_id: string;
    repo_id: string;
    state: string;
  }>;
  notification_outbox: NotificationOutboxSummary;
  external_blockers: AutonomyHealthCheckId[];
  write_blockers: AutonomyHealthCheckId[];
  next_actions: string[];
}

function check(
  id: AutonomyHealthCheckId,
  status: AutonomyHealthCheck["status"],
  scope: AutonomyHealthCheck["scope"],
  detail: string,
): AutonomyHealthCheck {
  return { id, status, scope, detail };
}

function defaultDiskFreeBytes(dbPath: string): number {
  try {
    const stats = statfsSync(dirname(dbPath));
    return Number(stats.bsize) * Number(stats.bavail);
  } catch {
    // Keep the report JSON-safe while avoiding an accidental write outage when
    // the platform cannot provide statfs data. The doctor reports this case
    // separately as a warning.
    return Number.MAX_SAFE_INTEGER;
  }
}

async function defaultAdapterProbe(): Promise<AutonomyAdapterProbe[]> {
  return await Promise.all(defaultAdapters().map(async (adapter) => ({
    id: adapter.id,
    available: (await adapter.isAvailable()).available,
    capability_kinds: adapter.capabilities().map(
      (capability) => capability.kind,
    ),
  })));
}

async function commandProbe(
  command: string,
  args: string[],
): Promise<boolean> {
  try {
    await execFileAsync(command, args, {
      timeout: 5_000,
      maxBuffer: 64 * 1024,
    });
    return true;
  } catch {
    return false;
  }
}

function repoRegistryCheck(path: string): AutonomyHealthCheck {
  if (!existsSync(path)) {
    return check(
      "repo_registry",
      "warn",
      "none",
      "repository registry is not configured",
    );
  }
  try {
    const value = JSON.parse(readFileSync(path, "utf-8")) as unknown;
    if (!Array.isArray(value)) {
      return check(
        "repo_registry",
        "blocked",
        "writes",
        "repository registry is not a JSON array",
      );
    }
    return check(
      "repo_registry",
      "ok",
      "none",
      `${value.length} registered repositories`,
    );
  } catch {
    return check(
      "repo_registry",
      "blocked",
      "writes",
      "repository registry cannot be parsed",
    );
  }
}

function repoLocksCheck(lockDirectory: string): AutonomyHealthCheck {
  if (!existsSync(lockDirectory)) {
    return check("repo_locks", "ok", "none", "no repository write locks");
  }
  let locks = 0;
  try {
    for (const name of readdirSync(lockDirectory)) {
      if (!name.endsWith(".lock")) continue;
      locks += 1;
      const path = join(lockDirectory, name);
      const stats = lstatSync(path);
      if (!stats.isFile() || stats.isSymbolicLink()) {
        throw new Error("lock is not a regular file");
      }
      const value = JSON.parse(readFileSync(path, "utf-8")) as unknown;
      if (
        typeof value !== "object"
        || value === null
        || Array.isArray(value)
        || typeof (value as Record<string, unknown>)["pid"] !== "number"
        || typeof (value as Record<string, unknown>)["autonomy_run_id"]
          !== "string"
        || typeof (value as Record<string, unknown>)["repo_id"] !== "string"
        || typeof (value as Record<string, unknown>)["acquired_at"] !== "string"
      ) {
        throw new Error("lock schema is invalid");
      }
    }
  } catch {
    return check(
      "repo_locks",
      "blocked",
      "writes",
      "repository lock inventory contains an invalid lock",
    );
  }
  return check(
    "repo_locks",
    "ok",
    "none",
    `${locks} active repository write locks`,
  );
}

function socketCheck(home: string, socketPath: string): AutonomyHealthCheck {
  if (!existsSync(socketPath)) {
    return check(
      "daemon_socket",
      "warn",
      "none",
      "daemon socket is not present",
    );
  }
  try {
    if (!lstatSync(socketPath).isSocket()) {
      return check(
        "daemon_socket",
        "blocked",
        "daemon",
        "daemon socket path is not a Unix socket",
      );
    }
    const pid = Number(
      readFileSync(join(home, "daemon.pid"), "utf-8").trim(),
    );
    if (!Number.isInteger(pid) || pid < 1) {
      return check(
        "daemon_socket",
        "warn",
        "none",
        "daemon socket exists without a valid pidfile",
      );
    }
    return check(
      "daemon_socket",
      "ok",
      "none",
      "daemon socket and pidfile are present",
    );
  } catch {
    return check(
      "daemon_socket",
      "warn",
      "none",
      "daemon socket ownership could not be confirmed",
    );
  }
}

function nextActions(
  checks: AutonomyHealthCheck[],
  drainRequired: boolean,
  notificationOutbox: NotificationOutboxSummary,
): string[] {
  const actions: string[] = [];
  const blocked = new Set(
    checks
      .filter((candidate) => candidate.status === "blocked")
      .map((candidate) => candidate.id),
  );
  if (drainRequired) {
    actions.push("Drain the daemon and free disk space immediately");
  } else if (blocked.has("disk_free")) {
    actions.push("Free at least 5 GiB before starting another write run");
  }
  if (blocked.has("repo_locks")) {
    actions.push("Inspect corrupt repository locks before resuming writes");
  }
  if (blocked.has("builder_agents")) {
    actions.push("Restore at least one available code-writing Builder");
  }
  if (blocked.has("kimi_code")) {
    actions.push("Restore Kimi Code availability before merge");
  }
  if (blocked.has("github_auth")) {
    actions.push("Refresh GitHub CLI authentication");
  }
  if (blocked.has("github_network")) {
    actions.push("Wait for GitHub network recovery; local work may continue");
  }
  if (notificationOutbox.dead_letter_count > 0) {
    actions.push(
      "Inspect and acknowledge dead-letter Owner notifications",
    );
  } else if (notificationOutbox.pending_count > 0) {
    actions.push("Restore the Owner notification relay and drain the outbox");
  }
  return actions;
}

export async function runAutonomyHealth(
  deps: AutonomyHealthDeps,
): Promise<AutonomyHealthReport> {
  const checks: AutonomyHealthCheck[] = [];
  try {
    deps.db.prepare("SELECT 1 AS ok").get();
    checks.push(check("state_db", "ok", "none", "state database is readable"));
  } catch {
    checks.push(check(
      "state_db",
      "blocked",
      "writes",
      "state database query failed",
    ));
  }

  checks.push(socketCheck(deps.home, deps.socket_path));

  const diskFreeBytes = (
    deps.disk_free_bytes ?? (() => defaultDiskFreeBytes(deps.db_path))
  )();
  const drainRequired = diskFreeBytes < AUTONOMY_DRAIN_FREE_BYTES;
  checks.push(
    diskFreeBytes < AUTONOMY_MIN_WRITE_FREE_BYTES
      ? check(
          "disk_free",
          "blocked",
          "writes",
          drainRequired
            ? `${diskFreeBytes} bytes free; daemon drain required below 2 GiB`
            : `${diskFreeBytes} bytes free; writes require at least 5 GiB`,
        )
      : check(
          "disk_free",
          "ok",
          "none",
          `${diskFreeBytes} bytes free`,
        ),
  );

  checks.push(repoRegistryCheck(
    deps.repo_registry_path ?? join(deps.home, "repos.json"),
  ));
  checks.push(repoLocksCheck(join(deps.home, "locks", "repos")));

  let adapters: AutonomyAdapterProbe[] = [];
  try {
    adapters = await (deps.probe_adapters ?? defaultAdapterProbe)();
  } catch {
    adapters = [];
  }
  const kimiAvailable = adapters.some(
    (adapter) => adapter.id === "kimi-code" && adapter.available,
  );
  checks.push(
    kimiAvailable
      ? check("kimi_code", "ok", "none", "Kimi Code is available")
      : check(
          "kimi_code",
          "blocked",
          "external",
          "Kimi Code is unavailable; merge remains blocked",
        ),
  );
  const builders = adapters.filter(
    (adapter) =>
      adapter.available
      && adapter.capability_kinds.includes("code.write"),
  );
  checks.push(
    builders.length > 0
      ? check(
          "builder_agents",
          "ok",
          "none",
          `${builders.length} code-writing builders available`,
        )
      : check(
          "builder_agents",
          "blocked",
          "writes",
          "no code-writing Builder is available",
        ),
  );

  const githubAuth = await (
    deps.probe_github_auth
    ?? (() => commandProbe("gh", ["auth", "status", "-h", "github.com"]))
  )();
  checks.push(
    githubAuth
      ? check("github_auth", "ok", "none", "GitHub authentication is valid")
      : check(
          "github_auth",
          "blocked",
          "external",
          "GitHub authentication probe failed",
        ),
  );
  const githubNetwork = await (
    deps.probe_github_network
    ?? (() => commandProbe("gh", ["api", "rate_limit", "--silent"]))
  )();
  checks.push(
    githubNetwork
      ? check("github_network", "ok", "none", "GitHub network is reachable")
      : check(
          "github_network",
          "blocked",
          "external",
          "GitHub network probe failed",
        ),
  );

  const activeFreezes = listProductionFreezes(
    deps.db,
    { active_only: true },
  ).map((freeze) => ({
    repo_id: freeze.repo_id,
    reason: freeze.reason,
    source_run_id: freeze.source_run_id,
    frozen_at: freeze.frozen_at,
  }));
  checks.push(check(
    "deploy_freezes",
    activeFreezes.length === 0 ? "ok" : "warn",
    activeFreezes.length === 0 ? "none" : "external",
    activeFreezes.length === 0
      ? "no active production freezes"
      : `${activeFreezes.length} production freezes require review`,
  ));

  const resumableRuns = listResumableAutonomyRuns(deps.db).map((row) => ({
    autonomy_run_id: row.autonomy_run_id,
    repo_id: row.repo_id,
    state: row.state,
  }));
  checks.push(check(
    "resumable_runs",
    resumableRuns.length === 0 ? "ok" : "warn",
    "none",
    `${resumableRuns.length} resumable autonomy runs`,
  ));

  const proofFailures = listAutonomyRuns(deps.db, { limit: 1_000 })
    .filter(
      (row) =>
        row.state === "delivery_evidence_failed"
        || row.state === "escalated",
    )
    .map((row) => ({
      autonomy_run_id: row.autonomy_run_id,
      repo_id: row.repo_id,
      state: row.state,
    }));
  checks.push(check(
    "proof_failures",
    proofFailures.length === 0 ? "ok" : "warn",
    "none",
    `${proofFailures.length} proof or escalated run failures`,
  ));

  const notificationOutbox = summarizeNotificationOutbox(
    deps.db,
    deps.now?.() ?? Date.now() / 1_000,
  );
  checks.push(check(
    "notification_outbox",
    notificationOutbox.pending_count === 0
        && notificationOutbox.dead_letter_count === 0
      ? "ok"
      : "warn",
    notificationOutbox.dead_letter_count > 0 ? "external" : "none",
    notificationOutbox.pending_count === 0
        && notificationOutbox.dead_letter_count === 0
      ? "notification outbox is drained"
      : `${notificationOutbox.pending_count} pending and ${
        notificationOutbox.dead_letter_count
      } dead-letter Owner notifications; oldest attention age ${
        notificationOutbox.oldest_attention_age_seconds
      }s`,
  ));

  const externalBlockers = checks
    .filter(
      (candidate) =>
        candidate.status === "blocked"
        && candidate.scope === "external",
    )
    .map((candidate) => candidate.id);
  const writeBlockers = checks
    .filter(
      (candidate) =>
        candidate.status === "blocked"
        && (
          candidate.scope === "writes"
          || candidate.scope === "daemon"
        ),
    )
    .map((candidate) => candidate.id);
  const canRunLocal = writeBlockers.length === 0;
  const canPushDeploy =
    canRunLocal
    && !externalBlockers.includes("github_auth")
    && !externalBlockers.includes("github_network");
  const canMerge =
    canPushDeploy
    && !externalBlockers.includes("kimi_code");

  return {
    ok: checks.every((candidate) => candidate.status !== "blocked"),
    can_run_local: canRunLocal,
    can_merge: canMerge,
    can_push_deploy: canPushDeploy,
    drain_required: drainRequired,
    disk_free_bytes: diskFreeBytes,
    checks,
    active_freezes: activeFreezes,
    resumable_runs: resumableRuns,
    proof_failures: proofFailures,
    notification_outbox: notificationOutbox,
    external_blockers: externalBlockers,
    write_blockers: writeBlockers,
    next_actions: nextActions(
      checks,
      drainRequired,
      notificationOutbox,
    ),
  };
}
