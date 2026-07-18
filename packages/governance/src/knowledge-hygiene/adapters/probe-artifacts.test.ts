import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createProbeRenderBundle } from "../../probe/render.js";
import type { ProbeItemV1 } from "../../probe/types.js";
import { inspectProbeKnowledgeHygiene } from "./probe-artifacts.js";

const temporaryDirectories: string[] = [];
const day = 86_400_000;

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true }),
  ));
});

function baseItem(itemId: string, questionId: string) {
  return {
    schema_version: "1" as const,
    item_id: itemId,
    question_id: questionId,
    session_id: "probe_hygiene1",
    item_kind: "risk" as const,
    initial_quadrant: "ku" as const,
    current_quadrant: "ku" as const,
    doc_type: "tech" as const,
    category: "interface" as const,
    origin: "manual" as const,
    prompt: `Review ${questionId}`,
    options: [],
    impact: 3 as const,
    irreversibility: 2 as const,
    uncertainty: 2 as const,
    required: true,
    evidence_refs: [{ kind: "user_statement" as const, ref: "owner review" }],
    destination_hint: "technical_design" as const,
    created_at_ms: 1,
    updated_at_ms: 1,
  };
}

async function portableFixture() {
  const repo = await mkdtemp(join(tmpdir(), "osstack-probe-hygiene-"));
  temporaryDirectories.push(repo);
  const artifactDir = join(repo, "docs", "probe", "sessions", "probe_hygiene1");
  const items: ProbeItemV1[] = [
    {
      ...baseItem("pi_hygiene01", "dynamic." + "a".repeat(64) + ".v1"),
      state: "resolved",
      resolution: {
        answer: "Keep the boundary.",
        actor: { type: "human", id: "owner" },
        resolved_at_ms: 1,
      },
      destination: {
        role: "technical_design",
        path: "docs/missing-design.md",
        write_state: "applied",
      },
      compilation: { state: "not_eligible" },
    },
    {
      ...baseItem("pi_hygiene02", "dynamic." + "b".repeat(64) + ".v1"),
      state: "deferred",
      deferral: {
        owner: "owner",
        revisit_trigger: "after prototype",
        deferred_at_ms: 1,
      },
    },
    {
      ...baseItem("pi_hygiene03", "dynamic." + "c".repeat(64) + ".v1"),
      state: "waived",
      waiver: {
        reason: "temporary",
        approved_by: "owner",
        approved_at_ms: 1,
        expires_at_ms: 2,
      },
    },
  ];
  const session = {
    schema_version: "1" as const,
    session_id: "probe_hygiene1",
    repo_id: "probe-hygiene-repo",
    worktree_state: "not_git" as const,
    input_refs: [],
    doc_types: ["tech" as const],
    question_pack_refs: [],
    selected_question_ids: items.map((item) => item.question_id),
    unselected_required_question_ids: [],
    depth: "quick" as const,
    question_budget: 8,
    questions_presented: 0,
    revision: 1,
    created_at_ms: 1,
    updated_at_ms: 1,
    state: "paused" as const,
    pause_reason: "user" as const,
  };
  const bundle = createProbeRenderBundle({
    state: { session, items },
    events: [{
      schema_version: "1",
      event_id: "pe_hygiene01",
      session_id: session.session_id,
      revision: 1,
      type: "session_started",
      actor: { type: "human", id: "owner" },
      idempotency_key: "fixture",
      occurred_at_ms: 1,
      payload: {},
    }],
    exported_at_ms: 2,
    generator_version: "test",
    targets: ["ledger"],
  });
  for (const file of bundle.files) {
    const path = join(artifactDir, file.path);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, file.content);
  }
  await writeFile(join(artifactDir, "render-manifest.json"), bundle.manifest_content);
  return { repo, artifactDir };
}

describe("probe portable-artifact knowledge hygiene adapter", () => {
  it("is a no-op when a repository has no probe artifacts", async () => {
    const repo = await mkdtemp(join(tmpdir(), "osstack-probe-hygiene-empty-"));
    temporaryDirectories.push(repo);
    await expect(inspectProbeKnowledgeHygiene({
      repo_root: repo,
      now_ms: 40 * day,
    })).resolves.toEqual({ artifact_count: 0, findings: [] });
  });

  it("reports dead destinations and stale deferred or waived decisions from a valid ledger", async () => {
    const current = await portableFixture();
    const inspection = await inspectProbeKnowledgeHygiene({
      repo_root: current.repo,
      now_ms: 40 * day,
    });
    expect(inspection.artifact_count).toBe(1);
    expect(inspection.findings.map((finding) => finding.rule_id)).toEqual([
      "probe.destination_missing",
      "probe.deferred_stale",
      "probe.waiver_expired",
    ]);
    expect(inspection.findings.every((finding) =>
      finding.evidence_refs[0]?.ref.endsWith("ledger.json")
    )).toBe(true);
  });

  it("reports a tampered ledger as integrity failure and does not trust its items", async () => {
    const current = await portableFixture();
    await writeFile(join(current.artifactDir, "ledger.json"), "{}\n");
    const inspection = await inspectProbeKnowledgeHygiene({
      repo_root: current.repo,
      now_ms: 40 * day,
    });
    expect(inspection.findings).toEqual([
      expect.objectContaining({ rule_id: "probe.artifact_integrity", severity: "error" }),
    ]);
  });
});
