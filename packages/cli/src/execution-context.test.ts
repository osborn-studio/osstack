import { createHash } from "node:crypto";
import { compileBugFix } from "@osstack/skill-registry/bug-fix-compiler";
import { sourceSnapshotDigest } from "@osstack/protocol/source";
import { mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentAdapter, AgentTask } from "@osstack/agents";
import { createScratchDirSync } from "@osstack/core";
import type { HermesEvent } from "@osstack/hermes-adapter";
import { executionContextDigest, type ExecutionContextEntry } from "@osstack/knowledge";
import { afterEach, expect, it, vi } from "vitest";
import { createMethodContext } from "./method-context.js";
import { createExecutionContextAdapters, createPinnedLocalContextLoader, loadExecutionContextConfig, type ExecutionContextReceipt } from "./execution-context.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const event = { type: "run.started" } as HermesEvent;
const task: AgentTask = { run_id: "run", task_id: "task", session_id: "session", capability_id: "code", prompt: "Find knowledge about cache isolation" };
function fixture() {
  const root = realpathSync(createScratchDirSync("tests", "execution-context")); roots.push(root);
  const captured: AgentTask[] = []; const signals: AbortSignal[] = [];
  const adapter: AgentAdapter = { id: "fake", display_name: "Fake", cost_tier: "low",
    capabilities() { expect(this).toBe(adapter); return []; },
    async isAvailable() { expect(this).toBe(adapter); return { available: true, last_checked_at: 0 }; },
    async runtimeIdentity() { expect(this).toBe(adapter); return { adapter_id: "fake", adapter_version: "1", auth_mode: "none", provider_id: "test", model_id: "test", evidence_source: "reported" }; },
    async confirmStopped() { expect(this).toBe(adapter); return { stopped: false }; },
    async *invoke(input, signal) { expect(this).toBe(adapter); captured.push(input); signals.push(signal); yield event; },
  };
  const receipts: ExecutionContextReceipt[] = [];
  const recordReceipt = vi.fn(async (receipt: ExecutionContextReceipt) => {
    receipts.push(receipt); const raw = JSON.stringify(receipt); const path = join(root, `receipt-${receipts.length}.json`); writeFileSync(path, raw, { mode: 0o600 });
    return { path, digest: executionContextDigest(raw) };
  });
  const entry: ExecutionContextEntry = { id: "knowledge", source_kind: "knowledge", source_ref: "pack.json#chunk", source_digest: "a".repeat(64),
    text_sha256: executionContextDigest("cache isolation reference"), text: "cache isolation reference", scope: { repo_path: root, tenant: "default" },
    tier: "optional", evidence_kind: "pinned_local_pack", verified_at_ms: 100, expires_at_ms: 1000 };
  const loadContext = vi.fn(async (_task: AgentTask, _scope: { workspacePath: string; signal: AbortSignal }) => [entry]);
  return { root, adapter, captured, signals, receipts, recordReceipt, loadContext,
    options: { adapters: [adapter], workspacePath: root, mode: "local" as const, loadContext, recordReceipt, nowMs: () => 500 } };
}
async function consume(adapter: AgentAdapter, signal = new AbortController().signal) { const rows: HermesEvent[] = []; for await (const item of adapter.invoke(task, signal)) rows.push(item); return rows; }

