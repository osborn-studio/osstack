import { createHash } from "node:crypto";
import {
  buildVerificationResult, decideVerificationSources, parseVerificationResultV1,
  type VerificationHarnessRecord, type VerificationPublication, type VerificationResultV1,
  type VerificationSourceObservation, type VerificationSourceRecord,
} from "@osstack/core/verification-publish";
import { z } from "zod";
import type { AttemptLedger, AttemptLedgerEntry, AttemptLedgerSession } from "./attempt-ledger.js";
import { numericId, parsePublishRequest, repository, sha, type PublisherAllowlist } from "./config.js";

type Reply = { ok: true; body: unknown } | { ok: false };
type Options = { signal: AbortSignal };
export interface PublisherGithub {
  get(path: string, options: Options): Promise<Reply>;
  createCheckRun: (repository: string, body: VerificationPublication["check_run"], options: Options) => Promise<Reply>;
}
export interface PublisherDeps { github: PublisherGithub; ledger: AttemptLedger; now: () => Date; uuid: () => string }
export type PublishRefusal =
  | "request_invalid" | "not_allowlisted" | "ledger_unavailable" | "invocation_abandoned" | "unresolved_intent"
  | "read_failed" | "pr_not_open" | "scope_mismatch" | "fork" | "head_moved" | "base_moved" | "already_verified"
  | "binding_changed" | "original_check_missing" | "build_refused" | "host_would_reject"
  | "write_unconfirmed" | "readback_mismatch" | "not_open";
export type PublishOutcome =
  | { ok: true; status: "published" | "recovered" | "already_published" | "abandoned"; result_id: string; attempt: number; check_run_id: number | null }
  | { ok: false; reason: PublishRefusal; detail: string | null };

type Intent = Extract<AttemptLedgerEntry, { kind: "intent" }>;
type Resolution = Exclude<AttemptLedgerEntry, Intent>;
type Binding = PublisherAllowlist["allow"][number];
const refuse = (reason: PublishRefusal, detail: string | null = null) => ({ ok: false, reason, detail }) as const;
const done = (status: Extract<PublishOutcome, { ok: true }>["status"], i: Intent, check_run_id: number | null) =>
  ({ ok: true, status, result_id: i.result_id, attempt: i.attempt, check_run_id }) as const;
const stamp = (deps: PublisherDeps) => deps.now().toISOString().replace(/\.\d{3}Z$/, "Z");
const conclusions = { passed: "success", failed: "failure", blocked: "action_required", cancelled: "cancelled" } as const;
const ref = z.string().min(1).max(255).regex(/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/u).refine(v =>
  !v.includes("..") && !v.includes("//") && !v.endsWith("/") && !v.endsWith(".") && !v.split("/").some(p => p.endsWith(".lock")));
const prSchema = z.object({
  number: numericId, state: z.string().min(1),
  head: z.object({ sha, ref, repo: z.object({ id: numericId }).nullable() }),
  base: z.object({ sha, ref, repo: z.object({ id: numericId, full_name: repository }) }),
});
const idBody = z.object({ id: numericId });
const listSchema = z.object({ total_count: z.number().int().min(0).max(100), check_runs: z.array(z.unknown()).max(100) });
const candidateSchema = z.object({ app: idBody, external_id: z.string() });
const detailSchema = z.object({ id: numericId, name: z.string(), head_sha: sha, external_id: z.string(),
  app: idBody, status: z.literal("completed"), conclusion: z.string(), output: z.object({ text: z.string() }) });

async function call(send: () => Promise<Reply>): Promise<Reply> {
  try { return await send(); } catch { return { ok: false }; }
}

function stored(i: Intent) {
  const parsed = parseVerificationResultV1(i.text);
  if (!parsed.ok) throw new Error("ATTEMPT_LEDGER_CORRUPT");
  const r = parsed.result;
  if (r.producer.type !== "App" || r.result_id !== i.result_id || r.invocation_id !== i.invocation_id
    || r.repository_id !== i.repository_id || r.pr !== i.pr || r.attempt !== i.attempt
    || r.head_sha !== i.head_sha || r.base_sha !== i.base_sha || r.skill_id !== i.skill_id) throw new Error("ATTEMPT_LEDGER_CORRUPT");
  return r;
}

function ledgerState(entries: readonly AttemptLedgerEntry[]) {
  const intents: Intent[] = [];
  const resolutions = new Map<string, Resolution>();
  for (const entry of entries) {
    if (entry.kind === "intent") intents.push(entry);
    else resolutions.set(entry.result_id, entry);
  }
  return { intents, resolutions };
}

