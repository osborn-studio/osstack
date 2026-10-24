import { expect, it } from "vitest";
import { AttentionCiReader } from "./attention-ci.js";
const input = {
  repo: "owner/repo",
  pr: 1,
  head: "a".repeat(40),
  required: ["test"],
};
it("never treats missing checks or a different head as success", async () => {
  const a = new AttentionCiReader({
    run: async () =>
      JSON.stringify({ headRefOid: input.head, statusCheckRollup: [] }),
  });
  expect((await a.read(input)).state).toBe("unknown");
  const b = new AttentionCiReader({
    run: async () =>
      JSON.stringify({
        headRefOid: "b".repeat(40),
        statusCheckRollup: [{ name: "test", conclusion: "SUCCESS" }],
      }),
  });
  expect((await b.read(input)).reason).toBe("head_changed");
});
it("backs off failed reads and bounds concurrent requests", async () => {
  let calls = 0;
  const a = new AttentionCiReader({
    run: async () => {
      calls++;
      throw new Error("429");
    },
  });
  await a.read(input, 100);
  await a.read(input, 101);
  expect(calls).toBe(1);
  expect((await a.read(input, 100000)).state).toBe("unknown");
  expect(calls).toBe(2);
});
