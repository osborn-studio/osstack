import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { isAbsolute, dirname, resolve } from "node:path";
import {
  KnowledgeHygieneRecurrencePolicyV1,
  listImprovementProposals,
  openDb,
  queryKnowledgeHygieneRecurrenceCandidatesV2,
  upsertImprovementProposal,
} from "@osstack/core";
import { AgentCommandResult, PROTOCOL_VERSION } from "@osstack/protocol";
import { proposeKnowledgeHygieneImprovements } from "@osstack/supervisor";
import Database from "better-sqlite3";
import { evaluatePolicyGate } from "./policy-gate.js";
import { osstackHome } from "./paths.js";

interface WriteAuthorization {
  allow: boolean;
  reason?: string;
}

export interface NeatProposalCommandDeps {
  cwd: () => string;
  stdout: (value: string) => void;
  stderr: (value: string) => void;
  now: () => Date;
  authorize_write?: (workspacePath: string) => Promise<WriteAuthorization>;
}

interface ParsedProposalCommand {
  dbPath: string;
  minOccurrences: number;
  minRepositories: number;
  confirmed: boolean;
  json: boolean;
  help: boolean;
}

class NeatProposalUsageError extends Error {}

function requireValue(args: readonly string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new NeatProposalUsageError(`${flag} requires a value`);
  }
  return value;
}

function positiveInteger(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new NeatProposalUsageError(`${flag} must be a positive integer`);
  }
  return parsed;
}

function parseProposalCommand(
  args: readonly string[],
  cwd: string,
): ParsedProposalCommand {
  let dbPath = resolve(osstackHome(), "state.db");
  let minOccurrences = 3;
  let minRepositories = 2;
  let confirmed = false;
  let json = false;
  let help = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    switch (arg) {
      case "--db": {
        const value = requireValue(args, index, arg);
        dbPath = isAbsolute(value) ? value : resolve(cwd, value);
        index += 1;
        break;
      }
      case "--min-occurrences":
        minOccurrences = positiveInteger(requireValue(args, index, arg), arg);
        index += 1;
        break;
      case "--min-repositories":
        minRepositories = positiveInteger(requireValue(args, index, arg), arg);
        index += 1;
        break;
      case "--yes":
        confirmed = true;
        break;
      case "--json":
        json = true;
        break;
      case "--help":
      case "-h":
        help = true;
        break;
      default:
        throw new NeatProposalUsageError(`unknown option ${arg}`);
    }
  }
  const policy = KnowledgeHygieneRecurrencePolicyV1.parse({
    min_occurrences: minOccurrences,
    min_repositories: minRepositories,
  });
  return {
    dbPath,
    minOccurrences: policy.min_occurrences,
    minRepositories: policy.min_repositories,
    confirmed,
    json,
    help,
  };
}

export function renderNeatProposalHelp(): string {
  return `osstack neat propose — preview repeated-finding improvement drafts

Usage:
  osstack neat propose [options]

Options:
  --db <path>                 State database (default: OSSTACK_HOME/state.db)
  --min-occurrences <n>       Per-finding threshold (default: 3, minimum: 2)
  --min-repositories <n>      Same-rule repository threshold (default: 2)
  --yes                       Persist drafts after policy authorization
  --json                      Emit Agent Command JSON
  --help                      Show this help

Without --yes this command is a read-only preview. Persisted proposals remain
high-risk drafts for human review; no hook, policy, or repository file changes.`;
}

function successResult(result: Record<string, unknown>) {
  return AgentCommandResult.parse({
    protocol_version: PROTOCOL_VERSION,
    status: "ok",
    result: { command: "knowledge_hygiene.propose", ...result },
  });
}

function errorResult(
  code: "bad_request" | "policy_denied" | "not_found" | "internal",
  message: string,
) {
  return AgentCommandResult.parse({
    protocol_version: PROTOCOL_VERSION,
    status: code === "policy_denied" ? "blocked" : "error",
    error: { code, message, retryable: code === "internal" },
  });
}

