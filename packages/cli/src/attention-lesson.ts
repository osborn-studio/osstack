import { constants } from "node:fs";
import { link, lstat, mkdir, open, realpath, unlink } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { attentionDigest } from "@osstack/core";
import { z } from "zod";
import { attentionDisplayText } from "./attention-dashboard.js";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const id = z.string().min(1).max(256);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const receiptSchema = z.object({
  schema_version: z.literal(1), kind: z.literal("investigation"), qualification: z.literal("ordinary_run_unverified"),
  tenant: z.literal("default"), scope_id: digest, repo_path: z.string().min(1).max(4096), task_id: id, run_id: id,
  family: z.enum(["run_failed", "run_completed_unverified", "run_state_unknown"]),
  source_hash: digest, event_count: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  through_seq: z.number().int().min(-1).max(Number.MAX_SAFE_INTEGER), history_complete: z.boolean(),
  event_hashes: z.array(digest).max(128),
}).strict();
export type EvidenceLessonReceipt = z.infer<typeof receiptSchema>;
export type EvidenceLessonReadResult = { state: "candidate"; receipt: EvidenceLessonReceipt } | { state: "unknown"; reason: string };
export interface RunLessonInput { runId: string; repoPath: string; default_tenant: true }
export interface EvidenceLessonWriteResult {
  state: "draft" | "reviewed" | "unknown"; kind?: "investigation"; qualification?: "ordinary_run_unverified";
  path?: string; created?: boolean; reason?: string; promoted: false;
}

/** Host RPC reader: authenticated service supplies its existing DB. No open, migration, mutation or model. */
export async function readEvidenceLesson(db: Database.Database, input: RunLessonInput): Promise<EvidenceLessonReadResult> {
  if (input.default_tenant !== true || !id.safeParse(input.runId).success || !isAbsolute(input.repoPath)) throw Error("explicit_run_repo_default_tenant_required");
  let repo: string;
  try { repo = await realpath(input.repoPath); if (!(await lstat(repo)).isDirectory()) throw Error(); }
  catch { return { state: "unknown", reason: "workspace_unavailable" }; }
  try {
    return db.transaction((): EvidenceLessonReadResult => {
      const row = db.prepare(`SELECT r.run_id,substr(r.task_id,1,257) task_id,substr(r.session_id,1,257) session_id,substr(r.phase,1,257) phase,substr(r.outcome,1,257) outcome,r.started_at,r.completed_at,t.created_at task_created_at,substr(s.scope_id,1,65) scope_id,substr(o.home_id,1,257) home_id,substr(u.binding_hash,1,65) binding_hash
        FROM runs r JOIN tasks t ON t.task_id=r.task_id JOIN attention_scopes s ON s.task_id=t.task_id
        JOIN attention_subjects u ON u.scope_id=s.scope_id AND u.kind='run' AND u.subject_id=r.run_id
        JOIN daemon_owner o ON o.singleton=1
        WHERE r.run_id=? AND r.tenant_id IS NULL AND t.tenant_id IS NULL AND s.repo_path=? AND u.admitted=1 LIMIT 2`).all(input.runId, repo) as Array<Record<string, unknown>>;
      if (row.length !== 1) return { state: "unknown", reason: "source_not_found_or_unbound" };
      const run = row[0]!;
      if (run["scope_id"] !== attentionDigest([run["home_id"], run["task_id"], repo, run["task_created_at"]])
        || run["binding_hash"] !== attentionDigest([run["scope_id"], "run", input.runId])) return { state: "unknown", reason: "source_not_found_or_unbound" };
      const stats = db.prepare("SELECT COUNT(*) n,COALESCE(MAX(seq),-1) last,COALESCE(SUM(CASE WHEN session_id IS NOT ? THEN 1 ELSE 0 END),0) conflicts FROM events WHERE run_id=?").get(run["session_id"], input.runId) as { n: number; last: number; conflicts: number };
      if (stats.conflicts !== 0) return { state: "unknown", reason: "source_session_conflict" };
      const events = db.prepare(`SELECT substr(event_id,1,257) event_id,substr(session_id,1,257) session_id,seq,substr(type,1,257) type,created_at,terminal,
        length(CAST(payload_json AS BLOB)) bytes
        FROM events WHERE run_id=? ORDER BY seq LIMIT 128`).all(input.runId) as Array<{ event_id: string; session_id: string; seq: number; type: string; created_at: number; terminal: number; bytes: number }>;
      if (events.some(event => event.session_id !== run["session_id"])) return { state: "unknown", reason: "source_session_conflict" };
      let previous = events[0]?.seq === 1 ? 0 : -1;
      const complete = events.length === stats.n && events.every(event => {
        const valid = event.seq === previous + 1 && event.bytes <= 4096 && event.event_id.length <= 256 && event.type.length <= 256;
        previous = event.seq; return valid;
      });
      const sourceHash = hash({ run, repo, stats, events });
      const receipt = receiptSchema.parse({ schema_version: 1, kind: "investigation", qualification: "ordinary_run_unverified", tenant: "default",
        scope_id: run["scope_id"], repo_path: repo, task_id: run["task_id"], run_id: run["run_id"],
        family: run["outcome"] === "failed" ? "run_failed" : run["outcome"] === "completed" ? "run_completed_unverified" : "run_state_unknown",
        source_hash: sourceHash, event_count: stats.n, through_seq: stats.last, history_complete: complete, event_hashes: events.map(hash) });
      return { state: "candidate", receipt };
    })();
  } catch { return { state: "unknown", reason: "source_unavailable" }; }
}

