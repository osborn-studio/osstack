// Adversarial pool — mine evaluator mistakes into anchor cases. Wherever an
// evaluator's verdict disagrees with the human verdict on the same trace, the
// human is ground truth and the disagreement becomes one adversarial anchor
// case (deduped by trace_id). These are exactly the cases a challenger must
// get right before it can be promoted.

import { classifyFailure } from "./failure-taxonomy.js";
import { AnchorCase, type RunTrace } from "./types.js";

type Verdict = "accept" | "reject" | "needs_human";

export function buildAdversarialCases(input: {
  repo_id: string;
  traces: RunTrace[];
  human_verdicts: Array<{ trace_id: string; verdict: Verdict; reason: string }>;
  evaluator_verdicts: Array<{ trace_id: string; evaluator_id: string; verdict: Verdict }>;
}): AnchorCase[] {
  const humanByTrace = new Map<string, { verdict: Verdict; reason: string }>();
  for (const human of input.human_verdicts) {
    humanByTrace.set(human.trace_id, { verdict: human.verdict, reason: human.reason });
  }
  const traceById = new Map<string, RunTrace>();
  for (const trace of input.traces) traceById.set(trace.trace_id, trace);

  const cases: AnchorCase[] = [];
  const seen = new Set<string>();

  for (const evaluator of input.evaluator_verdicts) {
    const human = humanByTrace.get(evaluator.trace_id);
    if (human === undefined) continue; // no ground truth to disagree with
    if (human.verdict === evaluator.verdict) continue; // no disagreement
    if (seen.has(evaluator.trace_id)) continue; // one anchor case per trace
    seen.add(evaluator.trace_id);

    const trace = traceById.get(evaluator.trace_id);
    const failureFamily = trace !== undefined && !trace.verification.pass
      ? classifyFailure(trace)
      : undefined;

    cases.push(AnchorCase.parse({
      case_id: `anchor_${input.repo_id}_${evaluator.trace_id}`,
      repo_id: input.repo_id,
      source_trace_id: evaluator.trace_id,
      input_summary: trace?.input_summary ?? `disagreement on ${evaluator.trace_id}`,
      expected_verdict: human.verdict,
      ...(failureFamily !== undefined ? { expected_failure_family: failureFamily } : {}),
      evidence_refs: [
        `human: ${human.verdict} — ${human.reason}`,
        `evaluator ${evaluator.evaluator_id}: ${evaluator.verdict}`,
      ],
      adversarial: true,
    }));
  }

  return cases;
}