function outputError(
  deps: NeatProposalCommandDeps,
  json: boolean,
  code: "bad_request" | "policy_denied" | "not_found" | "internal",
  message: string,
): void {
  if (json) deps.stdout(JSON.stringify(errorResult(code, message), null, 2));
  else deps.stderr(`osstack neat propose: ${message}`);
}

export async function handleNeatProposalCommand(
  args: readonly string[],
  deps: NeatProposalCommandDeps,
): Promise<number> {
  let parsed: ParsedProposalCommand;
  try {
    parsed = parseProposalCommand(args, deps.cwd());
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    outputError(deps, args.includes("--json"), "bad_request", message);
    return 2;
  }
  if (parsed.help) {
    deps.stdout(renderNeatProposalHelp());
    return 0;
  }

  if (!existsSync(parsed.dbPath) && !parsed.confirmed) {
    const result = successResult({
      dry_run: true,
      db_path: parsed.dbPath,
      candidates: [],
      proposals: [],
      persisted: 0,
    });
    deps.stdout(parsed.json
      ? JSON.stringify(result, null, 2)
      : `No persisted neat history at ${parsed.dbPath}. Run osstack neat --record first.`);
    return 0;
  }

  if (parsed.confirmed) {
    const decision = await (deps.authorize_write ?? evaluatePolicyGate)(deps.cwd());
    if (!decision.allow) {
      outputError(
        deps,
        parsed.json,
        "policy_denied",
        decision.reason ?? "policy denied proposal persistence",
      );
      return 2;
    }
    await mkdir(dirname(parsed.dbPath), { recursive: true });
  }

  let db: Database.Database;
  try {
    db = parsed.confirmed
      ? openDb({ path: parsed.dbPath })
      : new Database(parsed.dbPath, { readonly: true, fileMustExist: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    outputError(deps, parsed.json, "internal", message);
    return 3;
  }

  try {
    const candidates = queryKnowledgeHygieneRecurrenceCandidatesV2(db, {
      min_occurrences: parsed.minOccurrences,
      min_repositories: parsed.minRepositories,
    });
    const proposals = proposeKnowledgeHygieneImprovements({
      candidates,
      created_at: deps.now().toISOString(),
    });
    let persisted = 0;
    let preserved = 0;
    if (parsed.confirmed) {
      const existing = new Map(
        listImprovementProposals(db, { limit: 100_000 })
          .map((proposal) => [proposal.proposal_id, proposal] as const),
      );
      for (const proposal of proposals) {
        const prior = existing.get(proposal.proposal_id);
        if (prior !== undefined && prior.status !== "draft") {
          preserved += 1;
          continue;
        }
        upsertImprovementProposal(db, parsed.dbPath, {
          proposal_id: proposal.proposal_id,
          repo_id: proposal.repo_id,
          source_asset_ids: proposal.source_asset_ids,
          target: proposal.target,
          risk: proposal.risk,
          title: proposal.title,
          rationale: proposal.rationale,
          proposed_changes: proposal.proposed_changes,
          required_gates: proposal.required_gates,
          status: "draft",
        });
        persisted += 1;
      }
    }
    const result = successResult({
      dry_run: !parsed.confirmed,
      db_path: parsed.dbPath,
      policy: {
        min_occurrences: parsed.minOccurrences,
        min_repositories: parsed.minRepositories,
      },
      candidates,
      proposals,
      persisted,
      preserved,
    });
    if (parsed.json) {
      deps.stdout(JSON.stringify(result, null, 2));
    } else if (proposals.length === 0) {
      deps.stdout("No recurrence candidates meet both thresholds.");
    } else {
      const lines = proposals.map((proposal) =>
        `${proposal.proposal_id} [draft/high] ${proposal.title}`);
      lines.push(parsed.confirmed
        ? `Persisted ${persisted}; preserved ${preserved} human-reviewed state(s).`
        : "DRY RUN: no proposals persisted. Re-run with --yes to persist drafts.");
      deps.stdout(lines.join("\n"));
    }
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    outputError(deps, parsed.json, "internal", message);
    return 3;
  } finally {
    db.close();
  }
}
