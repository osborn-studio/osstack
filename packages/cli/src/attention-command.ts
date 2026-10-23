import { readAttentionStatus } from "./attention-read-model.js";

const HELP = `Usage: osstack attention status --db /absolute/state.db --task ID --repo /absolute/repo --default-tenant [--json] [--after-run ID] [--after-session ID]
Read-only snapshot. No daemon is started and no database is migrated.
Live process state is unknown; this command does not establish background supervision.`;
export async function handleAttentionCommand(args: string[], io: { stdout?: (s: string) => void; stderr?: (s: string) => void } = {}): Promise<number> {
  const out = io.stdout ?? console.log; const err = io.stderr ?? console.error;
  if (args.includes("--help") || args[0] === "help") { out(HELP); return 0; }
  try {
    if (args[0] !== "status") throw new Error(HELP);
    const values = new Map<string, string>(); const flags = new Set<string>();
    for (let i = 1; i < args.length; i++) {
      const key = args[i]!;
      if (values.has(key) || flags.has(key)) throw new Error(`duplicate_flag:${key}`);
      if (["--json", "--default-tenant"].includes(key)) { flags.add(key); continue; }
      if (!["--db", "--task", "--repo", "--after-run", "--after-session"].includes(key)) throw new Error(`unknown_flag:${key}`);
      const value = args[++i]; if (!value || value.startsWith("--") || value.includes("\0")) throw new Error(`missing_value:${key}`);
      values.set(key, value);
    }
    const required = (key: string) => { const value = values.get(key); if (!value) throw new Error(`required:${key}`); return value; };
    if (!flags.has("--default-tenant")) throw new Error("explicit_default_tenant_required");
    const result = readAttentionStatus({ dbPath: required("--db"), repoPath: required("--repo"), taskId: required("--task"), defaultTenant: true,
      ...(values.has("--after-run") ? { afterRun: values.get("--after-run")! } : {}),
      ...(values.has("--after-session") ? { afterSession: values.get("--after-session")! } : {}) });
    out(flags.has("--json") ? JSON.stringify(result, null, 2) : [
      "单次状态快照 · 未后台接管", `Task: ${JSON.stringify(result.scope.task_id)}`,
      ...result.sessions.map((s) => `${JSON.stringify(s.session_id)}: ${JSON.stringify(s.state)} · ${JSON.stringify(s.wait.reason)}${s.decision ? ` · ${JSON.stringify(s.decision.question)}` : ""}`),
      `Runs: ${result.runs.length}; omitted: ${result.completeness.omitted_binding_unknown}; truncated: ${result.completeness.truncated}`,
      `Limitations: ${JSON.stringify(result.limitations)}`,
    ].join("\n"));
    return 0;
  } catch (error) { err(`osstack attention: ${error instanceof Error ? error.message : String(error)}`); return 1; }
}
