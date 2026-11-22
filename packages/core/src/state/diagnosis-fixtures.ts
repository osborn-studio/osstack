import { localFailureBindingFromLedger, type LocalVerificationReceipt } from "../bridge/local-failure.js";
import Database from "better-sqlite3";
import { MIGRATIONS } from "./migrations.js";
import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { rmSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { createScratchDirSync } from "../scratch.js";
import { samplePreview, GRANT_NOW } from "../bridge/revision-grant-fixtures.js";
import { signLocalFailureRevisionGrant } from "../bridge/revision-local-failure-grant.js";
import { verificationFixture } from "../bridge/verification-result-fixtures.js";
import { parseVerificationResultV1, verificationDedupKey } from "../bridge/verification-result.js";
import { AttentionStore } from "./attention-store.js";
import { ContainedMissionStore } from "./engineering-contained-store.js";
import { RevisionChainStore } from "./engineering-revision-chain-store.js";
import { VerificationSourceStore } from "./engineering-verification-source-store.js";
import { DiagnosisStore } from "./engineering-diagnosis-store.js";
import { openDb } from "./db.js";
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
export function diagnosisFixture(
  options: {
    legacy?: boolean | 59 | 60 | 62 | 63;
    recheck?: { timeout_seconds: number };
    allowedPaths?: string[];
    protectedDigest?: string;
    summary?: string;
    rounds?: 1 | 2;
    derive?: (
      missions: ContainedMissionStore,
      root: ReturnType<ContainedMissionStore["authorize"]>,
      principal: Parameters<ContainedMissionStore["authorize"]>[0],
    ) => ReturnType<ContainedMissionStore["authorize"]>;
    profileDigest?: string;
    artifactDigest?: string;
  } = {},
) {
  const root = realpathSync(createScratchDirSync("tests", "diagnosis")),
    path = join(root, "state.db");
  const db = options.legacy ? new Database(path) : openDb({ path });
  if (options.legacy) {
    const version = options.legacy === true ? 58 : options.legacy;
    for (const m of MIGRATIONS.filter((m) => m.id <= version)) db.exec(m.sql);
    db.pragma(`user_version=${version}`);
  }
  const close = () => {
    if (db.open) db.close();
    rmSync(root, { recursive: true, force: true });
  };
  db.pragma("synchronous=FULL");
  db.exec("INSERT INTO tasks(task_id,title,status,created_at,updated_at) VALUES('t','t','running',1,1)");
  const attention = new AttentionStore(db, path),
    owner = attention.claimOwner("owner"),
    scope = attention.registerScope(owner, "t", root);
  const principal = {
    principal_id: "human",
    client_session_id: "cli",
    write_scopes: [scope.scope_id],
    read_scopes: [scope.scope_id],
    stop_scopes: [scope.scope_id],
    operator_scopes: [],
  };
  const origin = new ContainedMissionStore(attention, owner).authorize(
    principal,
    {
      scope_id: scope.scope_id,
      spec: {
        goal: "fixture",
        ...(options.allowedPaths && {
          allowed_paths: options.allowedPaths,
          repo_path: root,
          branch: "fixture-branch",
          start_commit: "a".repeat(40),
          base_ref: "main",
          worktree_path: join(root, "origin"),
          verify: { argv: ["verify"] },
          publication: {
            remote: "origin",
            repository: "fixture-owner/fixture-repo",
            base: "main",
            draft: true,
            preauthorized: true,
          },
        }),
      },
      claim: {
        repo_identity: "fixture",
        branch: "fixture",
        worktree_identity: "fixture",
      },
    },
    GRANT_NOW,
  );
  const mission = options.derive?.(new ContainedMissionStore(attention, owner), origin, principal) ?? origin;
  const v = verificationFixture();
  if (options.summary !== undefined) v.summary = options.summary;
  if (options.profileDigest) v.profile_digest = options.profileDigest;
  if (options.artifactDigest) v.trusted_source.artifact_digest = options.artifactDigest;
  v.dedup_key = verificationDedupKey(v);
  const text = JSON.stringify(v),
    parsed = parseVerificationResultV1(text);
  if (!parsed.ok) throw Error(parsed.code);
  const source = new VerificationSourceStore(attention, owner);
  source.record(
    [
      {
        source_kind: "check_run",
        object_id: 1,
        repository_id: v.repository_id,
        repository: v.repository,
        pr: v.pr,
        observed_head_sha: v.head_sha,
        app_id: 201,
        check_name: "fixture",
        response_digest: sha("response"),
        contract_digest: sha(text),
        verdict: { ok: true },
        result: parsed.result,
      },
    ],
    1,
    1,
  );
  const profile = {
    profile_id: v.profile_id,
    profile_digest: v.profile_digest,
    trusted_source: {
      repository: v.trusted_source.repository,
      commit: v.trusted_source.commit_sha,
      artifact_digest: v.trusted_source.artifact_digest,
    },
  };
  const keys = generateKeyPairSync("ed25519");
  const grant = signLocalFailureRevisionGrant(
    {
      ...samplePreview({
        root_mission_id: mission.mission_id,
        ...(options.protectedDigest && {
          protected_set_digest: options.protectedDigest,
        }),
        ...(options.rounds && { rounds: options.rounds }),
        scope_id: scope.scope_id,
        repository: v.repository,
        pr_number: v.pr,
        branch: v.branch,
        head_sha: v.head_sha,
      }),
      version: 2,
      local_failure: {
        ...profile,
        enabled: true,
        ...(options.recheck && { recheck: { enabled: true as const, ...options.recheck } }),
        diagnostic_timeout_seconds: 20,
        max_diagnostics_per_head: 1,
      },
    },
    keys.privateKey,
  );
  const chain = new RevisionChainStore(attention, owner).createLiveChain(
    {
      root_mission_id: mission.mission_id,
      repository: v.repository,
      pr_number: v.pr,
      branch: v.branch,
      base_ref: v.base_ref,
      published_head: v.head_sha,
      published_base: v.base_sha,
      trace_id: "fixture",
      grant,
    },
    GRANT_NOW,
  );
  const store = new DiagnosisStore(attention, owner, () => GRANT_NOW);
  const policy = {
    schema_version: 1 as const,
    producers: [
      {
        type: "App" as const,
        carrier: "check-run" as const,
        app_id: 201,
        installation_id: 301,
        repository_id: v.repository_id,
        skill_id: v.skill_id,
        skill_manifest_digest: v.skill_manifest_digest,
        ...{ profile_id: v.profile_id, profile_digest: v.profile_digest },
        allowed_failure_codes: ["assertion_failed"],
        ttl_ms: 1000,
        evidence_store: "fixture",
        auto_registration: false,
      },
    ],
  };
  const input = {
    result_id: v.result_id,
    contract_text: text,
    root_mission_id: mission.mission_id,
    chain_id: chain.chain_id,
    policy,
  };
  const facts = {
    chain_id: chain.chain_id,
    grant,
    grant_digest: sha(chain.grant_json),
    now: GRANT_NOW,
    profile,
    container_cap_seconds: 20,
    binding: {
      repository: v.repository,
      pr_number: v.pr,
      branch: v.branch,
      head_sha: v.head_sha,
      tree_sha: "e".repeat(40),
      base_ref: v.base_ref,
      base_sha: v.base_sha,
    },
    intake_id: `lfi_${randomUUID()}`,
    invocation_id: randomUUID(),
    journal_ref: "fixture",
  };
  return {
    db: db as Database.Database,
    store,
    input,
    facts,
    source,
    v,
    keys,
    principal,
    path,
    root,
    attention,
    owner,
    close,
  };
}

export function eligibleRequest(f: ReturnType<typeof diagnosisFixture>) {
  const r = f.store.register(f.input);
  const admission = f.store.admit(r.request_id, r.revision, f.facts);
  if (admission.status !== "admitted") throw Error(admission.reason);
  const running = f.store.intakes.start(admission.intake.intake_id, admission.intake.revision);
  const receipt: LocalVerificationReceipt = {
    ...localFailureBindingFromLedger(running),
    version: 1,
    started_at: GRANT_NOW,
    finished_at: GRANT_NOW,
    outcome: "reproducible_failure",
    checks: [
      {
        check_id: "fixture-check",
        category: "test",
        exit_code: 1,
        result_digest: sha("result"),
      },
    ],
    bounded_redacted_summary: "fixture",
    evidence_digest: sha("evidence"),
    stop: { proven: true, proof_ref: "proof", proof_digest: sha("proof") },
  };
  f.store.intakes.settleStopped(running.intake_id, running.revision, {
    outcome: receipt.outcome,
    container_used_seconds: 1,
    receipt_json: "{}",
    evidence_digest: receipt.evidence_digest,
    proof_ref: receipt.stop.proof_ref,
    proof_digest: receipt.stop.proof_digest,
  });
  f.store.recordReceipt(r.request_id, receipt, sha("identity"));
  return f.store.conclude(r.request_id, f.store.get(r.request_id).revision, {
    state: "eligible",
    reason: null,
  });
}

export const recheckRunObjects = [
  "engineering_local_failure_recheck_runs", "engineering_local_failure_recheck_host_proof",
  ...["active","root","chain","insert","binding","budget","exclusion","no_delete","no_replace","fixed","flow","start"]
    .map(name => "engineering_local_failure_recheck_run_"+name),
  ...["review","actions","intake","dispatch"].map(name=>"engineering_root_exclusion_recheck_"+name),
  ...[2,3,4].map(n=>"sqlite_autoindex_engineering_local_failure_recheck_runs_"+n),
];

/** Sign against the current chain revision, including its current published head. */
export function diagnosisRenewal(f: ReturnType<typeof diagnosisFixture>, now: number,
  overrides: Partial<Pick<Parameters<typeof signLocalFailureRevisionGrant>[0], "budget" | "rounds">> = {}) {
  const store = new RevisionChainStore(f.attention, f.owner);
  const chain = store.get(f.input.chain_id);
  const { signature: _sig, preview_sha256: _digest, ...old } = f.facts.grant;
  const preview = { ...old, grant_id: `rg_${randomUUID()}`, issued_at: now, expires_at: now + (old.expires_at - old.issued_at),
    head_sha: chain.published_head, base_sha: chain.published_base!, renews: { chain_id: chain.chain_id, revision: chain.revision }, ...overrides };
  const grant = signLocalFailureRevisionGrant(preview, f.keys.privateKey);
  return { preview, grant, replace: () => store.replaceGrant(chain.chain_id, chain.revision, grant, now) };
}
