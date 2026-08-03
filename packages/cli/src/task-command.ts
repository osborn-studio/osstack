interface TaskCommandRpcResponse {
  ok: boolean;
  result?: unknown;
  error?: { message: string };
}

export interface TaskCommandDeps {
  rpc: (method: string, params?: unknown) => Promise<unknown>;
  submit: (params: Record<string, unknown>) => Promise<number>;
  observe: (runId: string, afterSeq?: number) => Promise<number>;
  stdout?: (line: string) => void;
  stderr?: (line: string, detail?: string) => void;
}

export async function handleTaskCommand(
  args: string[],
  deps: TaskCommandDeps,
): Promise<number> {
  const stdout = deps.stdout ?? console.log;
  const stderr = deps.stderr ?? console.error;
  const sub = args[0];
  if (sub === "submit") {
    // Parse flags out of the arg list; everything else joins into the prompt.
    //   --kind <kind>        routing hint (e.g. research.ml)
    //   --agent <id>         pin a specific adapter (e.g. autoresearch)
    //   --tag <tag>          autoresearch run tag → context.tag
    //   --max-iter <n>       autoresearch iteration cap → context.max_iterations
    //   --repo <path>        autoresearch repo → context.repo_path
    const rest = args.slice(1);
    const flags: Record<string, string> = {};
    const promptParts: string[] = [];
    for (let i = 0; i < rest.length; i++) {
      const arg = rest[i]!;
      if (arg.startsWith("--") && i + 1 < rest.length) {
        flags[arg.slice(2)] = rest[i + 1]!;
        i++;
      } else {
        promptParts.push(arg);
      }
    }
    const prompt = promptParts.join(" ");
    if (!prompt) {
      stderr("osstack: task submit requires a prompt");
      return 1;
    }
    const params: Record<string, unknown> = { prompt };
    if (flags["kind"]) params["kind"] = flags["kind"];
    if (flags["agent"]) params["agent_id"] = flags["agent"];
    const context: Record<string, unknown> = {};
    if (flags["tag"]) context["tag"] = flags["tag"];
    if (flags["max-iter"]) context["max_iterations"] = Number(flags["max-iter"]);
    if (flags["repo"]) context["repo_path"] = flags["repo"];
    if (Object.keys(context).length > 0) params["context"] = context;
    return await deps.submit(params);
  }
  if (sub === "status") {
    const runId = args[1];
    if (!runId) {
      stderr("osstack: task status requires a run_id");
      return 1;
    }
    const response = (await deps.rpc("run.status", { run_id: runId })) as TaskCommandRpcResponse;
    if (!response.ok) {
      stderr("osstack:", response.error?.message ?? "status failed");
      return 1;
    }
    stdout(JSON.stringify(response.result, null, 2));
    return 0;
  }
  if (sub === "cancel") {
    const runId = args[1];
    if (!runId) {
      stderr("osstack: task cancel requires a run_id");
      return 1;
    }
    const response = (await deps.rpc("task.cancel", { run_id: runId })) as TaskCommandRpcResponse;
    if (!response.ok) {
      stderr("osstack:", response.error?.message ?? "cancel failed");
      return 1;
    }
    stdout(JSON.stringify(response.result, null, 2));
    return 0;
  }
  if (sub === "observe") {
    const runId = args[1];
    if (!runId) {
      stderr("osstack: task observe requires a run_id");
      return 1;
    }
    const afterSeq = args[2] !== undefined ? Number.parseInt(args[2], 10) : undefined;
    return await deps.observe(runId, afterSeq);
  }
  stderr(`osstack: unknown task subcommand "${sub}"`);
  return 1;
}
