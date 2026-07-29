import { describe, expect, it } from "vitest";
import type { LoopEvent } from "@osstack/loop";
import {
  createAgentRuntimeEvidence,
  createPolicyDecisionEvidence,
  createVerifierOutputArtifacts,
} from "./proof-pack.js";

describe("createVerifierOutputArtifacts", () => {
  it("writes redacted structured Kimi Markdown and JSON evidence", () => {
    const artifacts = createVerifierOutputArtifacts({
      status: "pass",
      results: [{
        task_id: "task/one",
        pass: true,
        score: 1,
        reviewer_agent_id: "kimi-code",
        summary: "Approved.",
        event_seq: 7,
        review_artifacts: [{
          schema_version: 1,
          reviewer_agent_id: "kimi-code",
          verdict: "approved",
          risk: "read_only",
          markdown: "# Review\n\nApproved sk-test-secret-token-12345678901234567890",
          judgments: [],
          findings: [],
          recommended_actions: [],
          evidence_refs: ["src/app.ts"],
          runtime_identity: {
            adapter_id: "kimi-code",
            provider_id: "kimi",
            model_id: "kimi-code/k3",
          },
        }],
      }],
    });

    expect(artifacts.map((artifact) => artifact.path)).toEqual([
      "reviewer-output/task-one-kimi-code.md",
      "reviewer-output/task-one-kimi-code.json",
    ]);
    expect(artifacts[0]?.content).toContain("# Review");
    expect(artifacts[0]?.content).toContain("[REDACTED:");
    expect(artifacts[1]?.content).toContain("\"verdict\": \"approved\"");
    expect(artifacts[1]?.content).toContain("[REDACTED:");
    expect(JSON.stringify(artifacts)).not.toContain("sk-test-secret-token");
  });

  it("keeps the legacy text artifact for unstructured reviewers", () => {
    const artifacts = createVerifierOutputArtifacts({
      status: "pass",
      results: [{
        task_id: "legacy-task",
        pass: true,
        score: 1,
        reviewer_agent_id: "local-verifier",
        summary: "Verifier passed.",
        event_seq: 2,
      }],
    });

    expect(artifacts).toEqual([
      expect.objectContaining({
        path: "checker-output/legacy-task-local-verifier.txt",
        content: expect.stringContaining("Verifier passed."),
      }),
    ]);
  });

  it("rejects duplicate structured reviewer paths instead of overwriting evidence", () => {
    const review = {
      schema_version: 1 as const,
      reviewer_agent_id: "kimi-code",
      verdict: "approved" as const,
      risk: "read_only" as const,
      markdown: "# Review\n\nApproved.",
      judgments: [],
      findings: [],
      recommended_actions: [],
      evidence_refs: [],
      runtime_identity: {},
    };

    expect(() => createVerifierOutputArtifacts({
      status: "pass",
      results: [{
        task_id: "task-one",
        pass: true,
        score: 1,
        reviewer_agent_id: "kimi-code",
        summary: "Approved.",
        event_seq: 7,
        review_artifacts: [review, review],
      }],
    })).toThrow(/duplicate proof artifact path/);
  });
});

describe("profile routing proof evidence", () => {
  it("records profile policy and both runtime identities with redaction", () => {
    const events: LoopEvent[] = [
      loopEvent(1, "loop.plan.done", {
        task_id: "task-one",
        agent_id: "claude-code",
        routing_reason: "agent_id override",
        profile_name: "mac-mini",
        independent: true,
        independence_reason: "reported provider or model differs",
        builder_identity: {
          adapter_id: "claude-code",
          auth_mode: "login-reuse",
          provider_id: "anthropic",
          model_id: "claude-current",
          evidence_source: "reported",
          agent_profile: "secret sk-test-builder-profile-1234567890",
        },
      }),
      loopEvent(2, "loop.verify.done", {
        task_id: "task-one",
        pass: true,
        reviewer_agent_id: "kimi-code",
        summary: "approved",
        profile_name: "mac-mini",
        independence_reason: "reported provider or model differs",
        evaluator_identity: {
          adapter_id: "kimi-code",
          auth_mode: "subprocess/login-reuse",
          provider_id: "kimi",
          model_id: "kimi-code/k3",
          evidence_source: "reported",
        },
      }),
    ];

    const policy = createPolicyDecisionEvidence(events);
    const runtime = createAgentRuntimeEvidence(events);

    expect(policy).toMatchObject({
      status: "recorded",
      decisions: [expect.objectContaining({
        profile_name: "mac-mini",
        independent: true,
        independence_reason: "reported provider or model differs",
      })],
    });
    expect(runtime).toMatchObject({
      status: "recorded",
      agents: expect.arrayContaining([
        expect.objectContaining({
          agent_id: "claude-code",
          adapter_id: "claude-code",
          provider_id: "anthropic",
          model_id: "claude-current",
          evidence_source: "reported",
        }),
        expect.objectContaining({
          agent_id: "kimi-code",
          adapter_id: "kimi-code",
          provider_id: "kimi",
          model_id: "kimi-code/k3",
          evidence_source: "reported",
        }),
      ]),
    });
    expect(JSON.stringify({ policy, runtime })).not.toContain(
      "sk-test-builder-profile",
    );
  });
});

function loopEvent(
  seq: number,
  type: LoopEvent["type"],
  payload: Record<string, unknown>,
): LoopEvent {
  return {
    event_id: `event-${seq}`,
    loop_id: "loop-profile-proof",
    type,
    seq,
    created_at: seq,
    payload,
  };
}