type Readback = number | "absent" | "mismatch" | "failed";
async function readback(deps: PublisherDeps, i: Intent, options: Options, knownId?: number): Promise<Readback> {
  const r = stored(i);
  const name = "osstack/verify-intake/" + r.skill_id;
  const root = "repos/" + r.repository;
  const get = (path: string) => call(() => deps.github.get(root + path, options));
  let id = knownId;
  if (id === undefined) {
    const reply = await get("/commits/" + r.head_sha + "/check-runs?check_name=" + encodeURIComponent(name) + "&filter=all&per_page=100");
    const list = listSchema.safeParse(reply.ok ? reply.body : null);
    if (!list.success || list.data.total_count !== list.data.check_runs.length) return "failed";
    const candidates = list.data.check_runs.filter(row => {
      const candidate = candidateSchema.safeParse(row);
      return candidate.success && candidate.data.app.id === r.producer.app_id && candidate.data.external_id === i.result_id;
    });
    if (!candidates.length) return "absent";
    if (candidates.length !== 1) return "mismatch";
    const candidate = idBody.safeParse(candidates[0]);
    if (!candidate.success) return "failed";
    id = candidate.data.id;
  }
  const reply = await get("/check-runs/" + id);
  if (!reply.ok) return "failed";
  const parsed = detailSchema.safeParse(reply.body);
  if (!parsed.success) return "mismatch";
  const run = parsed.data;
  return run.id === id && run.name === name && run.head_sha === r.head_sha && run.external_id === i.result_id
    && run.app.id === r.producer.app_id && run.conclusion === conclusions[r.outcome] && run.output.text === i.text ? id : "mismatch";
}

async function confirm(deps: PublisherDeps, session: AttemptLedgerSession, i: Intent, options: Options,
  mode: "publish" | "recover" | "abandon", knownId?: number): Promise<PublishOutcome> {
  const found = await readback(deps, i, options, knownId);
  if (typeof found === "number") {
    await session.append({ v: 1, kind: "published", result_id: i.result_id, check_run_id: found, at: stamp(deps) });
    return done(mode === "publish" ? "published" : "recovered", i, found);
  }
  if (found === "mismatch") return refuse("readback_mismatch");
  if (found === "failed" && mode !== "publish") return refuse("read_failed");
  if (found === "absent" && mode === "abandon") {
    await session.append({ v: 1, kind: "abandoned", result_id: i.result_id, at: stamp(deps) });
    return done("abandoned", i, null);
  }
  return refuse("write_unconfirmed");
}

function sameBinding(r: VerificationResultV1, b: Binding) {
  return r.skill_id === b.skill_id && r.skill_version === b.skill_version && r.skill_blob === b.skill_blob
    && r.skill_manifest_digest === b.skill_manifest_digest && r.profile_id === b.profile_id && r.profile_digest === b.profile_digest
    && r.trusted_source.repository === b.trusted_source.repository && r.trusted_source.commit_sha === b.trusted_source.commit_sha
    && r.trusted_source.artifact_digest === b.trusted_source.artifact_digest;
}

function observation(r: VerificationResultV1, text: string, object_id: number): VerificationSourceObservation {
  if (r.producer.type !== "App") throw new Error("ATTEMPT_LEDGER_CORRUPT");
  return { source_kind: "check_run", object_id, repository_id: r.repository_id, repository: r.repository, pr: r.pr,
    observed_head_sha: r.head_sha, app_id: r.producer.app_id, check_name: "osstack/verify-intake/" + r.skill_id,
    response_digest: r.result_id, contract_digest: createHash("sha256").update(text).digest("hex"), verdict: { ok: true }, result: r };
}

function accepted(r: VerificationResultV1, i: Intent, checkId: number, seq: number): VerificationSourceRecord {
  const time = Date.parse(r.generated_at);
  return { ...observation(r, i.text, checkId), seq, pr_number: r.pr, result_id: r.result_id, attempt: r.attempt,
    skill_id: r.skill_id, outcome: r.outcome, head_sha: r.head_sha, base_sha: r.base_sha, dedup_key: r.dedup_key,
    withdraws_result_id: r.withdraws_result_id, supersedes_result_id: r.supersedes_result_id, decision: "accepted",
    reason_code: null, original_seq: null, withdraws_seq: null, summary: r.summary, intake_id: null, observed_at: time, recorded_at: time };
}