it("defaults off with original adapter identity and zero loaders or receipts", async () => {
  const f = fixture(); const { mode: _mode, ...options } = f.options;
  const wrapped = createExecutionContextAdapters(options);
  expect(wrapped.adapters).toBe(options.adapters);
  await consume(wrapped.adapters[0]!);
  expect(f.loadContext).not.toHaveBeenCalled(); expect(f.recordReceipt).not.toHaveBeenCalled(); expect(f.captured[0]).toBe(task);
});
it.each(["off", undefined] as const)("rejects mandatory methods when context mode is %s", mode => {
  const f = fixture(); const { mode: _mode, ...base } = f.options;
  const methodContext = { load: vi.fn(() => { throw new Error("must not load"); }), validateSync: vi.fn() };
  expect(() => createExecutionContextAdapters({ ...base, ...(mode === undefined ? {} : { mode }), methodContext }))
    .toThrow("invalid_execution_context_options");
  expect(methodContext.load).not.toHaveBeenCalled(); expect(methodContext.validateSync).not.toHaveBeenCalled();
  expect(f.captured).toHaveLength(0); expect(f.recordReceipt).not.toHaveBeenCalled();
});
it("passes the actual augmented prompt and preserves this-bound methods and stop uncertainty", async () => {
  const f = fixture(); const wrapped = createExecutionContextAdapters({ ...f.options, contractDigest: "b".repeat(64), contractBrief: "local verification only" });
  const adapter = wrapped.adapters[0]!;
  adapter.capabilities(); await adapter.isAvailable(); await adapter.runtimeIdentity!(); expect(await adapter.confirmStopped!("run")).toEqual({ stopped: false });
  expect(await consume(adapter)).toEqual([event]);
  expect(f.captured[0]!.prompt).toContain("cache isolation reference");
  expect(f.captured[0]!.prompt).toContain("local verification only");
  expect(f.receipts.map(row => row.phase)).toEqual(["prepared", "adapter_observed"]);
  for (const receipt of f.receipts) {
    expect(receipt.prompt_sha256).toBe(executionContextDigest(f.captured[0]!.prompt));
    expect(receipt.run_id).toBe(task.run_id); expect(receipt.task_id).toBe(task.task_id);
    expect(receipt.contract_digest).toBe("b".repeat(64));
    expect(JSON.stringify(receipt)).not.toContain("cache isolation reference");
  }
  for (const ref of wrapped.receiptRefs()) expect(executionContextDigest(readFileSync(ref.path))).toBe(ref.digest);
});
it("rejects partial contract identity and mandatory overflow before invoking", async () => {
  const f = fixture();
  expect(() => createExecutionContextAdapters({ ...f.options, contractDigest: "b".repeat(64) })).toThrow("invalid_execution_context_contract");
  const wrapped = createExecutionContextAdapters({ ...f.options, maxPromptBytes: 10 });
  await expect(consume(wrapped.adapters[0]!)).rejects.toThrow("mandatory_budget_exceeded");
  expect(f.captured).toEqual([]); expect(f.recordReceipt).not.toHaveBeenCalled();
});
it("blocks invocation if prepared evidence cannot be persisted", async () => {
  const f = fixture(); f.recordReceipt.mockRejectedValueOnce(new Error("PRIVATE_WRITE_ERROR"));
  await expect(consume(createExecutionContextAdapters(f.options).adapters[0]!)).rejects.toThrow("execution_context_receipt_failed_before_invoke");
  expect(f.captured).toEqual([]);
});
it("aborts and closes the iterator on observed-receipt failure without claiming physical stop", async () => {
  const f = fixture(); let closed = false;
  f.adapter.invoke = async function* (input, signal) { f.captured.push(input); f.signals.push(signal); try { yield event; yield event; } finally { closed = true; } };
  f.recordReceipt.mockImplementationOnce(async receipt => { f.receipts.push(receipt); return { path: join(f.root, "prepared.json"), digest: "a".repeat(64) }; }).mockRejectedValueOnce(new Error("PRIVATE_WRITE_ERROR"));
  const wrapped = createExecutionContextAdapters(f.options);
  await expect(consume(wrapped.adapters[0]!)).rejects.toThrow("execution_context_receipt_failed_after_invoke");
  expect(closed).toBe(true); expect(f.signals[0]!.aborted).toBe(true); expect(wrapped.receiptRefs()).toHaveLength(1);
  expect(await wrapped.adapters[0]!.confirmStopped!("run")).toEqual({ stopped: false });
});
it("cancels a stalled loader and discards its late result without invocation", async () => {
  const f = fixture(); let resolve!: (rows: ExecutionContextEntry[]) => void;
  f.loadContext.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  const controller = new AbortController(); const pending = consume(createExecutionContextAdapters(f.options).adapters[0]!, controller.signal);
  await vi.waitFor(() => expect(f.loadContext).toHaveBeenCalled()); controller.abort();
  await expect(pending).rejects.toThrow("execution_context_aborted"); resolve([]); await Promise.resolve();
  expect(f.captured).toEqual([]); expect(f.recordReceipt).not.toHaveBeenCalled();
});

