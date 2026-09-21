import { z } from "zod";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import {
  buildDecisionRequest,
  DECISION_MODEL,
} from "@osstack/core/decision-advice";
import {
  decisionStoreStatus,
  initializeDecisionStore,
  runStoredDecision,
} from "./decision-store.js";

const HELP = `osstack decision — experimental, non-authoritative Jev advice
  init --store DIR --scope ID [--max-calls N] [--budget-microusd N] [--max-input-tokens N]
  advise --input FILE                       Validate locally; no network or writes
  advise --input FILE --live --store DIR    Send selected text using TYPESAFE_API_KEY
  status --store DIR                        Show calls, charges and unknown holds

Default limits: 1000 calls, 1000000 microUSD ($1), 10000000 input tokens.
Use a dedicated private directory on a local filesystem. Unknown outcomes never retry and permanently retain their full budget hold.
Advice cannot grant permissions, start tools, change task status, or approve Graph actions.
`;
interface Dependencies {
  write?: (line: string) => void;
  env?: NodeJS.ProcessEnv;
}
function parse(args: string[], allowed: string[]): Map<string, string> {
  const flags = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const key = args[i]!;
    if (!allowed.includes(key) || flags.has(key))
      throw Error("DECISION_ARGUMENTS_INVALID");
    if (key === "--live") {
      flags.set(key, "true");
      continue;
    }
    const value = args[++i];
    if (!value || value.startsWith("--"))
      throw Error("DECISION_ARGUMENTS_INVALID");
    flags.set(key, value);
  }
  return flags;
}
function required(flags: Map<string, string>, key: string): string {
  const value = flags.get(key);
  if (!value) throw Error("DECISION_ARGUMENTS_INVALID");
  return value;
}
async function readInput(path: string): Promise<unknown> {
  const file = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 65_536)
      throw Error("DECISION_INPUT_INVALID");
    const bytes = Buffer.alloc(65_537);
    let bytesRead = 0;
    while (bytesRead < bytes.length) {
      const part = await file.read(
        bytes,
        bytesRead,
        bytes.length - bytesRead,
        bytesRead,
      );
      if (part.bytesRead === 0) break;
      bytesRead += part.bytesRead;
    }
    if (bytesRead > 65_536) throw Error("DECISION_INPUT_INVALID");
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        bytes.subarray(0, bytesRead),
      ),
    ) as unknown;
  } finally {
    await file.close();
  }
}
export async function handleDecisionCommand(
  args: string[],
  deps: Dependencies = {},
): Promise<number> {
  const write = deps.write ?? console.log;
  const env = deps.env ?? process.env;
  const [command, ...rest] = args;
  if (
    !command ||
    command === "--help" ||
    (rest.length === 1 && rest[0] === "--help")
  ) {
    write(HELP);
    return 0;
  }
  try {
    if (command === "init") {
      const flags = parse(rest, [
        "--store",
        "--scope",
        "--max-calls",
        "--budget-microusd",
        "--max-input-tokens",
      ]);
      await initializeDecisionStore(required(flags, "--store"), {
        scopeId: required(flags, "--scope"),
        maxCalls: Number(flags.get("--max-calls") ?? 1000),
        maxMicroUSD: Number(flags.get("--budget-microusd") ?? 1_000_000),
        maxInputTokens: Number(flags.get("--max-input-tokens") ?? 10_000_000),
      });
      write(JSON.stringify({ status: "initialized", model: DECISION_MODEL }));
      return 0;
    }
    if (command === "status") {
      const flags = parse(rest, ["--store"]);
      write(
        JSON.stringify(await decisionStoreStatus(required(flags, "--store"))),
      );
      return 0;
    }
    if (command !== "advise") throw Error("DECISION_ARGUMENTS_INVALID");
    const flags = parse(rest, ["--input", "--live", "--store"]);
    const request = buildDecisionRequest(
      await readInput(required(flags, "--input")),
    );
    if (!flags.has("--live")) {
      write(
        JSON.stringify({
          mode: "dry-run",
          digest: request.digest,
          model: DECISION_MODEL,
          purpose: request.input.purpose,
          options: Object.keys(request.body.questions.decision.criteria),
          requestBytes: Buffer.byteLength(JSON.stringify(request.body)),
        }),
      );
      return 0;
    }
    const store = required(flags, "--store");
    const apiKey = env["TYPESAFE_API_KEY"];
    if (!apiKey) throw Error("DECISION_API_KEY_REQUIRED");
    // Reject accidental credential inclusion before reserving or dispatching.
    if (
      JSON.stringify({ input: request.input, body: request.body }).includes(
        JSON.stringify(apiKey).slice(1, -1),
      )
    )
      throw Error("DECISION_INPUT_INVALID");
    const { createTypeSafeDecisionClient } = await import(
      "@osstack/agents/decision-advisor"
    );
    const client = createTypeSafeDecisionClient({ apiKey });
    const result = await runStoredDecision(store, request, client.advise);
    write(JSON.stringify({ mode: "live", authority: "none", ...result }));
    return result.status === "answered" ? 0 : 2;
  } catch (error) {
    if (error instanceof z.ZodError) {
      write(
        JSON.stringify({
          error: "DECISION_VALIDATION_FAILED",
          issues: error.issues.map((issue) => ({
            path: issue.path,
            code: issue.code,
          })),
        }),
      );
      return 1;
    }
    const message =
      error instanceof Error && /^DECISION_[A-Z_]+$/.test(error.message)
        ? error.message
        : "DECISION_OPERATION_FAILED";
    write(JSON.stringify({ error: message }));
    return 1;
  }
}
