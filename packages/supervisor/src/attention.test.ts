import { expect, it } from "vitest";
import {
  classifyAttentionWait,
  evaluateCoverage,
  evaluateActivity,
} from "./attention.js";

it("never expires durable idle or terminal facts into a process claim", () => {
  expect(
    evaluateActivity({
      kind: "session",
      businessState: "completed",
      instance: "a",
      now: 999999,
    })
  ).toEqual({ business_state: "completed", process_liveness: "unknown" });
  expect(
    evaluateActivity({
      kind: "run",
      businessState: "running",
      instance: "b",
      now: 10,
      observation: { instance: "a", state: "busy", expires: 100 },
    }).process_liveness
  ).toBe("unknown");
  expect(
    evaluateActivity({
      kind: "session",
      businessState: "failed",
      instance: "a",
      now: 10,
      observation: { instance: "a", state: "dead", expires: 100 },
    }).process_liveness
  ).toBe("unknown");
});
it("coverage requires a completed scan rather than a heartbeat and expires on clock reversal", () => {
  expect(
    evaluateCoverage({
      now: 50,
      sampled: 0,
      deadline: 100,
      complete: false,
      ownerCurrent: true,
    })
  ).toBe("degraded");
  expect(
    evaluateCoverage({
      now: 50,
      sampled: 20,
      deadline: 100,
      complete: true,
      ownerCurrent: true,
    })
  ).toBe("covered");
  expect(
    evaluateCoverage({
      now: 10,
      sampled: 20,
      deadline: 100,
      complete: true,
      ownerCurrent: true,
    })
  ).toBe("unknown");
});
const base = { state: "awaiting_decision", turnId: "t", version: 4, now: 10 };
const grant = {
  id: "g",
  status: "active",
  turnId: "t",
  version: 3,
  expires: 100,
};
it("recognizes the legitimate reservation version before comparing grant version", () => {
  expect(
    classifyAttentionWait({
      ...base,
      grant,
      message: { id: "m", state: "accepted" },
      attempt: {
        state: "reserved",
        sourceTurn: "t",
        sourceVersion: 3,
        reservationVersion: 4,
        messageId: "m",
      },
    })
  ).toMatchObject({
    reason: "accepted_in_flight_or_uncertain",
    owner: "system",
    blocked: true,
  });
  expect(classifyAttentionWait({ ...base, grant })).toMatchObject({
    reason: "stale_grant",
    blocked: true,
  });
});
it("failed, stale, expired and uncertain attempts never permit an automatic new answer", () => {
  expect(
    classifyAttentionWait({ ...base, message: { id: "m", state: "failed" } })
  ).toMatchObject({ blocked: true, reason: "delivery_failed" });
  expect(
    classifyAttentionWait({
      ...base,
      grant: { ...grant, version: 4, expires: 5 },
      attempt: { state: "checking", sourceTurn: "t", sourceVersion: 4 },
    })
  ).toMatchObject({ blocked: true, reason: "stale_attempt" });
  expect(classifyAttentionWait({ ...base })).toMatchObject({
    blocked: false,
    owner: "human",
  });
});
