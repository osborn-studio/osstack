import { readAttentionStatus } from "./attention-read-model.js";

const HELP = `Usage: osstack attention status --db /absolute/state.db --task ID --repo /absolute/repo --default-tenant [--json] [--cursor TOKEN]
Read-only snapshot. No daemon is started and no database is migrated.
Live process state is unknown; this command does not establish background supervision.
Opt-in daemon: OSSTACK_ATTENTION=1 osstack serve
  attention watch --task ID --repo PATH --default-tenant
  attention inbox|inventory|deliveries --scope ID [--after ID] [--json]
  attention get --scope ID --item ID
  attention answer --scope ID --item ID --action ID --revision N --content-hash HASH --text TEXT [--takeover --grant ID]
  attention release --scope ID --kind session|run|loop --subject ID --expected-version N
  attention abandon-receipt --scope ID --session ID --message ID --expected-version N --reason TEXT --evidence-sha256 HASH --acknowledge-unknown-effects
  attention brief|cockpit --scope ID --actor NAME
  attention posture --scope ID --actor NAME --posture attended|quiet|away
  attention seen --scope ID --actor NAME --revisions JSON
  attention foreground --scope ID --subjects JSON
  attention handoff --scope ID --client ID --token TOKEN
  attention turn-end --scope ID --client ID --token TOKEN --role foreground_owner
  attention loop --scope ID --loop-id ID --state-path PATH
  attention ci --scope ID --github-repo OWNER/REPO --pr N --head SHA --required JSON
  attention claude-hook --binding-file PATH
  attention contract|routing-eval|triage|context|lesson --input PATH [--json]
See docs/guides/attention.md for planning flags and verified hook setup.
No daemon is automatically started. Hooks are explicit calls; no offline watchdog is installed.`;
export async function handleAttentionCommand(
  args: string[],
  io: {
    stdout?: (s: string) => void;
    stderr?: (s: string) => void;
    rpc?: (
      method: string,
      params?: unknown,
      timeoutMs?: number
    ) => Promise<unknown>;
  } = {}
): Promise<number> {
  const out = io.stdout ?? console.log;
  const err = io.stderr ?? console.error;
  if (args.includes("--help") || args[0] === "help") {
    out(HELP);
    return 0;
  }
  try {
    if (args[0] === "claude-hook") {
      if (!io.rpc) throw new Error("daemon_connection_required");
      const { handleClaudeAttentionHook } = await import("./attention-hook.js");
      return await handleClaudeAttentionHook(args, (method, params) => io.rpc!(method, params, 1000), out);
    }
    if (
      ["contract", "routing-eval", "triage", "context", "lesson"].includes(
        args[0] ?? ""
      )
    ) {
      const { handleAttentionPlanning } = await import(
        "./attention-planning-command.js"
      );
      return await handleAttentionPlanning(args, out);
    }
    if (args[0] !== "status") return await handleLive(args, io);
    const values = new Map<string, string>();
    const flags = new Set<string>();
    for (let i = 1; i < args.length; i++) {
      const key = args[i]!;
      if (values.has(key) || flags.has(key))
        throw new Error(`duplicate_flag:${key}`);
      if (["--json", "--default-tenant"].includes(key)) {
        flags.add(key);
        continue;
      }
      if (
        ![
          "--db",
          "--task",
          "--repo",
          "--after-run",
          "--after-session",
          "--cursor",
        ].includes(key)
      )
        throw new Error(`unknown_flag:${key}`);
      const value = args[++i];
      if (!value || value.startsWith("--") || value.includes("\0"))
        throw new Error(`missing_value:${key}`);
      values.set(key, value);
    }
    const required = (key: string) => {
      const value = values.get(key);
      if (!value) throw new Error(`required:${key}`);
      return value;
    };
    if (!flags.has("--default-tenant"))
      throw new Error("explicit_default_tenant_required");
    const result = readAttentionStatus({
      dbPath: required("--db"),
      repoPath: required("--repo"),
      taskId: required("--task"),
      defaultTenant: true,
      ...(values.has("--cursor") ? { cursor: values.get("--cursor")! } : {}),
      ...(values.has("--after-run")
        ? { afterRun: values.get("--after-run")! }
        : {}),
      ...(values.has("--after-session")
        ? { afterSession: values.get("--after-session")! }
        : {}),
    });
    out(
      flags.has("--json")
        ? JSON.stringify(result, null, 2)
        : [
            "单次状态快照 · 未后台接管",
            `Task: ${JSON.stringify(result.scope.task_id)}`,
            ...result.sessions.map(
              (s) =>
                `${JSON.stringify(s.session_id)}: ${JSON.stringify(
                  s.state
                )} · ${JSON.stringify(s.wait.reason)}${
                  s.decision ? ` · ${JSON.stringify(s.decision.question)}` : ""
                }`
            ),
            `Runs: ${result.runs.length}; omitted: ${result.completeness.omitted_binding_unknown}; truncated: ${result.completeness.truncated}`,
            `Limitations: ${JSON.stringify(result.limitations)}`,
          ].join("\n")
    );
    return 0;
  } catch (error) {
    err(
      `osstack attention: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return 1;
  }
}

async function handleLive(
  args: string[],
  io: {
    stdout?: (s: string) => void;
    rpc?: (
      method: string,
      params?: unknown,
      timeoutMs?: number
    ) => Promise<unknown>;
  }
): Promise<number> {
  const command = args[0]!;
  const allowed = [
    "watch",
    "inventory",
    "inbox",
    "get",
    "answer",
    "brief",
    "posture",
    "seen",
    "foreground",
    "handoff",
    "turn-end",
    "deliveries",
    "cockpit",
    "abandon-receipt",
    "release",
    "loop",
    "ci",
  ];
  if (!allowed.includes(command)) throw new Error("unknown_attention_command");
  if (!io.rpc) throw new Error("daemon_connection_required");
  const params: Record<string, unknown> = {};
  let json = false;
  const keys = new Set([
    "task",
    "repo",
    "scope",
    "after",
    "item",
    "action",
    "revision",
    "content-hash",
    "text",
    "actor",
    "posture",
    "revisions",
    "subjects",
    "client",
    "token",
    "role",
    "state-path",
    "loop-id",
    "github-repo",
    "pr",
    "head",
    "required",
    "session",
    "kind",
    "subject",
    "message",
    "expected-version",
    "reason",
    "evidence-sha256",
    "grant",
  ]);
  for (let i = 1; i < args.length; i++) {
    const flag = args[i]!;
    if (flag === "--json") {
      json = true;
      continue;
    }
    if (flag === "--default-tenant") {
      params["default_tenant"] = true;
      continue;
    }
    if (flag === "--acknowledge-unknown-effects") {
      params["acknowledge_unknown_effects"] = true;
      continue;
    }
    if (flag === "--takeover") {
      params["takeover"] = true;
      continue;
    }
    const key = flag.slice(2);
    if (!flag.startsWith("--") || !keys.has(key))
      throw new Error("unknown_flag:" + flag);
    const value = args[++i];
    if (!value || value.startsWith("--"))
      throw new Error("missing_value:" + flag);
    const mapped: Record<string, string> = {
      task: "task_id",
      session: "session_id",
      subject: "subject_id",
      message: "message_id",
      "expected-version": "expected_version",
      "evidence-sha256": "evidence_sha256",
      repo: "repo_path",
      scope: "scope_id",
      item: "item_id",
      action: "action_id",
      client: "client_id",
      "content-hash": "content_hash",
      "state-path": "state_path",
      "loop-id": "loop_id",
      "github-repo": "github_repo",
      grant: "takeover_grant_id",
    };
    const name = mapped[key] ?? key;
    if (params[name] !== undefined) throw new Error("duplicate_flag:" + flag);
    params[name] = ["revision", "pr", "expected-version"].includes(key)
      ? Number(value)
      : ["revisions", "subjects", "required"].includes(key)
      ? JSON.parse(value)
      : value;
  }
  if (command === "answer") params["takeover"] ??= false;
  const call = async (method: string) => {
    const response = (await io.rpc!(method, params, 120000)) as {
      ok: boolean;
      result?: unknown;
      error?: { code?: string; message?: string };
    };
    if (!response.ok)
      throw new Error(
        response.error?.code ?? response.error?.message ?? "attention_failed"
      );
    return response.result;
  };
  const result =
    command === "cockpit"
      ? {
          inventory: await call("attention.inventory"),
          inbox: await call("attention.inbox"),
          brief: await call("attention.brief"),
          deliveries: await call("attention.deliveries"),
        }
      : await call("attention." + command);
  (io.stdout ?? console.log)(
    json
      ? JSON.stringify(result, null, 2)
      : `Attention · ${command}\n${JSON.stringify(
          result,
          null,
          2
        )}\nDelivered means transport receipt; applied means instruction receipt; neither means task completed.`
  );
  return 0;
}
