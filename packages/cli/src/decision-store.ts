import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rmdir,
  statfs,
  unlink,
} from "node:fs/promises";
import { resolve, join, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  buildDecisionRequest,
  DecisionAdviceInputSchema,
  DECISION_CALL_HOLD_MICRO_USD,
  DECISION_MAX_INPUT_TOKENS,
  DECISION_MODEL,
  DECISION_RATE_CARD,
  decisionCostMicroUSD,
  parseDecisionAnswer,
  type DecisionRequest,
} from "@osstack/core/decision-advice";
import type { DecisionAdviceResult } from "@osstack/agents/decision-advisor";

const budgetSchema = z
  .object({
    scopeId: DecisionAdviceInputSchema.options[0].shape.scopeId,
    maxCalls: z.number().int().min(1).max(1000),
    maxMicroUSD: z
      .number()
      .int()
      .min(Number(DECISION_CALL_HOLD_MICRO_USD))
      .max(1_000_000),
    maxInputTokens: z
      .number()
      .int()
      .min(DECISION_MAX_INPUT_TOKENS)
      .max(10_000_000),
  })
  .strict();
const configSchema = budgetSchema
  .extend({
    schemaVersion: z.literal(1),
    model: z.literal(DECISION_MODEL),
    rateCard: z.literal(DECISION_RATE_CARD),
  })
  .strict();
export type DecisionBudget = z.infer<typeof budgetSchema>;
const recordSchema = z
  .object({
    schemaVersion: z.literal(1),
    digest: z.string().regex(/^[a-f0-9]{64}$/),
    status: z.enum(["dispatched", "unknown", "answered"]),
    failureReason: z
      .enum([
        "invalid_request",
        "timeout",
        "http_error",
        "network_error",
        "invalid_response",
      ])
      .optional(),
    httpStatus: z.number().int().min(100).max(599).optional(),
    inputTokens: z
      .number()
      .int()
      .min(0)
      .max(DECISION_MAX_INPUT_TOKENS)
      .optional(),
    outputTokens: z.number().int().min(0).max(65536).optional(),
    choice: z.string().max(64).optional(),
    confidence: z.number().finite().min(0).max(1).optional(),
  })
  .strict()
  .refine(
    (record) =>
      (record.status === "unknown" ||
        (record.failureReason === undefined &&
          record.httpStatus === undefined)) &&
      (record.httpStatus === undefined ||
        record.failureReason === "http_error"),
  )
  .refine((record) =>
    record.status === "answered"
      ? record.outputTokens !== undefined &&
        record.inputTokens !== undefined &&
        record.choice !== undefined &&
        record.confidence !== undefined
      : record.outputTokens === undefined &&
        record.inputTokens === undefined &&
        record.choice === undefined &&
        record.confidence === undefined,
  );
export type DecisionRecord = z.infer<typeof recordSchema>;

/** Standalone private local ledger. No control-plane database is opened. Same-UID processes are trusted. */
async function checkedStore(path: string): Promise<string> {
  let absolute = resolve(path);
  const info = await lstat(absolute);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (info.mode & 0o077) !== 0 ||
    info.uid !== process.getuid?.()
  )
    throw Error("DECISION_STORE_UNSAFE");
  // Resolve platform aliases (macOS /var) once; the store itself must not be a symlink.
  absolute = await realpath(absolute);
  const fs = await statfs(absolute);
  if (
    ![
      0x1a, 0x11, 0xef53, 0x794c7630, 0x9123683e, 0x58465342, 0x2fc12fc1,
      0xf2f52010,
    ].includes(fs.type)
  )
    throw Error("DECISION_STORE_LOCAL_FS_REQUIRED");
  return absolute;
}

async function readPrivate(path: string): Promise<unknown> {
  const file = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const stat = await file.stat();
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.uid !== process.getuid?.() ||
      (stat.mode & 0o077) !== 0 ||
      stat.size > 8192
    )
      throw Error("DECISION_STORE_UNSAFE");
    const bytes = Buffer.alloc(8193);
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
    if (bytesRead > 8192) throw Error("DECISION_STORE_UNSAFE");
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        bytes.subarray(0, bytesRead),
      ),
    ) as unknown;
  } finally {
    await file.close();
  }
}
async function syncDirectory(store: string) {
  const dir = await open(
    store,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    await dir.sync();
  } finally {
    await dir.close();
  }
}
async function writePrivate(store: string, name: string, value: unknown) {
  const temp = join(store, `.write-${randomUUID()}`);
  const file = await open(temp, "wx", 0o600);
  try {
    try {
      await file.writeFile(JSON.stringify(value));
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temp, join(store, name));
    await syncDirectory(store);
  } finally {
    await unlink(temp).catch(() => {});
  }
}
async function locked<T>(
  store: string,
  operation: () => Promise<T>,
): Promise<T> {
  try {
    await mkdir(join(store, ".lock"), { mode: 0o700 });
  } catch (error) {
    throw Error(
      (error as NodeJS.ErrnoException).code === "EEXIST"
        ? "DECISION_STORE_BUSY"
        : "DECISION_STORE_UNAVAILABLE",
    );
  }
  try {
    await syncDirectory(store);
    return await operation();
  } finally {
    await rmdir(join(store, ".lock"));
    await syncDirectory(store);
  }
}