export async function publishVerification(deps: PublisherDeps, allowlist: PublisherAllowlist, request: unknown,
  options: Options & { operator?: boolean }): Promise<PublishOutcome> {
  try {
    return await deps.ledger.withLock(async session => {
      const parsed = parsePublishRequest(request);
      if (!parsed.ok) return refuse("request_invalid");
      const { repository_id, pr, skill_id, head_sha, base_sha, record } = parsed.value;
      const entry = allowlist.allow.find(b => b.repository_id === repository_id && b.skill_id === skill_id);
      if (!entry) return refuse("not_allowlisted");
      const invocation_id = record.invocation_id;
      if (typeof invocation_id !== "string") return refuse("request_invalid");
      const { intents, resolutions } = ledgerState(session.entries);
      const previous = intents.find(i => i.invocation_id === invocation_id);
      const transport = { signal: options.signal };
      if (previous) {
        const resolved = resolutions.get(previous.result_id);
        if (resolved?.kind === "published") return done("already_published", previous, resolved.check_run_id);
        if (resolved) return refuse("invocation_abandoned");
        return confirm(deps, session, previous, transport, "recover");
      }
      const scope = intents.filter(i => i.repository_id === repository_id && i.pr === pr);
      const open = scope.find(i => !resolutions.has(i.result_id));
      if (open) return refuse("unresolved_intent", open.invocation_id);
      const reply = await call(() => deps.github.get(`repos/${entry.repository}/pulls/${pr}`, transport));
      const pull = prSchema.safeParse(reply.ok ? reply.body : null);
      if (!pull.success) return refuse("read_failed");
      const { number, state, head, base } = pull.data;
      if (state !== "open") return refuse("pr_not_open");
      if (number !== pr || base.repo.id !== repository_id || base.repo.full_name !== entry.repository) return refuse("scope_mismatch");
      if (head.repo?.id !== base.repo.id) return refuse("fork");
      if (head.sha !== head_sha) return refuse("head_moved");
      if (base.sha !== base_sha) return refuse("base_moved");
      const published = scope.flatMap(i => {
        const resolution = resolutions.get(i.result_id);
        return resolution?.kind === "published" ? [{ intent: i, id: resolution.check_run_id }] : [];
      });
      const sameHead = published.filter(({ intent: i }) => i.head_sha === head_sha && i.skill_id === skill_id);
      if (sameHead.length && options.operator !== true) return refuse("already_verified");
      const attempt = 1 + sameHead.reduce((n, { intent }) => Math.max(n, intent.attempt), 0);
      const prior = published.map(p => ({ ...p, result: stored(p.intent) }));
      const first = prior.find(p => p.result.skill_id === skill_id);
      if (first && !sameBinding(first.result, entry)) return refuse("binding_changed");
      const failed = prior.filter(({ result: r }) => r.skill_id === skill_id && r.head_sha !== head_sha && r.outcome === "failed").at(-1);
      if (failed) {
        const ids = new Set(Array.isArray(record.checks) ? record.checks.map(c => c?.check_id) : []);
        if (failed.result.checks.some(c => !ids.has(c.check_id))) return refuse("original_check_missing");
      }
      const at = stamp(deps);
      const built = buildVerificationResult({ result_id: deps.uuid(), attempt, generated_at: at,
        target: { repository: base.repo.full_name, repository_id, pr, head_sha, base_sha, branch: head.ref, base_ref: base.ref },
        binding: entry, producer: { type: "App", ...allowlist.producer }, record: record as unknown as VerificationHarnessRecord,
        supersedes_result_id: null, recheck: null });
      if (!built.ok) return refuse("build_refused", built.reason);
      const { result, text, check_run } = built.publication;
      const history = prior.map((p, n) => accepted(p.result, p.intent, p.id, n + 1));
      const nextId = history.reduce((n, row) => Math.max(n, row.object_id), 0) + 1;
      const decision = decideVerificationSources(history, [observation(result, text, nextId)])[0]!.outcome;
      if (decision.decision === "rejected") return refuse("host_would_reject", decision.reason_code);
      const intent: Intent = { v: 1, kind: "intent", invocation_id, repository_id, pr, head_sha, base_sha,
        skill_id, attempt, result_id: result.result_id, text, at };
      await session.append(intent);
      const created = await call(() => deps.github.createCheckRun(entry.repository, check_run, transport));
      const id = idBody.safeParse(created.ok ? created.body : null);
      return confirm(deps, session, intent, transport, "publish", id.success ? id.data.id : undefined);
    });
  } catch { return refuse("ledger_unavailable"); }
}

export async function abandonVerification(deps: PublisherDeps, allowlist: PublisherAllowlist, invocation_id: string,
  options: Options): Promise<PublishOutcome> {
  try {
    return await deps.ledger.withLock(async session => {
      const { intents, resolutions } = ledgerState(session.entries);
      const i = intents.find(item => item.invocation_id === invocation_id);
      if (!i || resolutions.has(i.result_id) || !allowlist.allow.some(b => b.repository_id === i.repository_id)) return refuse("not_open");
      return confirm(deps, session, i, options, "abandon");
    });
  } catch { return refuse("ledger_unavailable"); }
}