function configFixture() {
  const f = fixture();
  const pack = { id: "test/pack", version: "1", name: "Test", license: "MIT", source_kind: "internal", quality_score: 90, scope: "project",
    chunks: [{ chunk_id: "cache", title: "Cache", body: "cache isolation reference", tier: "mandatory" }] };
  const packRaw = JSON.stringify(pack); writeFileSync(join(f.root, "pack.json"), packRaw);
  const config = { schema_version: 1, mode: "local", repo_path: f.root, default_tenant: true,
    packs: [{ path: "pack.json", pack_id: "test/pack", version: "1", sha256: executionContextDigest(packRaw), scope: "project", verified_at_ms: 100, expires_at_ms: 1000 }] };
  const configPath = join(f.root, "context.json"); writeFileSync(configPath, JSON.stringify(config));
  return { ...f, config, configPath, pack };
}
it("loads only explicit pinned local packs and strips source-declared authority", async () => {
  const f = configFixture(); const config = await loadExecutionContextConfig(f.configPath, f.root);
  const rows = await createPinnedLocalContextLoader(config)(task, { workspacePath: f.root, signal: new AbortController().signal });
  expect(rows).toHaveLength(1); expect(rows[0]!.tier).toBe("optional"); expect(rows[0]!.source_digest).toBe(f.config.packs[0]!.sha256);
  expect(rows[0]!.text_sha256).toBe(executionContextDigest(rows[0]!.text));
});
it.each(["hash", "version", "tenant", "scope", "escape"])("rejects invalid pack %s", async kind => {
  const f = configFixture();
  if (kind === "hash") writeFileSync(join(f.root, "pack.json"), JSON.stringify({ ...f.pack, name: "changed" }));
  if (kind === "version") f.config.packs[0]!.version = "2";
  if (kind === "scope") f.config.packs[0]!.scope = "official";
  if (kind === "tenant") { const raw = JSON.stringify({ ...f.pack, tenant_id: "other" }); writeFileSync(join(f.root, "pack.json"), raw); f.config.packs[0]!.sha256 = executionContextDigest(raw); }
  if (kind === "escape") { const elsewhere = realpathSync(createScratchDirSync("tests", "outside-pack")); roots.push(elsewhere); writeFileSync(join(elsewhere, "pack.json"), JSON.stringify(f.pack)); symlinkSync(join(elsewhere, "pack.json"), join(f.root, "alias.json")); f.config.packs[0]!.path = "alias.json"; }
  writeFileSync(f.configPath, JSON.stringify(f.config));
  const config = await loadExecutionContextConfig(f.configPath, f.root);
  await expect(createPinnedLocalContextLoader(config)(task, { workspacePath: f.root, signal: new AbortController().signal })).rejects.toThrow();
});
it("rejects config repo mismatch, unknown settings and traversal before retrieval", async () => {
  const f = configFixture(); const other = join(f.root, "other"); mkdirSync(other);
  await expect(loadExecutionContextConfig(f.configPath, other)).rejects.toThrow("execution_context_source_escape");
  writeFileSync(join(other, "context.json"), JSON.stringify(f.config));
  await expect(loadExecutionContextConfig(join(other, "context.json"), other)).rejects.toThrow("execution_context_scope_mismatch");
  writeFileSync(f.configPath, JSON.stringify({ ...f.config, cloud_url: "https://example.invalid" }));
  await expect(loadExecutionContextConfig(f.configPath, f.root)).rejects.toThrow("invalid_execution_context_config");
  f.config.packs[0]!.path = "../escape.json"; writeFileSync(f.configPath, JSON.stringify(f.config));
  await expect(loadExecutionContextConfig(f.configPath, f.root)).rejects.toThrow("invalid_execution_context_config");
});

