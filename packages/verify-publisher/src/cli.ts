import { open } from "node:fs/promises";
import { z } from "zod";
import { createFileAttemptLedger } from "./attempt-ledger.js";
import { parsePublisherAllowlist, parsePublishRequest, type PublisherAllowlist } from "./config.js";
import { abandonVerification, publishVerification, type PublisherGithub, type PublishOutcome } from "./publish.js";

export interface CliDeps { github: PublisherGithub; now: () => Date; uuid: () => string; stdout: (line: string) => void }

function argumentsFor(argv: readonly string[]) {
  const [command] = argv;
  if (command !== "publish" && command !== "abandon") return null;
  const flags = new Map<string, string>();
  const inputFlag = command === "publish" ? "--request" : "--invocation";
  let operator = false;
  for (let n = 1; n < argv.length; n++) {
    const flag = argv[n]!;
    if (flag === "--operator" && command === "publish" && !operator) { operator = true; continue; }
    if (!["--config", "--ledger", inputFlag].includes(flag) || flags.has(flag)) return null;
    const value = argv[++n];
    if (!value || value.startsWith("-")) return null;
    flags.set(flag, value);
  }
  const config = flags.get("--config"), ledger = flags.get("--ledger"), input = flags.get(inputFlag);
  if (!config || !ledger || !input || (command === "abandon" && !z.string().uuid().safeParse(input).success)) return null;
  return { command, config, ledger, input, operator };
}

async function jsonFile(path: string): Promise<unknown> {
  try {
    const file = await open(path, "r");
    try {
      const bytes = Buffer.alloc(262145);
      let length = 0;
      while (length < bytes.length) {
        const { bytesRead } = await file.read(bytes, length, bytes.length - length);
        if (!bytesRead) return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length)));
        length += bytesRead;
      }
      return null;
    } finally { await file.close(); }
  } catch { return null; }
}

export async function runCli(argv: readonly string[], deps: CliDeps): Promise<number> {
  return runCliWithGithub(argv, { ...deps, github: () => deps.github });
}

export async function runCliWithGithub(argv: readonly string[],
  deps: Omit<CliDeps, "github"> & { github: (config: PublisherAllowlist) => PublisherGithub }): Promise<number> {
  function invalid(reason: "usage" | "config_invalid" | "request_invalid") {
    deps.stdout(JSON.stringify({ ok: false, reason, detail: null }));
    return 2;
  }
  const args = argumentsFor(argv);
  if (!args) return invalid("usage");
  const config = parsePublisherAllowlist(await jsonFile(args.config));
  if (!config.ok) return invalid("config_invalid");
  const publisher = { ...deps, github: deps.github(config.value), ledger: createFileAttemptLedger(args.ledger) };
  const signal = new AbortController().signal;
  let outcome: PublishOutcome;
  if (args.command === "publish") {
    const request = parsePublishRequest(await jsonFile(args.input));
    if (!request.ok) return invalid("request_invalid");
    outcome = await publishVerification(publisher, config.value, request.value, { signal, operator: args.operator });
  } else {
    outcome = await abandonVerification(publisher, config.value, args.input, { signal });
  }
  deps.stdout(JSON.stringify(outcome));
  return outcome.ok ? 0 : 1;
}
