import { mkdtempSync, realpathSync } from "node:fs";
import { mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { AttentionStore, attentionDigest, appendEvent, insertRun, insertTask, openDb } from "@osstack/core";
import type Database from "better-sqlite3";
import { handleEvidenceLessonCommand, readEvidenceLesson, inspectRunLessonEvidence, writeRunLessonDraft } from "./attention-lesson.js";

let root: string; let db: Database.Database; let path: string; let store: AttentionStore; let scopeId: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "evidence-lesson-"))); path = join(root, "state.db"); db = openDb({ path });
  store = new AttentionStore(db, path); const owner = store.claimOwner("test");
  insertTask(db, path, { task_id: "task", title: "SECRET_PROMPT", created_at: 1 });
  insertRun(db, path, { run_id: "run", task_id: "task", session_id: "session", agent_id: "agent", capability_id: "code", phase: "done", started_at: 1 });
  scopeId = store.registerScope(owner, "task", root).scope_id;
  db.prepare("INSERT INTO attention_subjects(scope_id,kind,subject_id,binding_hash,source_version,admitted,discovered_at,sampled_at,generation,payload_json) VALUES(?,'run','run',?,1,1,1,1,1,'{}')").run(scopeId, attentionDigest([scopeId, 'run', 'run']));
  appendEvent(db, path, { event_id: "event", run_id: "run", session_id: "session", seq: 1, type: "done", created_at: 2, terminal: true, payload: { passed: true, reviewed: true, status: "completed", secret: "SECRET_TOKEN" } });
});
afterEach(async () => { if (db.open) db.close(); await rm(root, { recursive: true, force: true }); });
const input = () => ({ runId: "run", repoPath: root, default_tenant: true as const });

it("uses real persisted evidence but never promotes ordinary done/passed events to verified recovery", async () => {
  const preview = await inspectRunLessonEvidence(db, input());
  expect(preview).toMatchObject({ state: "candidate", kind: "investigation", qualification: "ordinary_run_unverified" });
  if (preview.state !== "candidate") throw Error("missing candidate");
  expect(preview.markdown).not.toContain("SECRET_PROMPT"); expect(preview.markdown).not.toContain("SECRET_TOKEN");
  expect(preview.markdown).not.toContain("success after");
  db.pragma("query_only=ON");
  const written = await writeRunLessonDraft(db, input());
  expect(written.state).toBe("draft");
  expect(await readFile(written.path!, "utf8")).toContain("Investigation only");
});

it("is idempotent and preserves edits through explicit revision candidates", async () => {
  const first = await writeRunLessonDraft(db, input()); const second = await writeRunLessonDraft(db, input());
  expect(second).toMatchObject({ state: "draft", path: first.path, created: false });
  await writeFile(first.path!, "human edit");
  const revision = await writeRunLessonDraft(db, input());
  expect(revision.path).not.toBe(first.path); expect(await readFile(first.path!, "utf8")).toBe("human edit");
  expect(await readFile(revision.path!, "utf8")).toContain("Revision of");
  expect((await writeRunLessonDraft(db, input())).path).toBe(revision.path);
});

it.each(["foreign", "released", "wrong_repo"])("rejects an unbound source: %s", async mode => {
  let repoPath = root;
  if (mode === "foreign") db.prepare("UPDATE tasks SET tenant_id='foreign'").run();
  if (mode === "released") db.prepare("UPDATE attention_subjects SET admitted=0").run();
  if (mode === "wrong_repo") { repoPath = join(root, "other"); await mkdir(repoPath); }
  const result = await writeRunLessonDraft(db, { ...input(), repoPath });
  expect(result).toMatchObject({ state: "unknown", reason: "source_not_found_or_unbound" });
});

it.each(["drafts", "promoted", "discarded"])("rejects a symlinked %s directory without writing outside", async name => {
  const outside = join(root, "outside"); await mkdir(outside); await mkdir(join(root, "loop-lessons"));
  await symlink(outside, join(root, "loop-lessons", name));
  await expect(writeRunLessonDraft(db, input())).rejects.toThrow(/unsafe_lesson_path/);
  expect(await readdir(outside)).toEqual([]);
});