it("keeps pinned source scope separate from the candidate execution workspace", async () => {
  const f = fixture(); const candidate = realpathSync(createScratchDirSync("tests", "context-candidate")); roots.push(candidate);
  const input = { ...task, context: { repo_path: candidate } };
  const wrapped = createExecutionContextAdapters(f.options);
  for await (const _ of wrapped.adapters[0]!.invoke(input, new AbortController().signal)) { /* consume */ }
  expect(f.loadContext.mock.calls[0]![1]).toMatchObject({ workspacePath: f.root });
  expect(f.captured[0]!.context?.repo_path).toBe(candidate);
  expect(f.receipts.every(row => row.repo_path === f.root && row.execution_repo_path === candidate)).toBe(true);
});
it("attributes aggregate receipts to tasks and sessions without relying on arrival order", async () => {
  const f = fixture(); const wrapped = createExecutionContextAdapters(f.options);
  await consume(wrapped.adapters[0]!);
  for await (const _ of wrapped.adapters[0]!.invoke({ ...task, run_id: "other-run", task_id: "other-task", session_id: "other-session" }, new AbortController().signal)) { /* consume */ }
  const first = wrapped.receiptRefs({ session_id: task.session_id, run_id: task.run_id, task_id: task.task_id });
  const other = wrapped.receiptRefs({ session_id: "other-session" });
  expect(first).toHaveLength(2); expect(other).toHaveLength(2); expect(wrapped.receiptRefs()).toHaveLength(4);
  expect(first.some(ref => other.some(row => row.path === ref.path))).toBe(false);
  expect(wrapped.receiptRefs({ run_id: "absent" })).toEqual([]);
});
it("does not publish late receipt refs after cancellation", async () => {
  const f = fixture(); let finish!: (value: { path: string; digest: string }) => void;
  f.recordReceipt.mockImplementationOnce(() => new Promise(done => { finish = done; }));
  const wrapped = createExecutionContextAdapters(f.options); const controller = new AbortController();
  const pending = consume(wrapped.adapters[0]!, controller.signal);
  await vi.waitFor(() => expect(f.recordReceipt).toHaveBeenCalled()); controller.abort();
  await expect(pending).rejects.toThrow("execution_context_aborted");
  finish({ path: join(f.root, "late.json"), digest: "a".repeat(64) }); await new Promise(done => setTimeout(done, 0));
  expect(wrapped.receiptRefs()).toEqual([]); expect(f.captured).toEqual([]);
});
it("blocks expired sources after slow prepared persistence", async () => {
  const f = fixture(); let time = 500;
  f.recordReceipt.mockImplementationOnce(async () => { time = 1001; return { path: join(f.root, "prepared.json"), digest: "a".repeat(64) }; });
  await expect(consume(createExecutionContextAdapters({ ...f.options, nowMs: () => time }).adapters[0]!)).rejects.toThrow("execution_context_expired_before_invoke");
  expect(f.captured).toEqual([]);
});
it("bounds cleanup of an adapter with a stalled next and preserves stop uncertainty", async () => {
  const f = fixture(); let stopped = false;
  f.adapter.invoke = (input, signal) => { f.captured.push(input); f.signals.push(signal); const iterator: AsyncIterableIterator<HermesEvent> = {
    [Symbol.asyncIterator]() { return this; }, next: () => new Promise(() => {}),
    return: () => { stopped = true; return new Promise(() => {}); },
  }; return iterator; };
  const wrapped = createExecutionContextAdapters(f.options); const controller = new AbortController();
  const pending = consume(wrapped.adapters[0]!, controller.signal);
  await vi.waitFor(() => expect(f.captured).toHaveLength(1)); controller.abort();
  await expect(pending).rejects.toThrow("execution_context_aborted");
  expect(stopped).toBe(true); expect(f.signals[0]!.aborted).toBe(true);
  expect(await wrapped.adapters[0]!.confirmStopped!(task.run_id)).toEqual({ stopped: false });
});
it("preaborted invocation has no loader, evidence or adapter side effects", async () => {
  const f = fixture(); const controller = new AbortController(); controller.abort();
  await expect(consume(createExecutionContextAdapters(f.options).adapters[0]!, controller.signal)).rejects.toThrow("execution_context_aborted");
  expect(f.loadContext).not.toHaveBeenCalled(); expect(f.recordReceipt).not.toHaveBeenCalled(); expect(f.captured).toEqual([]);
});
it("rejects duplicate pack ids even when the loader is constructed directly", async () => {
  const f = configFixture(); const config = await loadExecutionContextConfig(f.configPath, f.root);
  expect(() => createPinnedLocalContextLoader({ ...config, packs: [...config.packs, ...config.packs] })).toThrow("invalid_execution_context_config");
});
it("does not advance the underlying adapter after cancellation while yielded", async () => {
  const f = fixture(); let advanced = false;
  f.adapter.invoke = async function* () { yield event; advanced = true; yield event; };
  const controller = new AbortController(); const iterator = createExecutionContextAdapters(f.options).adapters[0]!.invoke(task, controller.signal)[Symbol.asyncIterator]();
  await iterator.next(); controller.abort();
  await expect(iterator.next()).rejects.toThrow("execution_context_aborted");
  expect(advanced).toBe(false);
});
it("keeps selection time distinct from first-event observation time", async () => {
  const f = fixture(); let clock = 500;
  f.adapter.invoke = async function* () { clock = 800; yield event; };
  await consume(createExecutionContextAdapters({ ...f.options, nowMs: () => clock }).adapters[0]!);
  expect(f.receipts.map(row => row.sampled_at_ms)).toEqual([500, 500]);
  expect(f.receipts[0]!.observed_at_ms).toBeUndefined(); expect(f.receipts[1]!.observed_at_ms).toBe(800);
  expect(f.receipts[0]!.mandatory.find(row => row.source_kind === "instruction")!.text_sha256).toBe(executionContextDigest(task.prompt));
});
it("rejects non-regular sources with a stable unavailable error", async () => {
  const f = configFixture(); const config = await loadExecutionContextConfig(f.configPath, f.root);
  mkdirSync(join(f.root, "directory")); config.packs[0]!.path = "directory";
  await expect(createPinnedLocalContextLoader(config)(task, { workspacePath: f.root, signal: new AbortController().signal })).rejects.toThrow("execution_context_source_unavailable");
});
it("rejects a pack before its full size would cross the combined byte budget", async () => {
  const f = configFixture(); const config = await loadExecutionContextConfig(f.configPath, f.root); config.packs = [];
  for (let i = 0; i < 5; i++) {
    const pack = { ...f.pack, id: `pack/${i}`, chunks: [{ chunk_id: "cache", title: "Cache", body: "cache " + "x".repeat(900_000) }] };
    const raw = JSON.stringify(pack); const path = `pack-${i}.json`; writeFileSync(join(f.root, path), raw);
    config.packs.push({ ...f.config.packs[0]!, scope: "project", path, pack_id: pack.id, sha256: executionContextDigest(raw) });
  }
  await expect(createPinnedLocalContextLoader(config)(task, { workspacePath: f.root, signal: new AbortController().signal })).rejects.toThrow("execution_context_source_too_large");
});

