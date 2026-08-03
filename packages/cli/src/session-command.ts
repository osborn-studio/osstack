export interface SessionCommandRpcResponse {
  ok: boolean;
  result?: unknown;
  error?: { message: string };
}

export interface SessionCommandDeps {
  rpc: (
    method: string,
    params?: unknown,
    timeoutMs?: number,
  ) => Promise<unknown>;
  stdout?: (line: string) => void;
  stderr?: (line: string, detail?: string) => void;
}

export async function handleSessionCommand(
  args: string[],
  deps: SessionCommandDeps,
): Promise<number> {
  const stdout = deps.stdout ?? console.log;
  const stderr = deps.stderr ?? console.error;
  const sub = args[0];
  if (sub === undefined || sub === "help" || args.includes("--help") || args.includes("-h")) {
    stdout(`osstack session — governed resumable conversations

  osstack session list [--json]
  osstack session start --request-id <id> --agent <id> --repo <path> --title <title> --text <prompt> [--json]
  osstack session status <session_id> [--json]
  osstack session snapshot <session_id> [--json]
  osstack session send <session_id> --runtime <id> --turn <turn_id> --message-id <id> \\\\
    --expected-version <n> --text <instruction> [--requested-by <actor>] [--json]
`);
    return 0;
  }

  let method: string;
  let params: Record<string, unknown> | undefined;
  if (sub === "list") {
    method = "session.list";
  } else if (sub === "start") {
    const flags: Record<string, string> = {};
    for (let i = 1; i < args.length; i++) {
      const item = args[i]!;
      if (item === "--json") continue;
      if (!item.startsWith("--") || args[i + 1] === undefined || args[i + 1]!.startsWith("--")) {
        stderr(`osstack: invalid session start argument: ${item}`);
        return 1;
      }
      flags[item.slice(2)] = args[i + 1]!;
      i++;
    }
    if (
      flags["request-id"] === undefined
      || flags["agent"] === undefined
      || flags["repo"] === undefined
      || flags["title"] === undefined
      || flags["text"] === undefined
    ) {
      stderr("osstack: session start requires --request-id, --agent, --repo, --title, and --text");
      return 1;
    }
    method = "session.start";
    params = {
      request_id: flags["request-id"],
      agent_id: flags["agent"],
      repo_path: flags["repo"],
      title: flags["title"],
      prompt: flags["text"],
    };
  } else if (sub === "status" || sub === "snapshot") {
    const sessionId = args[1];
    if (sessionId === undefined || sessionId.startsWith("--")) {
      stderr(`osstack: session ${sub} requires a session_id`);
      return 1;
    }
    method = `session.${sub}`;
    params = { session_id: sessionId };
  } else if (sub === "send") {
    const sessionId = args[1];
    if (sessionId === undefined || sessionId.startsWith("--")) {
      stderr("osstack: session send requires a session_id");
      return 1;
    }
    const flags: Record<string, string> = {};
    for (let i = 2; i < args.length; i++) {
      const item = args[i]!;
      if (item === "--json") continue;
      if (!item.startsWith("--") || args[i + 1] === undefined || args[i + 1]!.startsWith("--")) {
        stderr(`osstack: invalid session send argument: ${item}`);
        return 1;
      }
      flags[item.slice(2)] = args[i + 1]!;
      i++;
    }
    const expectedVersion = Number(flags["expected-version"]);
    if (
      flags["runtime"] === undefined
      || flags["turn"] === undefined
      || flags["message-id"] === undefined
      || flags["text"] === undefined
      || !Number.isInteger(expectedVersion)
      || expectedVersion < 1
    ) {
      stderr("osstack: session send requires --runtime, --turn, --message-id, --expected-version, and --text");
      return 1;
    }
    method = "session.send";
    params = {
      session_id: sessionId,
      runtime_id: flags["runtime"],
      turn_id: flags["turn"],
      message_id: flags["message-id"],
      expected_version: expectedVersion,
      text: flags["text"],
      ...(flags["requested-by"] === undefined ? {} : { requested_by: flags["requested-by"] }),
    };
  } else {
    stderr(`osstack: unknown session subcommand "${sub}"`);
    return 1;
  }

  const response = (await deps.rpc(
    method,
    params,
    sub === "send" || sub === "start" ? 300_000 : 10_000,
  )) as SessionCommandRpcResponse;
  if (!response.ok) {
    stderr("osstack:", response.error?.message ?? `${method} failed`);
    return 1;
  }
  stdout(JSON.stringify(response.result, null, 2));
  return 0;
}
