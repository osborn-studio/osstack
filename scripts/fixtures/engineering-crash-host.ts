// Fault fixture: real daemon process and SQLite, deterministic in-process Adapter.
// This does not qualify a provider or prove containment of escaped child processes.
import { appendFileSync, existsSync, mkdirSync, realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { openDb, insertRun, insertTask } from "@osstack/core";
import type { AgentSessionEvent, AgentSessionInput, SessionCapableAdapter } from "@osstack/agents";
import type { HermesEvent } from "@osstack/hermes-adapter";
import { startDaemon } from "../../packages/cli/src/daemon.js";
import { healthyAutonomyHealth } from "../../packages/cli/src/test-healthy-autonomy.js";

const root = process.argv[2]!;
const mode = process.argv[3]!;
const repo = join(realpathSync(root), "repo");
if (!existsSync(repo)) { mkdirSync(repo); execFileSync("git", ["init", "--quiet", repo]); }
class CrashFixture implements SessionCapableAdapter {
  readonly id = "engineering-crash-fixture";
  readonly display_name = "Deterministic crash fixture";
  readonly cost_tier = "low" as const;
  capabilities() { return []; }
  async isAvailable() { return { available: true, last_checked_at: 1 }; }
  sessionCapabilities() { return { resume: true, snapshot: true }; }
  async *invoke(): AsyncIterable<HermesEvent> { yield* []; }
  async *startSession(): AsyncIterable<AgentSessionEvent> { throw Error("Unexpected new Worker"); }
  async confirmStopped() { return { stopped: true as const, evidence: "fixture owns no child process" }; }
  async *resumeSession(input: AgentSessionInput): AsyncIterable<AgentSessionEvent> {
    appendFileSync(join(root, "invocations.log"), `${input.message_id}\n`);
    yield { type: "native_session.started", native_session_id: input.native_session_id };
    if (mode === "invoking") await new Promise<void>(() => {});
    yield { type: "assistant.message", message_id: "reply", text: "Fixture reply complete" };
    yield { type: "session.terminal", state: "completed" };
  }
}
const dbPath = join(root, "home", "state.db");
mkdirSync(join(root, "home"), { recursive: true });
const db = openDb({ path: dbPath });
if (!db.prepare("SELECT 1 FROM tasks WHERE task_id='task'").get()) {
  insertTask(db, dbPath, { task_id: "task", title: "Crash qualification fixture", created_at: 1 });
  insertRun(db, dbPath, { run_id: "run", task_id: "task", session_id: "session", agent_id: "engineering-crash-fixture", capability_id: "code", phase: "execute", started_at: 1 });
  db.prepare("INSERT INTO agent_sessions(session_id,task_id,run_id,agent_id,request_sha256,native_session_id,repo_path,state,resume_supported,version,updated_at) VALUES('session','task','run','engineering-crash-fixture',?,'fixture-native',?,'awaiting_decision',1,1,1)").run("a".repeat(64), repo);
  db.prepare("INSERT INTO session_turns(turn_id,session_id,ordinal,state,decision_json,created_at,updated_at) VALUES('turn','session',1,'awaiting_decision',?,1,1)").run(JSON.stringify({ decision_id: "decision", question: "Keep compatibility?", choices: [{ choice_id: "keep", label: "Keep compatibility" }] }));
}
db.close();
const daemon = await startDaemon({
  socketPath: process.env["OSSTACK_SOCKET"] ?? join(root, "d.sock"), workspacePath: repo, adapters: [new CrashFixture()],
  autonomyHealth: async () => {
    if (mode === "admission") await new Promise<void>(() => {});
    return healthyAutonomyHealth();
  },
});
process.send?.({ ready: true, repo, dbPath: daemon.dbPath });