it("keeps observed-receipt failure execution-unconfirmed through the real candidate executor without retry", async () => {
  const { executeCandidateImplementation, ExecutionPlan } = await import("@osstack/loop");
  const f = fixture();
  f.recordReceipt.mockImplementationOnce(async receipt => {
    f.receipts.push(receipt);
    return { path: join(f.root, "prepared.json"), digest: "a".repeat(64) };
  }).mockRejectedValueOnce(new Error("disk full"));
  const wrapped = createExecutionContextAdapters(f.options);
  const result = await executeCandidateImplementation({
    plan: ExecutionPlan.parse({ plan_id: "receipt-failure", agent_id: f.adapter.id, max_iterations: 3,
      task: { task_id: task.task_id, capability: "code.write", prompt: task.prompt, source: "manual" },
      stop_condition: { type: "tests_pass" } }),
    workspace: { workspace_id: "registered", workspace_path: f.root },
    adapters: wrapped.adapters, authorize: async () => ({ allow: true }), cancellationGraceMs: 20,
  });
  expect(result).toMatchObject({ status: "execution_unconfirmed", execution: {
    failure_code: "cancellation_unconfirmed", cancellation: { invocation_started: true, stop_confirmed: false },
  } });
  expect(f.captured).toHaveLength(1);
  expect(f.signals[0]!.aborted).toBe(true);
  expect(wrapped.receiptRefs()).toHaveLength(1);
});
it("attests adapter admission rather than claiming a later provider-wire authorization fence", async () => {
  const f = fixture(); let authority = true; let admitted = false;
  f.adapter.invoke = async function* (input) {
    admitted = true;
    await Promise.resolve();
    authority = false; // A later adapter-owned boundary cannot retract an admitted prompt.
    f.captured.push(input); yield event;
  };
  await consume(createExecutionContextAdapters({ ...f.options, validateContextSync: () => {
    expect(authority).toBe(true); expect(admitted).toBe(false);
  } }).adapters[0]!);
  expect(f.captured).toHaveLength(1);
  expect(f.receipts.every(receipt => receipt.evidence_boundary === "agent_task_prompt_not_provider_wire")).toBe(true);
});


