import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it } from "vitest";
import { GraphRunStore, openDb } from "@osstack/core";
import { ExecutionPlan } from "@osstack/loop";
import { startDaemon, type DaemonHandles } from "./daemon.js";
import { healthyAutonomyHealth } from "./test-healthy-autonomy.js";

let daemon: DaemonHandles | undefined; let root: string | undefined;
const originalHome = process.env["OSSTACK_HOME"];
afterEach(async () => { await daemon?.close(); if (root) rmSync(root, { recursive: true, force: true });
  if (originalHome === undefined) delete process.env["OSSTACK_HOME"]; else process.env["OSSTACK_HOME"] = originalHome; });
it("registers an in-process broker over the daemon database and shared admission", async () => {
  root = mkdtempSync(join(tmpdir(), "g12-daemon-")); const repo = join(root, "repo");
  execFileSync("git", ["init", "-q", repo]); mkdirSync(join(repo, ".osstack"));
  writeFileSync(join(repo, ".osstack", "policy.yaml"), "schema_version: 1\nmode: execute\n");
  process.env["OSSTACK_HOME"] = join(root, "home");
  const identity = {};
  daemon = await startDaemon({ socketPath: join(root, "daemon.sock"), adapters: [], autonomyHealth: async () => healthyAutonomyHealth(),
    graphIdentities: new Map([[identity, { workspacePath: repo, authorize: async () => {} }]]) });
  const db = openDb({ path: daemon.dbPath });
  const scope = { schemaVersion: 1 as const, tenantId: "tenant", principalId: "principal", workspaceId: "workspace" };
  const store = new GraphRunStore(db);
  const created = store.create({ schemaVersion: 1, kind: "start", scope, idempotencyKey: "start", inputArtifactRef: "input",
    source: { product: "osstack", requestId: "source" }, spec: { schemaVersion: 1, template: "code-delivery-v1", publication: "artifact_only",
      input: { taskRef: "task", repositoryRef: "repo", baseRevision: "a".repeat(40), acceptanceRef: "acceptance" },
      limits: { maxEpochs: 1, maxBranchAttempts: 1, maxConcurrentReaders: 1, maxConcurrentWritersPerRepo: 1,
        maxActionStarts: 5, deadlineSeconds: 60, tokenReservationLimit: 100 } } },
    { executionModel: "langgraph-functional-v1", durability: "sync", engineVersion: "1", checkpointVersion: "1", templateVersion: "1",
      registryVersion: "1", compilerVersion: "1", schemaVersion: "1", compiledProgramDigest: "b".repeat(64) }, Date.now());
  const run = store.acquireLease({ scope, graphRunId: created.graphRunId, expectedGeneration: 0, expectedRevision: 0,
    expectedOwner: null, identity: created.identity, now: Date.now(), owner: "worker", leaseExpiresAt: Date.now() + 60_000 });
  db.close();
  const broker = await daemon.graphActionBroker(); expect(await daemon.graphActionBroker()).toBe(broker);
  const connection = {}; const action = { kind: "implement" as const, inputArtifactRef: "input", workspaceLeaseRef: "workspace" };
  broker.register(connection, { scope, graphRunId: run.graphRunId, identity: run.identity, generation: 1, owner: "worker", epoch: 0,
    workspace: { workspace_id: "workspace", workspace_path: repo }, authorize: () => {}, actions: [{ nodeId: "implement", effectSlot: "invoke",
      action, tokenReservation: 10, execution: { kind: "command", command: "printf once >> output.txt",
        plan: ExecutionPlan.parse({ plan_id: "plan", agent_id: "local-command", task: { task_id: "task", capability: "code.write", prompt: "implement", source: "manual" }, stop_condition: { type: "tests_pass" } }) },
      persist: async () => ({ evidenceRef: "saved", result: { schemaVersion: 1, kind: "implementation_complete", workspaceLeaseRef: "workspace", receiptRef: "saved" } }) }] });
  const request = { schemaVersion: 1, kind: "worker_action", requestId: "request", scope, graphRunId: run.graphRunId,
    specHash: run.identity.specHash, generation: 1, epoch: 0, nodeId: "implement", effectSlot: "invoke", action };
  expect(await broker.handle({}, request)).toMatchObject({ kind: "worker_action_rejected" });
  const held = await daemon.acquireGraphAdmission(identity, { runId: "other-graph" });
  let settled = false; const pending = broker.handle(connection, request).then(value => { settled = true; return value; });
  await new Promise(resolve => setTimeout(resolve, 30)); expect(settled).toBe(false); await held.release();
  expect(await pending).toMatchObject({ outcome: { state: "confirmed" } });
  expect(readFileSync(join(repo, "output.txt"), "utf8")).toBe("once");
});
