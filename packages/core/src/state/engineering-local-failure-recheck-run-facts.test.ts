import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { publishedRecheck, runFixture } from "./local-failure-recheck.testkit.js";

it.each(["reserved", "running", "stop_unknown", "passed"] as const)("projects ordered attempts and detects a blocking %s", state => {
  const d = publishedRecheck();
  d.recordConfirmation(); d.confirm();
  const row = d.open(), facts = () => d.ledger.runFacts(row.recheck_id);
  expect(facts()).toEqual({ attempts: [], blocking: false });
  const { runs, input, settle } = runFixture(d, row);
  const first = runs.reserve(input).run;
  const stopped = runs.settleNotStarted(first.run_id, first.revision, "verify_recheck_not_started");
  const project = ({ attempt, state, outcome, conclusion_state, conclusion_reason, created_at, updated_at }: typeof first) =>
    ({ attempt, state, outcome, conclusion_state, conclusion_reason, created_at, updated_at });
  expect(facts()).toEqual({ attempts: [project(stopped)], blocking: false });
  let second = runs.reserve({ ...input, invocation_id: randomUUID() }).run;
  if (state !== "reserved") second = runs.start(second.run_id, second.revision);
  if (state === "stop_unknown") second = runs.markStopUnknown(second.run_id, second.revision);
  if (state === "passed") second = settle(second);
  expect(facts()).toEqual({ attempts: [project(stopped), project(second)], blocking: true });
});