it("executes the real RPC handler and does not accept supplied truth flags", async () => {
  const logs: string[] = [];
  expect(await handleEvidenceLessonCommand(["lesson", "--from-run", "run", "--repo", root, "--default-tenant", "--json"], { stdout: line => logs.push(line), rpc: async (_method, params) => ({ ok: true, result: await readEvidenceLesson(db, params as ReturnType<typeof input>) }) })).toBe(0);
  expect(JSON.parse(logs[0]!)).toMatchObject({ state: "draft", kind: "investigation", promoted: false });
  await expect(handleEvidenceLessonCommand(["lesson", "--from-run", "run", "--repo", root, "--default-tenant", "--passed", "true"], {})).rejects.toThrow(/invalid/);
});

it("uses the existing review lifecycle and does not recreate promoted or discarded candidates", async () => {
  const { listLessonDrafts, readLessonDraft, promoteLessonDraft, discardLessonDraft } = await import("@osstack/loop");
  const result = await writeRunLessonDraft(db, input());
  const entry = (await listLessonDrafts(root))[0]!;
  expect((await readLessonDraft(root, entry.id))?.content).toContain("Investigation only");
  expect((await promoteLessonDraft(root, entry.id)).promoted).toBe(true);
  expect((await writeRunLessonDraft(db, input())).state).toBe("reviewed");
  appendEvent(db, path, { event_id: "later", run_id: "run", session_id: "session", seq: 2, type: "progress", created_at: 3, terminal: false, payload: { note: "source changed" } });
  const next = await writeRunLessonDraft(db, input()); expect(next.path).not.toBe(result.path);
  const nextEntry = (await listLessonDrafts(root))[0]!;
  expect((await discardLessonDraft(root, nextEntry.id)).discarded).toBe(true);
  expect((await writeRunLessonDraft(db, input())).state).toBe("reviewed");
});

it("fails closed for missing source/schema and discloses bounded history", async () => {
  db.prepare("UPDATE events SET payload_json=?").run('"' + "s".repeat(5000) + '"');
  const result = await readEvidenceLesson(db, input());
  expect(result).toMatchObject({ state: "candidate", receipt: { history_complete: false, event_count: 1 } });
  expect(await readEvidenceLesson(db, { ...input(), runId: "missing" })).toMatchObject({ state: "unknown" });
  const { default: Sqlite } = await import("better-sqlite3"); const old = new Sqlite(":memory:");
  try { expect(await readEvidenceLesson(old, input())).toMatchObject({ state: "unknown", reason: "source_unavailable" }); }
  finally { old.close(); }
});

it("rejects forged RPC qualifications, missing daemon, and source changes before publication", async () => {
  const args = ["lesson", "--from-run", "run", "--repo", root, "--default-tenant"];
  await expect(handleEvidenceLessonCommand(args)).rejects.toThrow("daemon_connection_required");
  const result = await readEvidenceLesson(db, input()); if (result.state !== "candidate") throw Error();
  await expect(handleEvidenceLessonCommand(args, { stdout: () => {}, rpc: async () => ({ ok: true, result: { state: "candidate", receipt: { ...result.receipt, kind: "success-after-repair", passed: true } } }) })).rejects.toThrow();
  let calls = 0;
  await expect(handleEvidenceLessonCommand(args, { stdout: () => {}, rpc: async () => {
    if (++calls === 2) db.prepare("UPDATE runs SET phase='changed'").run();
    return { ok: true, result: await readEvidenceLesson(db, input()) };
  } })).rejects.toThrow("lesson_source_changed");
  expect(await readdir(join(root, "loop-lessons/drafts"))).toEqual([]);
});

it("rejects a symlink final file and preserves concurrently created candidates", async () => {
  const preview = await inspectRunLessonEvidence(db, input()); if (preview.state !== "candidate") throw Error();
  const dir = join(root, "loop-lessons/drafts"); await mkdir(dir, { recursive: true });
  const privatePath = join(root, "private"); await writeFile(privatePath, "untouched");
  const target = join(dir, `${preview.draftId}.md`); await symlink(privatePath, target);
  await expect(writeRunLessonDraft(db, input())).rejects.toThrow("unsafe_lesson_file");
  expect(await readFile(privatePath, "utf8")).toBe("untouched"); await rm(target);
  const outputs = await Promise.all([writeRunLessonDraft(db, input()), writeRunLessonDraft(db, input())]);
  expect(outputs[0]?.path).toBe(outputs[1]?.path);
  expect(outputs.filter(output => output.created)).toHaveLength(1);
  expect((await readdir(dir)).filter(name => name.endsWith(".tmp"))).toEqual([]);
});

