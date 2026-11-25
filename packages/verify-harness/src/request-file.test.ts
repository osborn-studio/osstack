import { chmod, mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { buildRecord } from "./record.js";
import { writeEvidence, writeRequestFile, type HarnessRequest } from "./request-file.js";
import { base, entry, head, id, recordInput } from "./testkit/fixtures.js";

const request = (): HarnessRequest => ({ version: 1, repository_id: 101, pr: 3, skill_id: entry.skill_id,
  head_sha: head, base_sha: base, record: buildRecord(recordInput()) });
const temp = () => mkdtemp(join(tmpdir(), "request-"));
const mode = async (path: string) => (await stat(path)).mode & 0o777;
it("publishes a group-readable request once under concurrent writes", async () => {
  const dir = await temp();
  const results = await Promise.allSettled([writeRequestFile(dir, request()), writeRequestFile(dir, request())]);
  expect(results.filter(item => item.status === "fulfilled")).toEqual([{ status: "fulfilled", value: id + ".json" }]);
  expect(await readdir(dir)).toEqual([id + ".json"]);
  expect(await mode(join(dir, id + ".json"))).toBe(0o640);
});
it.each([0o077, 0])("publishes with mode 0640 under umask %i", async mask => {
  const dir = await temp();
  const previous = process.umask(mask);
  try {
    const file = await writeRequestFile(dir, request());
    expect(await mode(join(dir, file))).toBe(0o640);
  } finally {
    process.umask(previous);
  }
});
it("inherits the drop directory's group when the set-group-ID bit is retained", async () => {
  const dir = await temp();
  await chmod(dir, 0o2750);
  const directory = await stat(dir);
  const file = await writeRequestFile(dir, request());
  const published = await stat(join(dir, file));
  expect(published.mode & 0o777).toBe(0o640);
  if (directory.mode & 0o2000) expect(published.gid).toBe(directory.gid);
});
it("preserves an existing request", async () => {
  const dir = await temp();
  const path = join(dir, id + ".json");
  await writeFile(path, "existing");
  await expect(writeRequestFile(dir, request())).rejects.toThrow(/^request_write_failed$/);
  expect(await readFile(path, "utf8")).toBe("existing");
  expect(await readdir(dir)).toEqual([id + ".json"]);
});
it("rejects oversized UTF-8 text, unsafe names and relative directories", async () => {
  const dir = await temp();
  for (const change of [{ summary: "é".repeat(132000) }, { invocation_id: "../escape" }]) {
    const value = request();
    Object.assign(value.record, change);
    await expect(writeRequestFile(dir, value)).rejects.toThrow(/^request_write_failed$/);
  }
  await expect(writeRequestFile("relative", request())).rejects.toThrow(/^request_write_failed$/);
  expect(await readdir(dir)).toEqual([]);
});
it("writes captured bytes and receipt into a private evidence directory", async () => {
  const root = await temp();
  const { result } = recordInput();
  await expect(writeEvidence(root, "../escape", result)).rejects.toThrow(/^request_write_failed$/);
  await writeEvidence(root, id, result);
  const dir = join(root, id);
  expect(await mode(dir)).toBe(0o700);
  expect((await readdir(dir)).sort()).toEqual(["stderr", "stdout", "stop-receipt.json"]);
  for (const file of ["stdout", "stderr", "stop-receipt.json"]) expect(await mode(join(dir, file))).toBe(0o600);
  for (const stream of ["stdout", "stderr"] as const) expect(await readFile(join(dir, stream))).toEqual(result[stream].bytes);
  expect(JSON.parse(await readFile(join(dir, "stop-receipt.json"), "utf8"))).toEqual(result.stopReceipt);
});