function display(value: string): string {
  return attentionDisplayText(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/[\\`*_{}[\]()#+.!|~-]/g, "\\$&");
}
function candidate(receipt: EvidenceLessonReceipt) {
  const key = hash([receipt.scope_id, receipt.task_id, receipt.family, receipt.source_hash]);
  const draftId = `evidence-${key.slice(0, 48)}`;
  const markdown = [`# Lesson Draft: ${draftId}`, "", "> Investigation only — ordinary adapter outcomes are not independent verification.",
    "> Review required. No success-after-repair claim, approval, skill change or publication.", "", "## Evidence provenance",
    `- Scope: ${receipt.scope_id}`, `- Run: ${display(receipt.run_id)}`, `- Task: ${display(receipt.task_id)}`,
    `- Family: ${receipt.family}`, `- Source snapshot hash: ${receipt.source_hash}`, `- Candidate key: ${key}`,
    `- Retained events: ${receipt.event_hashes.length}/${receipt.event_count}; through sequence ${receipt.through_seq}; history ${receipt.history_complete ? "complete within read bounds" : "incomplete"}.`,
    "- Source hash covers bounded persisted metadata only, excluding payload contents. Recheck current source before adoption.",
    ...receipt.event_hashes.map((value, index) => `- Event ${index + 1} snapshot hash: ${value}`), "", "## Reusable Rule",
    "Do not infer verified recovery from an adapter's completion message. Obtain independently bound failure, repair and final verification evidence before adopting a lesson.",
    "", "## Suggested Evaluation", "- Reproduce the failure and inspect a verified repair of the same task and candidate; record actual verifier outcomes.",
    "", "## Suggested Target Skill", "- Not inferable from unverified run evidence", ""].join("\n");
  return { state: "candidate" as const, kind: receipt.kind, qualification: receipt.qualification, draftId, markdown, receipt };
}
export async function inspectRunLessonEvidence(db: Database.Database, input: RunLessonInput) {
  const result = await readEvidenceLesson(db, input);
  return result.state === "candidate" ? candidate(result.receipt) : result;
}

/** Reject every existing symlink component, even one pointing inside the repository. */
async function directory(repo: string, relativePath: string, create = false): Promise<string> {
  const target = resolve(repo, relativePath);
  const rel = relative(repo, target);
  if (!rel || isAbsolute(rel) || rel === ".." || rel.startsWith(".." + sep)) throw Error("unsafe_lesson_path");
  let current = repo;
  for (const part of rel.split(sep)) {
    current = join(current, part);
    try {
      const stat = await lstat(current);
      if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(current) !== current) throw Error("unsafe_lesson_path");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (create) { try { await mkdir(current, { mode: 0o700 }); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; }
        if (!(await lstat(current)).isDirectory() || await realpath(current) !== current) throw Error("unsafe_lesson_path"); }
    }
  }
  return target;
}
async function safeRead(path: string): Promise<{ content?: string } | null> {
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await file.stat(); if (!stat.isFile()) throw Error("unsafe_lesson_file");
    if (stat.size > 1024 * 1024) return {};
    const bytes = Buffer.alloc(1024 * 1024 + 1); const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    if (bytesRead > 1024 * 1024) return {};
    return { content: bytes.subarray(0, bytesRead).toString("utf8") };
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw Error("unsafe_lesson_file"); }
  finally { await file?.close(); }
}
async function existsEntry(path: string): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}
async function publishDraft(repo: string, dir: string, path: string, content: string, beforeWrite?: () => Promise<void>): Promise<boolean> {
  const temporary = join(dir, `.evidence-${randomUUID()}.tmp`);
  await directory(repo, "loop-lessons/drafts");
  const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    await file.writeFile(content, "utf8"); await file.sync();
    await beforeWrite?.(); await directory(repo, "loop-lessons/drafts");
    try { await link(temporary, path); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") return false; throw error; }
  } finally { await file.close(); await unlink(temporary); }
}
export async function writeEvidenceLessonDraft(value: unknown, options: { repoPath: string; beforeWrite?: () => Promise<void> }): Promise<EvidenceLessonWriteResult> {
  const receipt = receiptSchema.parse(value); const repo = await realpath(options.repoPath);
  if (repo !== receipt.repo_path) throw Error("lesson_workspace_mismatch");
  const draft = candidate(receipt);
  const dirs = await Promise.all(["drafts", "promoted", "discarded"].map(name => directory(repo, `loop-lessons/${name}`)));
  for (const dir of dirs.slice(1)) if (await existsEntry(join(dir, `${draft.draftId}.md`)) || await existsEntry(join(dir, `${draft.draftId}-r${hash(draft.markdown).slice(0, 16)}.md`)))
    return { state: "reviewed", kind: "investigation", qualification: receipt.qualification, created: false, promoted: false };
  const dir = await directory(repo, "loop-lessons/drafts", true);
  let path = join(dir, `${draft.draftId}.md`); let content = draft.markdown;
  const existing = await safeRead(path);
  if (existing?.content === content) return { state: "draft", path, created: false, kind: "investigation", qualification: receipt.qualification, promoted: false };
  if (existing !== null) {
    const prior = draft.draftId; path = join(dir, `${prior}-r${hash(content).slice(0, 16)}.md`);
    content += `\n## Revision provenance\nRevision of ${prior}; existing user content was preserved.\n`;
    const revision = await safeRead(path);
    if (revision !== null && revision.content !== content) return { state: "draft", path, created: false, reason: "lesson_revision_conflict_preserved", kind: "investigation", qualification: receipt.qualification, promoted: false };
    if (revision?.content === content) return { state: "draft", path, created: false, kind: "investigation", qualification: receipt.qualification, promoted: false };
  }
  const created = await publishDraft(repo, dir, path, content, options.beforeWrite);
  if (!created && (await safeRead(path))?.content !== content) throw Error("lesson_create_conflict");
  return { state: "draft", path, created, kind: "investigation", qualification: receipt.qualification, promoted: false };
}
export async function writeRunLessonDraft(db: Database.Database, input: RunLessonInput): Promise<EvidenceLessonWriteResult> {
  const result = await readEvidenceLesson(db, input);
  if (result.state === "unknown") return { ...result, promoted: false };
  return writeEvidenceLessonDraft(result.receipt, { repoPath: input.repoPath, beforeWrite: async () => {
    const fresh = await readEvidenceLesson(db, input);
    if (fresh.state !== "candidate" || fresh.receipt.source_hash !== result.receipt.source_hash) throw Error("lesson_source_changed");
  } });
}
export async function handleEvidenceLessonCommand(args: string[], io: { stdout?: (line: string) => void; rpc?: (method: string, params?: unknown, timeoutMs?: number) => Promise<unknown> } = {}): Promise<number> {
  const flags = new Map<string, string>(); let tenant = false; let preview = false; let json = false;
  for (let index = 1; index < args.length; index++) {
    const key = args[index]!;
    if (key === "--default-tenant" && !tenant) { tenant = true; continue; }
    if (key === "--dry-run" && !preview) { preview = true; continue; }
    if (key === "--json" && !json) { json = true; continue; }
    const value = args[++index];
    if (!["--from-run", "--repo"].includes(key) || flags.has(key) || !value || value.startsWith("--")) throw Error("invalid_lesson_arguments");
    flags.set(key, value);
  }
  if (!tenant || !flags.get("--from-run") || !flags.get("--repo")) throw Error("explicit_run_repo_default_tenant_required");
  if (!io.rpc) throw Error("daemon_connection_required");
  const params: RunLessonInput = { runId: flags.get("--from-run")!, repoPath: await realpath(flags.get("--repo")!), default_tenant: true };
  const read = async () => {
    const response = z.object({ ok: z.literal(true), result: z.union([z.object({ state: z.literal("candidate"), receipt: receiptSchema }).strict(), z.object({ state: z.literal("unknown"), reason: z.string().max(256) }).strict()]) }).passthrough().parse(await io.rpc!("attention.lesson-evidence", params, 1000));
    if (response.result.state === "candidate" && (response.result.receipt.run_id !== params.runId || response.result.receipt.repo_path !== params.repoPath)) throw Error("lesson_receipt_identity_mismatch");
    return response.result;
  };
  const result = await read();
  const output = result.state === "unknown" || preview ? result : await writeEvidenceLessonDraft(result.receipt, { repoPath: params.repoPath, beforeWrite: async () => {
    const fresh = await read(); if (fresh.state !== "candidate" || fresh.receipt.source_hash !== result.receipt.source_hash) throw Error("lesson_source_changed");
  } });
  (io.stdout ?? console.log)(JSON.stringify(output, null, 2));
  return result.state === "unknown" ? 1 : 0;
}
