import { describe, expect, it } from "vitest";
import {
  createProbeRenderBundle,
  ProbeRenderIntegrityError,
  verifyProbeRenderArtifacts,
} from "./render.js";
import type {
  ProbeEventV1,
  ProbeItemV1,
  ProbeSessionV1,
} from "./types.js";

const session: ProbeSessionV1 = {
  schema_version: "1",
  session_id: "probe_render01",
  repo_id: "osstack",
  worktree_state: "clean",
  input_refs: [],
  doc_types: ["tech"],
  question_pack_refs: [{ pack_id: "probe.tech", version: "1" }],
  selected_question_ids: ["tech.data_model.v1"],
  unselected_required_question_ids: [],
  depth: "quick",
  question_budget: 8,
  questions_presented: 1,
  revision: 2,
  created_at_ms: 1,
  updated_at_ms: 2,
  state: "completed",
  completed_at_ms: 2,
};

const item: ProbeItemV1 = {
  schema_version: "1",
  item_id: "pi_render001",
  question_id: "tech.data_model.v1",
  session_id: session.session_id,
  source_pack: { pack_id: "probe.tech", version: "1" },
  item_kind: "question",
  initial_quadrant: "ku",
  current_quadrant: "kk",
  doc_type: "tech",
  category: "data_model",
  origin: "static_pack",
  prompt: "Which data model is authoritative?",
  options: [],
  impact: 3,
  irreversibility: 3,
  uncertainty: 3,
  required: true,
  evidence_refs: [],
  destination_hint: "technical_design",
  created_at_ms: 1,
  updated_at_ms: 2,
  state: "resolved",
  resolution: {
    answer: "Use versioned snapshots and append-only events.",
    actor: { type: "human", id: "owner" },
    resolved_at_ms: 2,
  },
  destination: {
    role: "technical_design",
    path: "docs/technical-design.md",
    write_state: "pending",
  },
  compilation: { state: "not_eligible" },
};

const events: ProbeEventV1[] = [
  {
    schema_version: "1",
    event_id: "pe_render001",
    session_id: session.session_id,
    revision: 1,
    type: "session_started",
    actor: { type: "human", id: "owner" },
    idempotency_key: "start-render",
    occurred_at_ms: 1,
    payload: {},
  },
  {
    schema_version: "1",
    event_id: "pe_render002",
    session_id: session.session_id,
    revision: 2,
    type: "answer_recorded",
    actor: { type: "human", id: "owner" },
    idempotency_key: "answer-render",
    item_id: item.item_id,
    occurred_at_ms: 2,
    payload: {},
  },
];

describe("probe portable rendering", () => {
  it("creates deterministic canonical JSON, bound Markdown, and a manifest", () => {
    const input = {
      state: { session, items: [item] },
      events,
      exported_at_ms: 10,
      generator_version: "0.10.0",
      targets: ["ledger", "technical-delta"] as const,
    };
    const first = createProbeRenderBundle(input);
    const second = createProbeRenderBundle(input);

    expect(first).toEqual(second);
    expect(first.files.map((file) => file.path)).toEqual([
      "ledger.json",
      "ledger.md",
      "technical-delta.md",
    ]);
    expect(first.files[0]?.content.startsWith('{"artifact":')).toBe(true);
    expect(first.files[0]?.content.endsWith("\n")).toBe(true);
    expect(first.files[1]?.content).toContain(
      `source_sha256: ${first.ledger_sha256}`,
    );
    expect(first.files[2]?.content).toContain(
      "Use versioned snapshots and append-only events.",
    );
    expect(first.manifest).toMatchObject({
      schema_version: "1",
      session_id: session.session_id,
      exported_revision: 2,
      files: [
        { path: "ledger.json" },
        { path: "ledger.md" },
        { path: "technical-delta.md" },
      ],
    });
  });

  it("validates a fresh-home artifact set and rejects noncanonical or tampered files", () => {
    const bundle = createProbeRenderBundle({
      state: { session, items: [item] },
      events,
      exported_at_ms: 10,
      generator_version: "0.10.0",
      targets: ["ledger"],
    });
    const files = new Map(
      bundle.files.map((file) => [file.path, file.content]),
    );

    expect(verifyProbeRenderArtifacts(bundle.manifest, files).ledger).toEqual(
      bundle.ledger,
    );

    files.set("ledger.md", `${files.get("ledger.md")}tampered\n`);
    expect(() => verifyProbeRenderArtifacts(bundle.manifest, files)).toThrow(
      ProbeRenderIntegrityError,
    );

    const noncanonical = new Map(
      bundle.files.map((file) => [file.path, file.content]),
    );
    noncanonical.set(
      "ledger.json",
      `${JSON.stringify(bundle.ledger, null, 2)}\n`,
    );
    expect(() =>
      verifyProbeRenderArtifacts(bundle.manifest, noncanonical),
    ).toThrow(ProbeRenderIntegrityError);
  });
});