it("rechecks required method bytes after receipt persistence without losing existing source validators", async () => {
  const f = fixture(); const body = "Required method"; writeFileSync(join(f.root, "method.md"), body);
  const compilation = compiledFixture(f.root, body, task.task_id);
  const methodContext = createMethodContext({ compiled: compilation.pin, schema_version: 1, task_id: task.task_id, package_version: "0.15.36", proposal_digest: compilation.compiled.proposal_digest, max_bytes: 4096,
    roles: [{ role: "builder", capability_id: task.capability_id, materials: [{ path: "method.md", sha256: executionContextDigest(body) }] }] });
  const validateContext = vi.fn(async () => {}); const validateContextSync = vi.fn(() => {});
  f.recordReceipt.mockImplementationOnce(async receipt => { f.receipts.push(receipt); writeFileSync(join(f.root, "method.md"), "Changed during receipt"); return { path: join(f.root, "prepared.json"), digest: "a".repeat(64) }; });
  await expect(consume(createExecutionContextAdapters({ ...f.options, methodContext, validateContext, validateContextSync }).adapters[0]!)).rejects.toThrow("method_context_pin_mismatch");
  expect(f.captured).toEqual([]); expect(validateContext).toHaveBeenCalledOnce(); expect(validateContextSync).toHaveBeenCalledOnce();
});
it("charges escaped mandatory framing to final prompt budget before optional selection", async () => {
  const f = fixture(); const body = "<".repeat(200); writeFileSync(join(f.root, "method.md"), body);
  const compilation = compiledFixture(f.root, body, task.task_id);
  const methodContext = createMethodContext({ compiled: compilation.pin, schema_version: 1, task_id: task.task_id, package_version: "0.15.36", proposal_digest: compilation.compiled.proposal_digest, max_bytes: 4096,
    roles: [{ role: "builder", capability_id: task.capability_id, materials: [{ path: "method.md", sha256: executionContextDigest(body) }] }] });
  await expect(consume(createExecutionContextAdapters({ ...f.options, methodContext, maxPromptBytes: 1000 }).adapters[0]!)).rejects.toThrow("mandatory_budget_exceeded");
  expect(f.captured).toEqual([]); expect(f.recordReceipt).not.toHaveBeenCalled();
});