it("does not reintroduce a reviewed revision while preserving the original user edit", async () => {
  const { listLessonDrafts, promoteLessonDraft } = await import("@osstack/loop");
  const original = await writeRunLessonDraft(db, input()); await writeFile(original.path!, "human edit");
  const revision = await writeRunLessonDraft(db, input());
  const entry = (await listLessonDrafts(root)).find(item => item.path === revision.path)!;
  expect((await promoteLessonDraft(root, entry.id)).promoted).toBe(true);
  expect((await writeRunLessonDraft(db, input())).state).toBe("reviewed");
  expect(await readFile(original.path!, "utf8")).toBe("human edit");
});

it("enforces event bounds and rejects cross-session or run-tenant source contamination", async () => {
  for (let seq = 2; seq <= 130; seq++) appendEvent(db, path, { event_id: `e${seq}`, run_id: "run", session_id: "session", seq, type: "progress", created_at: seq, terminal: false, payload: {} });
  const receipt = await readEvidenceLesson(db, input());
  expect(receipt).toMatchObject({ state: "candidate", receipt: { event_count: 130, through_seq: 130, history_complete: false } });
  if (receipt.state === "candidate") expect(receipt.receipt.event_hashes).toHaveLength(128);
  db.prepare("UPDATE events SET session_id='foreign' WHERE seq=130").run();
  expect(await readEvidenceLesson(db, input())).toMatchObject({ state: "unknown", reason: "source_session_conflict" });
  db.prepare("UPDATE runs SET tenant_id='foreign'").run();
  expect(await readEvidenceLesson(db, input())).toMatchObject({ state: "unknown", reason: "source_not_found_or_unbound" });
});


it("binds RPC receipt identity to the requested run before preview or publication", async () => {
  const result = await readEvidenceLesson(db, input()); if (result.state !== "candidate") throw Error();
  for (const preview of [false, true]) await expect(handleEvidenceLessonCommand(["lesson", "--from-run", "run", "--repo", root, "--default-tenant", ...(preview ? ["--dry-run"] : [])], {
    stdout: () => {}, rpc: async () => ({ ok: true, result: { ...result, receipt: { ...result.receipt, run_id: "other" } } }),
  })).rejects.toThrow("lesson_receipt_identity_mismatch");
  expect((await readdir(root)).includes("loop-lessons")).toBe(false);
});

it("preserves oversized edits and treats oversized reviewed candidates as reviewed", async () => {
  const first = await writeRunLessonDraft(db, input()); const human = "human".repeat(300000);
  await writeFile(first.path!, human);
  const revision = await writeRunLessonDraft(db, input()); expect(revision.path).not.toBe(first.path);
  expect(await readFile(first.path!, "utf8")).toBe(human);
  const preview = await inspectRunLessonEvidence(db, input()); if (preview.state !== "candidate") throw Error();
  await mkdir(join(root, "loop-lessons/promoted"));
  await writeFile(join(root, "loop-lessons/promoted", preview.draftId + ".md"), human);
  expect((await writeRunLessonDraft(db, input())).state).toBe("reviewed");
});

it("does not expose payload-derived fingerprints in receipts", async () => {
  const before = await readEvidenceLesson(db, input());
  db.prepare("UPDATE events SET payload_json=replace(payload_json,'SECRET_TOKEN','PRIVATE_TEXT')").run();
  expect(await readEvidenceLesson(db, input())).toEqual(before);
});


it("reports a preserved edited revision conflict without overwriting or throwing", async () => {
  const first = await writeRunLessonDraft(db, input()); await writeFile(first.path!, "human base");
  const revision = await writeRunLessonDraft(db, input()); const edit = "r".repeat(1024 * 1024 + 1); await writeFile(revision.path!, edit);
  expect(await writeRunLessonDraft(db, input())).toMatchObject({ state: "draft", created: false, reason: "lesson_revision_conflict_preserved", path: revision.path });
  expect(await readFile(revision.path!, "utf8")).toBe(edit);
});
