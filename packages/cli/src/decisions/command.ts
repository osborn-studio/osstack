import { DecisionsListParams, DecisionsListResult, DecisionsAnswerParams, DecisionsAnswerResult } from "@osstack/protocol";

const HELP = `Usage: osstack decisions answer --source S --id ID --answer KIND [--param k=v ...] --answer-id KEY --source-revision REV [--json]
        osstack decisions list [--scope ID] [--limit 1..100] [--cursor TOKEN] [--json]
List pending decisions or answer one through its source command.
Answer requires a credential, answer ID and the listed source revision.
Hermes approvals default to accepted. Pass --param status=rejected to reject one.
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
    const answering = args[0] === "answer";
    if (!answering && args[0] !== "list") throw Error("bad_request");
    const raw: Record<string, unknown> = {};
    let json = false;
    for (let i = 1; i < args.length; i++) {
      const key = args[i]!;
      if (key === "--json" && !json) { json = true; continue; }
      if (answering && key === "--param") {
        const value = args[++i]; const split = value?.indexOf("=") ?? -1;
        if (!value || split < 1) throw Error("bad_request");
        raw.params ??= Object.create(null);
        const params = raw.params as Record<string, string>;
        const name = value.slice(0, split);
        if (Object.hasOwn(params, name)) throw Error("bad_request");
        params[name] = value.slice(split + 1); continue;
      }
      const field = answering ? ({ "--source": "source", "--id": "source_id", "--answer": "answer", "--answer-id": "answer_id", "--source-revision": "source_revision" } as Record<string, string>)[key] : { "--scope": "scope_id", "--limit": "limit", "--cursor": "cursor" }[key];
      const value = args[++i];
      if (!field || value === undefined || value.startsWith("--") || Object.hasOwn(raw, field)) throw Error("bad_request");
      raw[field] = field === "limit" ? Number(value) : value;
    }
    const credential = io.credential ? io.credential() : process.env["OSSTACK_ENGINEERING_CREDENTIAL"];
    const parsed = answering ? DecisionsAnswerParams.safeParse({ ...raw, credential }) : DecisionsListParams.safeParse(raw);
    if (!parsed.success) throw Error("bad_request");
    const params = { ...parsed.data, ...(credential ? { credential } : {}) };
    const response = await io.rpc(answering ? "decisions.answer" : "decisions.list", params) as { ok?: boolean; result?: unknown };
    if (!response?.ok) throw Error("decisions_unavailable");
    if (answering) {
      const result = DecisionsAnswerResult.parse(response.result);
      out(json ? JSON.stringify(result, null, 2) : `${result.outcome}\t${result.current.state}\t${result.code ?? ""}`);
      return result.accepted ? 0 : 1;
    }
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