function compiledFixture(repo: string, text: string, taskId = "task") {
  const sha = (value: string) => createHash("sha256").update(value).digest("hex");
  const source_snapshot = { kind: "source_snapshot" as const, schema_version: 1 as const,
    pin: { kind: "source_pin" as const, schema_version: 1 as const, repository: "https://example.invalid/methods", commit: "a".repeat(40), subdir: "methods", content_sha256: sha("declared"), license_refs: ["license:MIT"] },
    files: [{ path: "methods/fix.md", mode: "100644" as const, blob: "b".repeat(40) }], dependencies: [] };
  const entries = ["repro", "regress", "accept"].map(id => ({ ref: "sha256:" + sha(id), command_bytes_sha256: sha(id), pass_codes: [0], fail_codes: [1] }));
  const obligations = [["intent_frame", "builder"], ["reproduction", "builder"], ["candidate_checks", "builder"], ["independent_review", "reviewer"], ["cleanup_receipt", "verifier"]] as const;
  const input = { schema_version: 1, target_repository: repo,
    intent: { kind: "material:intent_frame", schema_version: 1, task_id: taskId, intent_revision: 1, goals: ["Fix"], non_goals: ["No publication"], observations: ["A failure"], hypotheses: [], unknowns: [], source_refs: ["task:fixture"] },
    source_snapshot, source_snapshot_digest: sourceSnapshotDigest(source_snapshot),
    materials: ["builder", "reviewer", "verifier"].map(role => ({ role, text: role === "builder" ? text : role === "reviewer" ? "Review only" : "Verify only", sha256: sha(role === "builder" ? text : role === "reviewer" ? "Review only" : "Verify only") })),
    required_artifacts: { kind: "artifact_requirements", schema_version: 1, recipe_version: "bug-fix.v1", requirements: obligations.map(([artifact_ref_kind, producer_role]) => ({ artifact_ref_kind, producer_role, body_schema_digest: sha(artifact_ref_kind), verifier_policy_digest: sha("policy"), required: true })) },
    required_feature_ids: ["bug"], available_feature_ids: ["bug"],
    check_registry: { kind: "check_registry", schema_version: 1, entries },
    check_binding: { kind: "check_binding", schema_version: 1, repository: repo, primary_id: "accept", checks: ["reproduce", "regression", "acceptance"].map((role, i) => ({ id: ["repro", "regress", "accept"][i], role, registry_ref: entries[i]!.ref, required: true })) } };
  const compiled = compileBugFix(input); const bytes = JSON.stringify(compiled);
  writeFileSync(join(repo, "compiled.json"), bytes);
  return { input, compiled, pin: { path: "compiled.json", sha256: sha(bytes) } };
}

it("refuses compiled artifact replacement during prepared receipt persistence", async () => {
  const f = fixture(); const body = "Required method"; writeFileSync(join(f.root, "method.md"), body);
  const compilation = compiledFixture(f.root, body, task.task_id);
  const methodContext = createMethodContext({ compiled: compilation.pin, schema_version: 1, task_id: task.task_id, package_version: "0.15.36", proposal_digest: compilation.compiled.proposal_digest, max_bytes: 4096,
    roles: [{ role: "builder", capability_id: task.capability_id, materials: [{ path: "method.md", sha256: executionContextDigest(body) }] }] });
  f.recordReceipt.mockImplementationOnce(async receipt => { f.receipts.push(receipt); writeFileSync(join(f.root, "compiled.json"), "{}"); return { path: join(f.root, "prepared.json"), digest: "a".repeat(64) }; });
  await expect(consume(createExecutionContextAdapters({ ...f.options, methodContext }).adapters[0]!)).rejects.toThrow("method_context_pin_mismatch");
  expect(f.captured).toEqual([]);
});
