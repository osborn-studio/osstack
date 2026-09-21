import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildDecisionRequest,
  DECISION_MODEL,
} from "@osstack/core/decision-advice";
import {
  initializeDecisionStore,
  runStoredDecision,
  decisionStoreStatus,
} from "./decision-store.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "decision-store-test-"));
  roots.push(root);
  const store = join(root, "store");
  await initializeDecisionStore(store, {
    scopeId: "test",
    maxCalls: 2,
    maxMicroUSD: 3000,
    maxInputTokens: 70000,
  });
  return store;
}
function request(revision = 0) {
  return buildDecisionRequest({
    schemaVersion: 1,
    scopeId: "test",
    taskId: "t",
    taskRevision: revision,
    purpose: "failure_label",
    state: "test assertion failed",
  });
}
function answer(): import("@osstack/agents/decision-advisor").DecisionAdviceResult {
  return {
    status: "answered" as const,
    answer: {
      model: DECISION_MODEL,
      choice: "assertion",
      probabilities: {
        assertion: 1,
        environment: 0,
        context: 0,
        output_contract: 0,
        other: 0,
        abstain: 0,
      },
      confidence: 1,
      inputTokens: 100,
      outputTokens: 1,
    },
  };
}

describe("durable decision advice budget", () => {
  it("settles usage and never sends the same digest twice", async () => {
    const store = await setup();
    const send = vi.fn(async () => answer());
    const first = await runStoredDecision(store, request(), send);
    expect(first.status).toBe("answered");
    expect(await runStoredDecision(store, request(), send)).toEqual(first);
    expect(send).toHaveBeenCalledTimes(1);
    expect(await decisionStoreStatus(store)).toMatchObject({
      calls: 1,
      chargedOrHeldMicroUSD: 5,
      chargedOrHeldInputTokens: 100,
      unknown: 0,
    });
    await runStoredDecision(store, request(1), send);
    await expect(runStoredDecision(store, request(2), send)).rejects.toThrow(
      "DECISION_BUDGET_EXHAUSTED",
    );
  });
  it("durably reserves before send and keeps the full hold after an ambiguous failure", async () => {
    const store = await setup();
    const req = request();
    const send = vi.fn(async () => {
      expect(
        JSON.parse(await readFile(join(store, `${req.digest}.json`), "utf8"))
          .status,
      ).toBe("dispatched");
      throw Error("secret transport detail");
    });
    expect(await runStoredDecision(store, req, send)).toMatchObject({
      status: "unknown",
    });
    expect(await decisionStoreStatus(store)).toMatchObject({
      chargedOrHeldMicroUSD: 2753,
      chargedOrHeldInputTokens: 65536,
      unknown: 1,
    });
    await expect(runStoredDecision(store, request(1), send)).rejects.toThrow(
      "DECISION_BUDGET_EXHAUSTED",
    );
    await runStoredDecision(store, req, send);
    expect(send).toHaveBeenCalledTimes(1);
    expect(
      await readFile(join(store, `${req.digest}.json`), "utf8"),
    ).not.toContain("secret transport");
  });
  it("fails closed on concurrent writers and crash-left locks", async () => {
    const store = await setup();
    let finish!: () => void;
    let started!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const wait = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const first = runStoredDecision(store, request(), async () => {
      started();
      await wait;
      return answer();
    });
    await entered;
    await expect(
      runStoredDecision(store, request(1), async () => answer()),
    ).rejects.toThrow("DECISION_STORE_BUSY");
    finish();
    await first;
    await mkdir(join(store, ".lock"));
    expect(await decisionStoreStatus(store)).toMatchObject({
      calls: 1,
      snapshot: "best_effort",
    });
    await expect(
      runStoredDecision(store, request(1), async () => answer()),
    ).rejects.toThrow("DECISION_STORE_BUSY");
  });
  it("rejects store symlinks and wrong scope before dispatch", async () => {
    const store = await setup();
    const send = vi.fn(async () => answer());
    const alias = `${store}-alias`;
    await symlink(store, alias);
    await expect(runStoredDecision(alias, request(), send)).rejects.toThrow(
      "DECISION_STORE_UNSAFE",
    );
    const wrong = buildDecisionRequest({
      ...request().input,
      scopeId: "other",
    });
    await expect(runStoredDecision(store, wrong, send)).rejects.toThrow(
      "DECISION_SCOPE_MISMATCH",
    );
    expect(send).not.toHaveBeenCalled();
  });
  it("rejects reinitialization, unexpected files, and mismatched record identities", async () => {
    const store = await setup();
    const config = await readFile(join(store, "config.json"), "utf8");
    await expect(
      initializeDecisionStore(`${store}-invalid`, {
        scopeId: "abstain",
        maxCalls: 2,
        maxMicroUSD: 3000,
        maxInputTokens: 70000,
      }),
    ).rejects.toMatchObject({ name: "ZodError" });
    await expect(
      initializeDecisionStore(store, {
        scopeId: "test",
        maxCalls: 2,
        maxMicroUSD: 3000,
        maxInputTokens: 70000,
      }),
    ).rejects.toThrow();
    expect(await readFile(join(store, "config.json"), "utf8")).toBe(config);
    await writeFile(join(store, ".DS_Store"), "finder metadata");
    expect(await decisionStoreStatus(store)).toMatchObject({ calls: 0 });
    await writeFile(join(store, "unexpected.json"), "{}", { mode: 0o600 });
    await expect(decisionStoreStatus(store)).rejects.toThrow(
      "DECISION_STORE_CORRUPT",
    );
    await rm(join(store, "unexpected.json"));
    await writeFile(
      join(store, `${request().digest}.json`),
      JSON.stringify({
        schemaVersion: 1,
        digest: "f".repeat(64),
        status: "dispatched",
      }),
      { mode: 0o600 },
    );
    await expect(decisionStoreStatus(store)).rejects.toThrow(
      "DECISION_STORE_CORRUPT",
    );
  });

  it("reports safe failure categories without releasing an uncertain HTTP hold", async () => {
    const store = await setup();
    expect(
      await runStoredDecision(store, request(), async () => ({
        status: "unavailable",
        reason: "http_error",
        httpStatus: 401,
      })),
    ).toMatchObject({
      status: "unknown",
      failureReason: "http_error",
      httpStatus: 401,
    });
    expect(await decisionStoreStatus(store)).toMatchObject({
      chargedOrHeldMicroUSD: 2753,
    });
  });
});