export async function initializeDecisionStore(
  path: string,
  budget: DecisionBudget,
): Promise<void> {
  const config = configSchema.parse({
    ...budgetSchema.parse(budget),
    schemaVersion: 1,
    model: DECISION_MODEL,
    rateCard: DECISION_RATE_CARD,
  });
  // Exclusive creation prevents silently resetting an existing ledger's budget.
  await mkdir(resolve(path), { mode: 0o700 });
  let store: string;
  try {
    store = await checkedStore(path);
  } catch (error) {
    await rmdir(resolve(path)).catch(() => {});
    throw error;
  }
  await locked(store, () => writePrivate(store, "config.json", config));
  await syncDirectory(dirname(store));
}
async function readStatus(store: string) {
  const config = configSchema.parse(
    await readPrivate(join(store, "config.json")),
  );
  const records: DecisionRecord[] = [];
  for (const name of await readdir(store)) {
    if (
      ["config.json", ".lock", ".DS_Store"].includes(name) ||
      /^\.write-[a-f0-9-]+$/.test(name)
    )
      continue;
    if (!/^[a-f0-9]{64}\.json$/.test(name))
      throw Error("DECISION_STORE_CORRUPT");
    const record = recordSchema.parse(await readPrivate(join(store, name)));
    if (`${record.digest}.json` !== name) throw Error("DECISION_STORE_CORRUPT");
    records.push(record);
  }
  return {
    config,
    records,
    calls: records.length,
    chargedOrHeldMicroUSD: records.reduce(
      (sum, record) =>
        sum +
        Number(
          record.status === "answered"
            ? decisionCostMicroUSD(record.inputTokens!)
            : DECISION_CALL_HOLD_MICRO_USD,
        ),
      0,
    ),
    chargedOrHeldInputTokens: records.reduce(
      (sum, record) =>
        sum +
        (record.status === "answered"
          ? record.inputTokens!
          : DECISION_MAX_INPUT_TOKENS),
      0,
    ),
    unknown: records.filter((record) => record.status !== "answered").length,
  };
}
export async function decisionStoreStatus(path: string) {
  const store = await checkedStore(path);
  // Reporting is a non-transactional snapshot; admission always scans under the writer lock.
  return { ...(await readStatus(store)), snapshot: "best_effort" as const };
}
export async function runStoredDecision(
  path: string,
  request: DecisionRequest,
  send: (request: DecisionRequest) => Promise<DecisionAdviceResult>,
): Promise<DecisionRecord> {
  const snapshot = buildDecisionRequest(request.input);
  if (
    request.digest !== snapshot.digest ||
    JSON.stringify(request.body) !== JSON.stringify(snapshot.body)
  )
    throw Error("DECISION_REQUEST_INVALID");
  const store = await checkedStore(path);
  return locked(store, async () => {
    const current = await readStatus(store);
    if (snapshot.input.scopeId !== current.config.scopeId)
      throw Error("DECISION_SCOPE_MISMATCH");
    const existing = current.records.find(
      (record) => record.digest === snapshot.digest,
    );
    if (existing) return existing;
    if (
      current.calls >= current.config.maxCalls ||
      current.chargedOrHeldMicroUSD + Number(DECISION_CALL_HOLD_MICRO_USD) >
        current.config.maxMicroUSD ||
      current.chargedOrHeldInputTokens + DECISION_MAX_INPUT_TOKENS >
        current.config.maxInputTokens
    )
      throw Error("DECISION_BUDGET_EXHAUSTED");
    const pending: DecisionRecord = {
      schemaVersion: 1,
      digest: snapshot.digest,
      status: "dispatched",
    };
    const filename = `${snapshot.digest}.json`;
    // The durable hold and duplicate barrier must precede all provider I/O.
    await writePrivate(store, filename, pending);
    let final: DecisionRecord = { ...pending, status: "unknown" };
    try {
      const result = await send(snapshot);
      if (result.status === "answered") {
        const answer = parseDecisionAnswer(
          {
            model: result.answer.model,
            answers: {
              decision: {
                type: "choice",
                choice: result.answer.choice,
                probabilities: result.answer.probabilities,
                confidence: result.answer.confidence,
              },
            },
            usage: {
              input_tokens: result.answer.inputTokens,
              output_tokens: result.answer.outputTokens,
            },
          },
          snapshot,
        );
        final = {
          ...pending,
          status: "answered",
          choice: answer.choice,
          confidence: answer.confidence,
          inputTokens: answer.inputTokens,
          outputTokens: answer.outputTokens,
        };
      } else {
        // Retain only known error categories, never the provider's body or an exception.
        final = recordSchema.parse({
          ...pending,
          status: "unknown",
          failureReason: result.reason,
          ...(result.httpStatus === undefined
            ? {}
            : { httpStatus: result.httpStatus }),
        });
      }
    } catch {
      /* Unknown outcome retains the full hold, without logging provider errors. */
    }
    await writePrivate(store, filename, final);
    return final;
  });
}
