import { DecisionsListParams, DecisionsListResult } from "@osstack/protocol";

const HELP = `Usage: osstack decisions list [--scope ID] [--limit 1..100] [--cursor TOKEN] [--json]
Read pending decisions. This command does not answer, notify, or start a daemon.
Use next_cursor to request the next page. Engineering credentials select readable Mission scopes.`;
export async function handleDecisionsCommand(args: string[], io: {
  rpc: (method: string, params: unknown) => Promise<unknown>;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  credential?: () => string | undefined;
}): Promise<number> {
  const out = io.stdout ?? console.log;
  if (args.length === 0 || args.includes("--help")) { out(HELP); return 0; }
  try {
    if (args[0] !== "list") throw Error("bad_request");
    const raw: Record<string, unknown> = {};
    let json = false;
    for (let i = 1; i < args.length; i++) {
      const key = args[i]!;
      if (key === "--json" && !json) { json = true; continue; }
      const field = { "--scope": "scope_id", "--limit": "limit", "--cursor": "cursor" }[key];
      const value = args[++i];
      if (!field || value === undefined || value.startsWith("--") || Object.hasOwn(raw, field)) throw Error("bad_request");
      raw[field] = field === "limit" ? Number(value) : value;
    }
    const parsed = DecisionsListParams.safeParse(raw);
    if (!parsed.success) throw Error("bad_request");
    const credential = io.credential ? io.credential() : process.env["OSSTACK_ENGINEERING_CREDENTIAL"];
    const params = { ...parsed.data, ...(credential ? { credential } : {}) };
    const response = await io.rpc("decisions.list", params) as { ok?: boolean; result?: unknown };
    if (!response?.ok) throw Error("decisions_unavailable");
    const result = DecisionsListResult.parse(response.result);
    if (json) out(JSON.stringify(result, null, 2));
    else {
      for (const row of result.items) out(`${row.source}\t${row.source_id}\t${row.summary}\t${row.answer_command.name}`);
      if (!result.items.length) out("No pending decisions on this page.");
      for (const failure of result.failures) out(`${failure.source}: ${failure.code}`);
      if (result.next_cursor) out(`next_cursor: ${result.next_cursor}`);
    }
    return 0;
  } catch {
    (io.stderr ?? console.error)("osstack decisions: request failed; check flags and daemon availability");
    return 1;
  }
}
