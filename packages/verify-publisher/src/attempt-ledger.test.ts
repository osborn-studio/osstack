import { randomUUID } from "node:crypto";
import { readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createFileAttemptLedger, type AttemptLedgerEntry } from "./attempt-ledger.js";
import { request, uuid } from "./testkit/fixtures.js";

const path = join(tmpdir(), randomUUID()), ledger = createFileAttemptLedger(path);
const { record, repository_id, pr, head_sha, base_sha, skill_id } = request();
const common = { v: 1, result_id: uuid(1), at: record.finished_at } as const;
const intent = { ...common, kind: "intent", invocation_id: record.invocation_id, repository_id, pr, head_sha, base_sha,
  skill_id, attempt: 1, text: "contract" } as const;
const published = { ...common, kind: "published", check_run_id: 1 } as const;
const abandoned = { ...common, kind: "abandoned" } as const;
const jsonl = (...rows: unknown[]) => rows.map(r => JSON.stringify(r) + "\n").join("");
afterEach(async () => { await rm(path, { force: true }); });

it("appends exact lines with private permissions and reopens them in order", async () => {
  await ledger.withLock(async s => {
    expect(s.entries).toEqual([]);
    expect((await stat(path + ".lock")).mode & 0o777).toBe(0o600);
    await s.append(intent);
    await s.append(published);
    expect(s.entries).toEqual([intent, published]);
  });
  expect(await readFile(path, "utf8")).toBe(jsonl(intent, published));
  expect((await stat(path)).mode & 0o777).toBe(0o600);
  expect(await createFileAttemptLedger(path).withLock(async s => s.entries)).toEqual([intent, published]);
});

it("excludes another session and releases the lock after a throwing action", async () => {
  await expect(ledger.withLock(async () => {
    await expect(createFileAttemptLedger(path).withLock(async () => 1)).rejects.toThrow("ATTEMPT_LEDGER_LOCKED");
    throw new Error("action");
  })).rejects.toThrow("action");
  await ledger.withLock(async s => s.append(intent));
});

it.each([
  "bad json\n", "\n", JSON.stringify(intent), jsonl({ ...intent, unknown: 0 }), jsonl({ ...intent, attempt: 0 }),
  jsonl({ ...intent, text: "界".repeat(5462) }), jsonl(published), jsonl(abandoned),
  jsonl(intent, { ...intent, invocation_id: uuid(3) }), jsonl(intent, { ...intent, result_id: uuid(3) }),
  jsonl(intent, published, abandoned), jsonl(intent, abandoned, published), jsonl(intent, published, published),
])("fails closed on corrupt file %#", async content => {
  await writeFile(path, content);
  await expect(ledger.withLock(async () => 1)).rejects.toThrow("ATTEMPT_LEDGER_CORRUPT");
  expect(await readFile(path, "utf8")).toBe(content);
  await expect(stat(path + ".lock")).rejects.toMatchObject({ code: "ENOENT" });
});

it.each([published, abandoned, { ...intent, unexpected: 1 }])("validates before creating a ledger %#", async entry => {
  await expect(ledger.withLock(async s => s.append(entry as AttemptLedgerEntry))).rejects.toThrow("ATTEMPT_LEDGER_CORRUPT");
  await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
});

it("serializes simultaneous appends against the latest durable state", async () => {
  await expect(ledger.withLock(async s => Promise.all([s.append(intent), s.append(intent)]))).rejects.toThrow("ATTEMPT_LEDGER_CORRUPT");
  expect(await readFile(path, "utf8")).toBe(jsonl(intent));
});
