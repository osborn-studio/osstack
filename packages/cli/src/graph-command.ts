// Experimental read model: keep this adapter lazy and outside the scheduler.
import type { GraphCommandDependencies } from "./graph-execution-command.js";
import { createHash } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { LoopState } from "@osstack/loop";
import { assertDbAccessAllowed, defaultOsstackHome } from "./control-plane-guard.js";

const LIMIT = 100;
const MAX_STATE_BYTES = 4 * 1024 * 1024;
export interface GraphExplainInput {
  dbPath: string;
  statePath: string;
  taskId: string;
  board: string;
  tenantId: string | null;
}
interface TaskFact { task_id: string; status: string; updated_at: number }
interface CardFact { card_id: string; task_id: string | null; status: string; blocked_reason: string | null; updated_at: number }
interface RunFact { run_id: string; task_id: string; phase: string; outcome: string | null; started_at: number; completed_at: number | null }
interface RelationFact {
  parent_id: string; child_id: string;
  parent_task_id: string | null; child_task_id: string | null;
  parent_status: string; child_status: string;
  parent_blocked_reason: string | null; child_blocked_reason: string | null;
}
interface LoopMatch {
  location: "completed_tasks" | "in_progress" | "pending" | "deferred_tasks";
  index: number;
  task_id: string;
  outcome?: string;
  run_id?: string;
  run_match?: "scoped_run" | "not_in_returned_runs";
  authorization?: string;
  reason?: string;
}
function bounded<T>(rows: T[]) { return { items: rows.slice(0, LIMIT), truncated: rows.length > LIMIT }; }

function guardDatabasePath(dbPath: string) {
  const checkoutRoot = dirname(realpathSync(fileURLToPath(import.meta.url)));
  const defaultPath = defaultOsstackHome();
  const defaultHome = existsSync(defaultPath) ? realpathSync(defaultPath) : defaultPath;
  const home = dirname(dbPath);
  // Unlike normal CLI commands, --db accepts arbitrary paths, including backups
  // below a protected home. Check protected ancestors as well as the leaf home.
  for (let ancestor = home; ; ancestor = dirname(ancestor)) {
    if (ancestor === defaultHome || existsSync(join(ancestor, "control-plane-reserved.json"))) {
      assertDbAccessAllowed({ checkoutRoot, osstackHome: ancestor });
    }
    if (dirname(ancestor) === ancestor) break;
  }
  assertDbAccessAllowed({ checkoutRoot, osstackHome: home });
}

function readState(path: string) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error("Loop state must be a regular file");
    if (stat.size > MAX_STATE_BYTES) throw new Error("Loop state exceeds 4 MiB");
    // Read at most the bound + sentinel even if a producer grows the file.
    const buffer = Buffer.alloc(MAX_STATE_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = readSync(fd, buffer, length, buffer.length - length, null);
      if (count === 0) break;
      length += count;
    }
    if (length > MAX_STATE_BYTES) throw new Error("Loop state exceeds 4 MiB");
    const bytes = buffer.subarray(0, length);
    let state: LoopState;
    try { state = LoopState.parse(JSON.parse(bytes.toString("utf8"))); }
    catch { throw new Error("Invalid Loop state JSON or schema"); }
    return { state, sha256: createHash("sha256").update(bytes).digest("hex") };
  } finally { closeSync(fd); }
}

