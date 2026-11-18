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
export function diagnosisFixture(options: { legacy?: boolean; profileDigest?: string; artifactDigest?: string } = {}) {
  const root = realpathSync(createScratchDirSync("tests", "diagnosis")),
    path = join(root, "state.db");
  const db = options.legacy ? new Database(path) : openDb({ path });
  if (options.legacy) {
    for (const m of MIGRATIONS.filter((m) => m.id <= 58)) db.exec(m.sql);
    db.pragma("user_version=58");
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
  const mission = new ContainedMissionStore(attention, owner).authorize(
    principal,
    {
      scope_id: scope.scope_id,
      spec: { goal: "fixture" },
      claim: {
        repo_identity: "fixture",
        branch: "fixture",
        worktree_identity: "fixture",
      },
    },
    GRANT_NOW,
  );
  const v = verificationFixture();
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
