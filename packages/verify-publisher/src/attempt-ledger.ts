import { open, readFile, unlink } from "node:fs/promises";
import { z } from "zod";
import { identifier, numericId, sha } from "./config.js";

const common = { v: z.literal(1), result_id: z.string().uuid(), at: z.string().datetime() };
const entrySchema = z.discriminatedUnion("kind", [
  z.object({ ...common, kind: z.literal("intent"), invocation_id: z.string().uuid(),
    repository_id: numericId, pr: numericId, head_sha: sha, base_sha: sha,
    skill_id: identifier, attempt: numericId, text: z.string().refine(v => Buffer.byteLength(v) <= 16384) }).strict(),
  z.object({ ...common, kind: z.literal("published"), check_run_id: numericId }).strict(),
  z.object({ ...common, kind: z.literal("abandoned") }).strict(),
]);

export type AttemptLedgerEntry = z.infer<typeof entrySchema>;
export interface AttemptLedgerSession {
  readonly entries: readonly AttemptLedgerEntry[];
  append(entry: AttemptLedgerEntry): Promise<void>;
}
export interface AttemptLedger {
  withLock<T>(action: (session: AttemptLedgerSession) => Promise<T>): Promise<T>;
}

const corrupt = () => new Error("ATTEMPT_LEDGER_CORRUPT");
function ledgerRows() {
  const entries: AttemptLedgerEntry[] = [];
  const results = new Map<string, "open" | "resolved">();
  const invocations = new Set<string>();
  function validate(value: unknown) {
    const parsed = entrySchema.safeParse(value);
    if (!parsed.success) throw corrupt();
    const entry = parsed.data;
    if (entry.kind === "intent") {
      if (results.has(entry.result_id) || invocations.has(entry.invocation_id)) throw corrupt();
    } else if (results.get(entry.result_id) !== "open") throw corrupt();
    return Object.freeze(entry);
  }
  function record(entry: AttemptLedgerEntry) {
    entries.push(entry);
    results.set(entry.result_id, entry.kind === "intent" ? "open" : "resolved");
    if (entry.kind === "intent") invocations.add(entry.invocation_id);
  }
  return { entries, validate, record };
}

async function readEntries(path: string) {
  const rows = ledgerRows();
  let bytes: Buffer;
  try { bytes = await readFile(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return rows;
    throw error;
  }
  let content: string;
  try { content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { throw corrupt(); }
  const lines = content.split("\n");
  if (lines.pop() !== "") throw corrupt();
  for (const line of lines) {
    let value: unknown;
    try { value = JSON.parse(line); } catch { throw corrupt(); }
    rows.record(rows.validate(value));
  }
  return rows;
}

export function createFileAttemptLedger(path: string): AttemptLedger {
  return { async withLock(action) {
    const lockPath = path + ".lock";
    const lock = await open(lockPath, "wx", 0o600).catch(error => {
      if (error.code === "EEXIST") throw new Error("ATTEMPT_LEDGER_LOCKED");
      throw error;
    });
    try {
      const rows = await readEntries(path);
      let active = true;
      let pending = Promise.resolve();
      try {
        return await action({
          get entries() { return rows.entries.slice(); },
          append(value) {
            if (!active) return Promise.reject(new Error("ATTEMPT_LEDGER_CLOSED"));
            pending = pending.then(async () => {
              const entry = rows.validate(value);
              const file = await open(path, "a", 0o600);
              try {
                await file.writeFile(JSON.stringify(entry) + "\n");
                await file.sync();
              } finally { await file.close(); }
              rows.record(entry);
            });
            return pending;
          },
        });
      } finally { active = false; await pending; }
    } finally {
      try { await lock.close(); } finally { await unlink(lockPath); }
    }
  } };
}