export function explainGraph(input: GraphExplainInput) {
  if (!isAbsolute(input.dbPath) || !isAbsolute(input.statePath)) throw new Error("--db and --state must be absolute paths");
  if (!input.taskId || !input.board || input.tenantId === "" || input.tenantId === undefined) throw new Error("Explicit task, board and tenant scope required");
  const dbPath = realpathSync(input.dbPath);
  if (!statSync(dbPath).isFile()) throw new Error("Database must be an existing regular file");
  guardDatabasePath(dbPath);
  const statePath = realpathSync(input.statePath);
  const { state, sha256 } = readState(statePath);
  // Do not use core openDb: even its readonly mode sets database pragmas.
  const db = new Database(dbPath, { readonly: true, fileMustExist: true, timeout: 1000 });
  let facts: ReturnType<typeof readFacts>;
  try { facts = db.transaction(() => readFacts(db, input))(); }
  catch (error) {
    if (error instanceof Database.SqliteError) throw new Error(`Cannot read graph source tables/columns: ${error.message}`);
    throw error;
  }
  finally { db.close(); }
  const matches: LoopMatch[] = [];
  const locationCounts = { completed_tasks: 0, in_progress: 0, pending: 0, deferred_tasks: 0 };
  function addMatch(match: LoopMatch) {
    locationCounts[match.location] += 1;
    if (matches.length <= LIMIT) matches.push(match);
  }
  // Keep only the bounded projection; do not expose prompts or task context.
  for (const [index, task] of state.completed_tasks.entries()) {
    if (task.task_id !== input.taskId) continue;
    addMatch({ location: "completed_tasks", index, task_id: task.task_id, outcome: task.outcome,
      ...(task.run_id === undefined ? {} : { run_id: task.run_id, run_match: facts.runs.items.some((run) => run.run_id === task.run_id) ? "scoped_run" as const : "not_in_returned_runs" as const }) });
  }
  for (const location of ["in_progress", "pending"] as const) {
    for (const [index, task] of (state[location] ?? []).entries()) {
      if (task.task_id === input.taskId) addMatch({ location, index, task_id: task.task_id });
    }
  }
  for (const [index, entry] of (state.deferred_tasks ?? []).entries()) {
    if (entry.task.task_id === input.taskId) addMatch({ location: "deferred_tasks", index, task_id: entry.task.task_id, authorization: entry.authorization, reason: entry.reason });
  }
  const loopMatches = bounded(matches);
  const locations = Object.entries(locationCounts).map(([location, total]) => {
    const returned = loopMatches.items.filter((match) => match.location === location).length;
    return { location, total, returned, truncated: returned < total };
  });
  const truncated = [facts.cards, facts.runs, facts.relations, loopMatches].some((collection) => collection.truncated);
  return {
    schema_version: 1,
    scope: { task_id: input.taskId, board: input.board, tenant_id: input.tenantId },
    sources: {
      database: { path: dbPath, observed_at: facts.observedAt, consistency: "single_read_transaction", authority: "stored_task_run_card_facts", tables: ["tasks", "runs", "kanban_cards", "kanban_card_links"] },
      loop: { path: statePath, authority: "caller_supplied_file_content" },
    },
    task: facts.task, cards: facts.cards, runs: facts.runs, relations: facts.relations,
    loop: { loop_id: state.loop_id, updated_at: state.updated_at, sha256, binding: "caller_supplied_unverified", matches: loopMatches, locations },
    coverage: { scope: "direct_card_links_in_selected_board_and_tenant", limit_per_collection: LIMIT, truncated, loop_task_found: matches.length > 0 },
    notices: [...(matches.length === 0 ? ["loop_task_not_found"] : []), ...(matches.length > 1 ? ["multiple_loop_records"] : []), ...(truncated ? ["results_truncated"] : [])],
    limitations: [
      "Stored card links are associations, not scheduler dependencies or proof of blocking. Only stored blocked status/reasons are evidence of an existing blocker.",
      "Database and Loop file have no shared snapshot. Their statuses are separate observations; disagreement does not establish a cause or a current unified state.",
      "Loop files carry no tenant/repository identity. Task and run ID matches do not authenticate the caller-supplied file.",
      "Only direct links within the requested scope are shown. Empty or truncated results do not prove no impact. not_in_returned_runs is not proof that a run never existed.",
    ],
  };
}

function readFacts(db: Database.Database, input: GraphExplainInput) {
  const params = { task: input.taskId, board: input.board, tenant: input.tenantId, limit: LIMIT + 1 };
  const task = db.prepare("SELECT task_id,status,updated_at FROM tasks WHERE task_id=@task AND tenant_id IS @tenant").get(params) as TaskFact | undefined;
  if (!task) throw new Error("Task not found in the explicit tenant scope");
  const cards = db.prepare("SELECT card_id,task_id,status,blocked_reason,updated_at FROM kanban_cards WHERE task_id=@task AND board=@board AND tenant_id IS @tenant ORDER BY card_id LIMIT @limit").all(params) as CardFact[];
  const runs = db.prepare("SELECT run_id,task_id,phase,outcome,started_at,completed_at FROM runs WHERE task_id=@task AND tenant_id IS @tenant ORDER BY started_at DESC,run_id LIMIT @limit").all(params) as RunFact[];
  // Query the full scoped task relation, not the truncated cards projection.
  const relations = db.prepare(`WITH task_cards AS (
      SELECT card_id FROM kanban_cards WHERE task_id=@task AND board=@board AND tenant_id IS @tenant
    ), candidate_links AS (
      SELECT l.parent_id,l.child_id FROM task_cards t JOIN kanban_card_links l ON l.parent_id=t.card_id
      UNION
      SELECT l.parent_id,l.child_id FROM task_cards t JOIN kanban_card_links l ON l.child_id=t.card_id
    )
    SELECT l.parent_id,l.child_id,p.task_id AS parent_task_id,c.task_id AS child_task_id,
    p.status AS parent_status,c.status AS child_status,p.blocked_reason AS parent_blocked_reason,c.blocked_reason AS child_blocked_reason
    FROM candidate_links l JOIN kanban_cards p ON p.card_id=l.parent_id JOIN kanban_cards c ON c.card_id=l.child_id
    WHERE p.board=@board AND c.board=@board AND p.tenant_id IS @tenant AND c.tenant_id IS @tenant
    ORDER BY l.parent_id,l.child_id LIMIT @limit`).all(params) as RelationFact[];
  return { task, cards: bounded(cards), runs: bounded(runs), relations: bounded(relations), observedAt: new Date().toISOString() };
}

