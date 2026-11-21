import type { VerificationHarnessRecord, VerificationPublication } from "@osstack/core/verification-publish";
import type { PublisherAllowlist } from "../config.js";
import type { PublisherGithub } from "../publish.js";

export const marker = "untrusted-response-marker";
export const uuid = (n: number) => "00000000-0000-4000-8000-" + String(n).padStart(12, "0");
export const now = () => new Date("2026-11-16T12:02:00.937Z");
const repository = "fixture-owner/fixture-repo";
export function config(): PublisherAllowlist {
  return { version: 1, producer: { app_id: 201, installation_id: 301 },
    allow: [{ repository, repository_id: 101, skill_id: "fixture-skill", skill_version: "1.0.0", skill_blob: "e".repeat(40),
      skill_manifest_digest: "c".repeat(64), profile_id: "fixture-profile", profile_digest: "d".repeat(64),
      trusted_source: { repository: "fixture-owner/fixture-harness", commit_sha: "e".repeat(40), artifact_digest: "f".repeat(64) } }] };
}

export function request(outcome: VerificationHarnessRecord["outcome"] = "passed", invocation = 2) {
  const failure_code = outcome === "failed" ? "assertion_failed" : null;
  return { version: 1, repository_id: 101, pr: 7, skill_id: "fixture-skill", head_sha: "a".repeat(40), base_sha: "b".repeat(40),
    record: { invocation_id: uuid(invocation), started_at: "2026-11-16T12:00:00Z", finished_at: "2026-11-16T12:01:00Z",
      outcome, failure_code, checks: [{ check_id: "fixture-check", failure_code, exit: failure_code ? 1 : 0, result_digest: "1".repeat(64) }],
      evidence_refs: [{ artifact_id: "fixture-artifact", sha256: "2".repeat(64), size: 12, type: "text/plain", retention: 30 }],
      evidence_digest: "3".repeat(64), runtime_provenance: { runtime_id: "fixture-runtime", runtime_digest: "4".repeat(64),
        source_manifest_digest: "5".repeat(64) }, summary: "Synthetic verification" } };
}

export class FakeGithub implements PublisherGithub {
  readonly pr = { number: 7, state: "open", title: marker,
    head: { sha: "a".repeat(40), ref: "fixture-branch", repo: { id: 101 } as { id: number } | null },
    base: { sha: "b".repeat(40), ref: "main", repo: { id: 101, full_name: repository } } };
  readonly runs: (VerificationPublication["check_run"] & { app: { id: number }; id: number; marker: string })[] = [];
  readonly paths: string[] = [];
  readonly signals: AbortSignal[] = [];
  writes = 0;
  throwGet = 0;
  failGet = 0;
  throwCreate = 0;
  failCreate = 0;
  lostReply = false;
  listOverride: unknown;
  async get(path: string, options: { signal: AbortSignal }) {
    this.paths.push(path);
    this.signals.push(options.signal);
    if (this.paths.length === this.throwGet) throw new Error(marker);
    const failure = { ok: false, body: { message: marker } } as const;
    if (this.paths.length === this.failGet) return failure;
    const root = "repos/" + repository;
    if (path === root + "/pulls/7") return { ok: true, body: this.pr } as const;
    const list = /^\/commits\/([a-f0-9]{40})\/check-runs\?check_name=osstack%2Fverify-intake%2Ffixture-skill&filter=all&per_page=100$/u;
    const head = path.startsWith(root) && list.exec(path.slice(root.length))?.[1];
    if (head) {
      const rows = this.runs.filter(r => r.head_sha === head);
      return { ok: true, body: this.listOverride ?? { total_count: rows.length, check_runs: rows, marker } } as const;
    }
    const run = this.runs.find(r => path === root + "/check-runs/" + r.id);
    return run ? { ok: true, body: run } as const : failure;
  }
  async createCheckRun(repo: string, body: VerificationPublication["check_run"], options: { signal: AbortSignal }) {
    this.signals.push(options.signal);
    this.writes++;
    if (this.writes === this.throwCreate) throw new Error(marker);
    if (this.writes === this.failCreate || repo !== repository) return { ok: false, body: { message: marker } } as const;
    const id = this.runs.length + 1;
    this.runs.push({ ...body, id, app: { id: 201 }, marker });
    if (this.lostReply) throw new Error(marker);
    return { ok: true, body: { id, marker } } as const;
  }
}
