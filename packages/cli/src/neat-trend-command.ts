import {
  type KnowledgeHygieneTrendReportV2Core,
  openDb,
  queryKnowledgeHygieneTrendV2,
} from "@osstack/core";
import {
  AgentCommandResult,
  PROTOCOL_VERSION,
  type ErrorCode,
} from "@osstack/protocol";
import { existsSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { osstackHome } from "./paths.js";

export interface NeatTrendCommandDeps {
  cwd: () => string;
  stdout: (value: string) => void;
  stderr: (value: string) => void;
  now: () => Date;
}

interface ParsedNeatTrendCommand {
  help: boolean;
  json: boolean;
  repo_id: string;
  db_path: string;
}

class NeatTrendUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NeatTrendUsageError";
  }
}

function valueAfter(
  args: readonly string[],
  index: number,
  flag: string,
): string {
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new NeatTrendUsageError(`${flag} requires a value`);
  }
  return value;
}

function parseNeatTrendCommand(
  args: readonly string[],
  cwd: string,
): ParsedNeatTrendCommand {
  let repoId = basename(resolve(cwd));
  let dbPath = join(osstackHome(), "state.db");
  let json = false;
  const seen = new Set<string>();
  const markSeen = (flag: string): void => {
    if (seen.has(flag)) throw new NeatTrendUsageError(`duplicate flag: ${flag}`);
    seen.add(flag);
  };

  if (args.includes("--help") || args.includes("-h")) {
    return { help: true, json: false, repo_id: repoId, db_path: dbPath };
  }
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === "--repo-id") {
      markSeen(flag);
      repoId = valueAfter(args, index, flag);
      index += 1;
    } else if (flag === "--db") {
      markSeen(flag);
      dbPath = resolve(cwd, valueAfter(args, index, flag));
      index += 1;
    } else if (flag === "--json") {
      markSeen(flag);
      json = true;
    } else if (flag === "--format") {
      markSeen(flag);
      const format = valueAfter(args, index, flag);
      if (format !== "human" && format !== "json") {
        throw new NeatTrendUsageError(`unsupported format: ${format}`);
      }
      json = format === "json";
      index += 1;
    } else {
      throw new NeatTrendUsageError(`unknown trend option: ${flag}`);
    }
  }
  return { help: false, json, repo_id: repoId, db_path: dbPath };
}

export function renderNeatTrendHelp(): string {
  return `osstack neat trend — event-derived knowledge hygiene history

Usage:
  osstack neat trend [trend options]

Trend options:
  --repo-id <id>          Persisted repository id (default: cwd basename)
  --db <path>             State database (default: $OSSTACK_HOME/state.db)
  --format <human|json>   Output format (default: human)
  --json                  Alias for --format json
  --help                  Show this help`;
}

export function renderKnowledgeHygieneTrend(
  trend: KnowledgeHygieneTrendReportV2Core,
): string {
  return [
    `Knowledge hygiene trend: ${trend.repo_id}`,
    `Reports: ${trend.report_count}`,
    `Open: ${trend.open.total} (${trend.open.error} error, ${trend.open.warning} warning, ${trend.open.info} info)`,
    `Oldest open: ${trend.open.oldest_age_days === null ? "none" : `${trend.open.oldest_age_days} day(s)`}`,
    `Recurring: ${trend.recurrence.total} (${trend.recurrence.warning} warning)`,
    `Closure: ${trend.closure.closed}/${trend.closure.tracked} (${(trend.closure.rate * 100).toFixed(1)}%)`,
    `Latest delta: +${trend.delta.new} new, ${trend.delta.resolved} resolved`,
    `Suppressed (latest, separate): ${trend.suppressed.latest}`,
    `History sources: ${trend.sources.v1_reports} V1, ${trend.sources.v2_reports} V2`,
    `Latest assessment: ${trend.latest_assessment?.health_claim ?? "none"} (${trend.latest_assessment?.schema_version ?? "no report"})`,
    `As of: ${new Date(trend.as_of).toISOString()}`,
  ].join("\n");
}

function errorResult(code: ErrorCode, message: string, retryable: boolean) {
  return AgentCommandResult.parse({
    protocol_version: PROTOCOL_VERSION,
    status: "error",
    error: { code, message, retryable },
  });
}

function emitError(
  deps: NeatTrendCommandDeps,
  json: boolean,
  code: ErrorCode,
  message: string,
  retryable: boolean,
): void {
  if (json) {
    deps.stdout(JSON.stringify(errorResult(code, message, retryable), null, 2));
  } else {
    deps.stderr(`osstack neat trend: ${message}`);
  }
}

export function handleNeatTrendCommand(
  args: readonly string[],
  deps: NeatTrendCommandDeps,
): number {
  let parsed: ParsedNeatTrendCommand;
  try {
    parsed = parseNeatTrendCommand(args, deps.cwd());
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    emitError(deps, args.includes("--json"), "bad_request", message, false);
    return 2;
  }
  if (parsed.help) {
    deps.stdout(renderNeatTrendHelp());
    return 0;
  }
  if (!existsSync(parsed.db_path)) {
    emitError(
      deps,
      parsed.json,
      "bad_request",
      `state database does not exist: ${parsed.db_path}`,
      false,
    );
    return 2;
  }

  try {
    const db = openDb({ path: parsed.db_path });
    try {
      const trend = queryKnowledgeHygieneTrendV2(db, parsed.repo_id, {
        as_of: deps.now().getTime(),
      });
      if (parsed.json) {
        deps.stdout(JSON.stringify(AgentCommandResult.parse({
          protocol_version: PROTOCOL_VERSION,
          status: "ok",
          result: { command: "knowledge_hygiene.trend", trend },
        }), null, 2));
      } else {
        deps.stdout(renderKnowledgeHygieneTrend(trend));
      }
      return 0;
    } finally {
      db.close();
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    emitError(deps, parsed.json, "internal", message, true);
    return 3;
  }
}
