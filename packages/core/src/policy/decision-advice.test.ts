import { describe, expect, it } from "vitest";
import { buildDecisionRequest, parseDecisionAnswer, decisionCostMicroUSD } from "./decision-advice.js";

const input = { schemaVersion: 1, scopeId: "test", taskId: "task-1", taskRevision: 1,
  purpose: "failure_label", state: "AssertionError: expected CSV header to be UTF-8" };
const response = {
  model: "jev-1.13.0",
  answers: { decision: { type: "choice", choice: "assertion", confidence: 0.8,
    probabilities: { assertion: 0.9, environment: 0.02, context: 0.02, output_contract: 0.02, other: 0.02, abstain: 0.02 } } },
  usage: { input_tokens: 2000, output_tokens: 42 },
};

describe("decision advice boundary", () => {
  it("produces only a fixed semantic question, never task authority", () => {
    const request = buildDecisionRequest(input);
    expect(request.body.model).toBe("jev-1.13.0");
    expect(request.body.questions.decision.criteria).toHaveProperty("abstain");
    expect(request.body).not.toHaveProperty("scopeId");
    expect(() => buildDecisionRequest({ ...input, authorization: "auto_execute" })).toThrow();
    expect(() => buildDecisionRequest({ ...input, purpose: "ready" })).toThrow();
  });
  it("binds the immutable request to scope, revision, state and question version", () => {
    const source = { ...input };
    const request = buildDecisionRequest(source);
    source.state = "mutated";
    expect(request.body.state).toBe(input.state);
    expect(request.digest).toBe(buildDecisionRequest(input).digest);
    for (const change of [{ scopeId: "other" }, { taskRevision: 2 }, { state: "different" }]) {
      expect(buildDecisionRequest({ ...input, ...change }).digest).not.toBe(request.digest);
    }
  });
  it("bounds UTF-8 bytes, rejects authority fields and duplicate/prototype skill ids", () => {
    expect(() => buildDecisionRequest({ ...input, state: "汉".repeat(3000) })).toThrow();
    const skill = { ...input, purpose: "skill_hint", candidates: [{ id: "test", description: "Write regression tests" }] };
    expect(buildDecisionRequest(skill).body.questions.decision.criteria).toHaveProperty("test");
    expect(() => buildDecisionRequest({ ...skill, candidates: [...skill.candidates, ...skill.candidates] })).toThrow();
    for (const id of ["__proto__", "constructor", "prototype", "abstain"]) {
      expect(() => buildDecisionRequest({ ...skill, candidates: [{ id, description: "bad" }] })).toThrow();
    }
    expect(() => buildDecisionRequest({ ...input, candidates: skill.candidates })).toThrow();
  });
  it("returns validated advisory data and exact integer micro-dollar costs", () => {
    const answer = parseDecisionAnswer(response, buildDecisionRequest(input));
    expect(answer.choice).toBe("assertion");
    expect(answer.inputTokens).toBe(2000);
    expect(decisionCostMicroUSD(2000)).toBe(84n);
    expect(decisionCostMicroUSD(1)).toBe(1n);
    expect(answer).not.toHaveProperty("authorization");
  });
  it("rejects model drift, missing/extra options, nonfinite or inconsistent distributions", () => {
    const request = buildDecisionRequest(input);
    for (const mutate of [
      (r: typeof response) => { r.model = "jev-latest"; },
      (r: typeof response) => { r.answers.decision.choice = "execute"; },
      (r: typeof response) => { r.answers.decision.confidence = NaN; },
      (r: typeof response) => { r.answers.decision.probabilities.assertion = 0.1; },
      (r: typeof response) => { r.answers.decision.probabilities.abstain = -0.02; },
      (r: typeof response) => { r.usage.input_tokens = 65537; },
    ]) {
      const changed = structuredClone(response); mutate(changed);
      expect(() => parseDecisionAnswer(changed, request)).toThrow();
    }
    expect(() => parseDecisionAnswer({ ...response, answers: { ...response.answers, approve: true } }, request)).toThrow();
  });
});
