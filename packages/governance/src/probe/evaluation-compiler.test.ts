import { describe, expect, it } from "vitest";
import {
  ProbeEvaluationCompilerError,
  ProbeEvaluationCompilationBatchV1,
  compileProbeEvaluations,
} from "./evaluation-compiler.js";
import type { ProbeItemV1 } from "./types.js";

function resolvedItem(
  id: string,
  category: ProbeItemV1["category"],
  answer = "Run the package test script.",
): ProbeItemV1 {
  return {
    schema_version: "1",
    item_id: id,
    question_id: `dynamic.${(id === "pi_12345678" ? "a" : "b").repeat(64)}.v1`,
    session_id: "probe_12345678",
    item_kind: "question",
    initial_quadrant: "ku",
    current_quadrant: "kk",
    doc_type: "test",
    category,
    origin: "manual",
    prompt: "What proves acceptance?",
    options: [],
    impact: 3,
    irreversibility: 3,
    uncertainty: 2,
    required: true,
    evidence_refs: [{ kind: "file", ref: "package.json" }],
    destination_hint: "evaluation_spec",
    created_at_ms: 1,
    updated_at_ms: 2,
    state: "resolved",
    resolution: {
      answer,
      actor: { type: "human", id: "owner" },
      resolved_at_ms: 2,
    },
    destination: {
      role: "evaluation_spec",
      path: "docs/evaluations.md",
      write_state: "pending",
    },
    compilation: { state: "not_eligible" },
  };
}

function environment() {
  return {
    verify_package_script: async () => undefined,
    verify_artifact_path: async () => undefined,
    verify_contract_manifest: async () => undefined,
  };
}

describe("probe evaluation compiler", () => {
  it("compiles only registered, parameter-schema-bound templates", async () => {
    const items = [
      resolvedItem("pi_12345678", "acceptance"),
      resolvedItem("pi_87654321", "rollback"),
    ];
    const result = await compileProbeEvaluations({
      batch: {
        schema_version: "1",
        requests: [
          {
            item_id: items[0]!.item_id,
            template_id: "package-script.v1",
            params: {
              description: "Core tests pass.",
              package_path: "packages/core",
              script: "test",
            },
          },
          {
            item_id: items[1]!.item_id,
            template_id: "artifact-path.v1",
            params: {
              description: "Rollback artifact is absent after cleanup.",
              path: "tmp/rollback.lock",
              expectation: "absent",
              required: false,
              weight: 0.5,
            },
          },
        ],
      },
      session_id: "probe_12345678",
      exported_revision: 4,
      generated_at_ms: 5,
      spec_ref: "docs/probe/evaluation-spec-delta.json",
      items,
      environment: environment(),
    });

    expect(result.evaluations).toEqual([
      expect.objectContaining({
        mode: "command",
        command: "pnpm --dir 'packages/core' run test",
      }),
      expect.objectContaining({
        mode: "artifact",
        command: "test ! -e 'tmp/rollback.lock'",
        forbidden_paths: ["tmp/rollback.lock"],
      }),
    ]);
    expect(result.compilations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          compilation: {
            state: "compiled",
            spec_ref: "docs/probe/evaluation-spec-delta.json",
            template_id: "package-script.v1",
          },
        }),
      ]),
    );
  });

  it("keeps acceptance prose manual and never puts a resolved answer in shell", async () => {
    const hostile = "$(rm -rf /); `printenv`; pnpm run unknown";
    const item = resolvedItem("pi_12345678", "acceptance", hostile);
    const result = await compileProbeEvaluations({
      batch: {
        schema_version: "1",
        requests: [
          {
            item_id: item.item_id,
            template_id: "manual-acceptance.v1",
            params: {
              acceptance: "A human confirms the interaction.",
              reason: "No deterministic template covers visual quality.",
            },
          },
        ],
      },
      session_id: "probe_12345678",
      exported_revision: 2,
      generated_at_ms: 3,
      spec_ref: "docs/probe/evaluation-spec-delta.json",
      items: [item],
      environment: environment(),
    });
    expect(result.evaluations).toEqual([]);
    expect(result.compilations[0]).toMatchObject({
      template_id: "manual-acceptance.v1",
      compilation: {
        state: "manual_required",
        reason: "No deterministic template covers visual quality.",
      },
      manual_acceptance: "A human confirms the interaction.",
    });
    expect(JSON.stringify(result)).not.toContain(hostile);
  });

  it("rejects raw commands, unknown templates, unresolved items, and category mismatches", async () => {
    expect(
      ProbeEvaluationCompilationBatchV1.safeParse({
        schema_version: "1",
        requests: [
          {
            item_id: "pi_12345678",
            template_id: "package-script.v1",
            params: {
              description: "Unsafe",
              package_path: "packages/core",
              script: "test",
              command: "rm -rf /",
            },
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      ProbeEvaluationCompilationBatchV1.safeParse({
        schema_version: "1",
        requests: [
          {
            item_id: "pi_12345678",
            template_id: "shell.v1",
            params: { command: "pnpm test" },
          },
        ],
      }).success,
    ).toBe(false);

    const open = { ...resolvedItem("pi_12345678", "acceptance") } as Record<
      string,
      unknown
    >;
    open["state"] = "open";
    delete open["resolution"];
    delete open["destination"];
    delete open["compilation"];
    await expect(
      compileProbeEvaluations({
        batch: {
          schema_version: "1",
          requests: [
            {
              item_id: "pi_12345678",
              template_id: "package-script.v1",
              params: {
                description: "Tests pass.",
                package_path: "packages/core",
                script: "test",
              },
            },
          ],
        },
        session_id: "probe_12345678",
        exported_revision: 1,
        generated_at_ms: 2,
        spec_ref: "docs/probe/evaluation-spec-delta.json",
        items: [open as ProbeItemV1],
        environment: environment(),
      }),
    ).rejects.toBeInstanceOf(ProbeEvaluationCompilerError);

    await expect(
      compileProbeEvaluations({
        batch: {
          schema_version: "1",
          requests: [
            {
              item_id: "pi_12345678",
              template_id: "contract-manifest.v1",
              params: {
                description: "Contract remains valid.",
                manifest_path: "contracts/manifest.json",
                manifest_id: "contract.api",
              },
            },
          ],
        },
        session_id: "probe_12345678",
        exported_revision: 2,
        generated_at_ms: 3,
        spec_ref: "docs/probe/evaluation-spec-delta.json",
        items: [resolvedItem("pi_12345678", "rollback")],
        environment: environment(),
      }),
    ).rejects.toThrow("does not accept category");
  });
});