const HELP = `Usage: osstack graph explain --task ID --db /absolute/state.db --board BOARD --state /absolute/LOOP-STATE.json (--tenant ID | --default-tenant) [--json]
Experimental read-only task/Loop/card relation view. All sources and scope must be explicit.
Shows direct stored links and existing blocker records; does not change execution or infer blocking.
Collections are capped at 100. JSON consumers must inspect coverage and limitations.`;

function parseArgs(args: string[]): GraphExplainInput & { json: boolean } {
  if (args[0] !== "explain") throw new Error(HELP);
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let index = 1; index < args.length; index++) {
    const key = args[index] as string;
    if (values.has(key) || flags.has(key)) throw new Error(`Repeated flag: ${key}`);
    if (key === "--json" || key === "--default-tenant") { flags.add(key); continue; }
    if (!["--task", "--db", "--board", "--state", "--tenant"].includes(key)) throw new Error(`Unknown argument: ${key}`);
    const value = args[++index];
    if (!value || value.startsWith("--")) throw new Error(`Missing value: ${key}`);
    values.set(key, value);
  }
  function required(key: string) { const value = values.get(key); if (!value) throw new Error(`Required: ${key}`); return value; }
  if (values.has("--tenant") === flags.has("--default-tenant")) throw new Error("Specify exactly one of --tenant ID or --default-tenant");
  return { taskId: required("--task"), dbPath: required("--db"), board: required("--board"), statePath: required("--state"), tenantId: flags.has("--default-tenant") ? null : required("--tenant"), json: flags.has("--json") };
}

function renderText(result: ReturnType<typeof explainGraph>) {
  // JSON quoting keeps newlines/terminal controls in stored text inert.
  const show = (value: unknown) => JSON.stringify(value);
  return [
    `Task ${show(result.task.task_id)}: DB status=${show(result.task.status)}`,
    `Scope: board=${show(result.scope.board)} tenant=${show(result.scope.tenant_id)}`,
    `Database: ${show(result.sources.database.path)} (${result.sources.database.observed_at})`,
    `Loop: ${show(result.sources.loop.path)} updated=${show(result.loop.updated_at)} sha256=${result.loop.sha256}`,
    `Loop binding: ${result.loop.binding}`,
    `Loop coverage by location: ${show(result.loop.locations)}`,
    ...result.loop.matches.items.map((match) => `  Loop ${show(match)}`),
    ...result.cards.items.map((card) => `  Card ${show(card)}`),
    ...result.runs.items.map((run) => `  Run ${show(run)}`),
    ...result.relations.items.map((relation) => `  Stored link ${show(relation)}`),
    `Coverage: ${show(result.coverage)}`,
    `Notices: ${show(result.notices)}`,
    ...result.limitations.map((limitation) => `Note: ${limitation}`),
  ].join("\n");
}

export async function handleGraphCommand(args: string[], deps: GraphCommandDependencies = {}): Promise<number> {
  if (["validate", "run", "status", "result", "cancel", "resume"].includes(args[0] ?? "")) {
    const { handleGraphExecutionCommand } = await import("./graph-execution-command.js");
    return handleGraphExecutionCommand(args, deps);
  }
  const stdout = deps.stdout ?? console.log;
  const stderr = deps.stderr ?? console.error;
  if ((args.length === 1 && ["--help", "help"].includes(args[0] ?? "")) || (args.length === 2 && args[0] === "explain" && args[1] === "--help")) { const { GRAPH_EXECUTION_HELP } = await import("./graph-execution-command.js"); stdout(`${GRAPH_EXECUTION_HELP}\n\n${HELP}`); return 0; }
  try {
    const input = parseArgs(args);
    const result = explainGraph(input);
    stdout(input.json ? JSON.stringify(result, null, 2) : renderText(result));
    return 0;
  } catch (error) { stderr(`osstack graph: ${error instanceof Error ? error.message : String(error)}`); return 1; }
}
