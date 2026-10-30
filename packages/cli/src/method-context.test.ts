import { compileBugFix } from "@osstack/skill-registry/bug-fix-compiler";
import { sourceSnapshotDigest } from "@osstack/protocol/joint";
import { createHash } from "node:crypto";
import { mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentTask } from "@osstack/agents";
import { createScratchDirSync } from "@osstack/core";
import { afterEach, expect, it } from "vitest";
import { createMethodContext } from "./method-context.js";
const roots: string[] = [];
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });
const hash = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
const task: AgentTask = { run_id: "run", task_id: "task", session_id: "session", capability_id: "code.write", prompt: "Fix" };
function fixture() {
  const root = realpathSync(createScratchDirSync("tests", "method-context")); roots.push(root);
  const body = "Read complete material 中文\n";
  writeFileSync(join(root, "method.md"), body);
  const compilation = compiledFixture(root, body);
  const config = { compiled: compilation.pin, schema_version: 1, task_id: "task", package_version: "0.15.36", proposal_digest: compilation.compiled.proposal_digest, max_bytes: 4096,
    roles: [{ role: "builder", capability_id: "code.write", materials: [{ path: "method.md", sha256: hash(body) }] }] };
  return { root, body, config, compilation, scope: { workspacePath: root, signal: new AbortController().signal } };
}
it("selects explicit roles without inferring task context claims and refuses another task", () => {
  const f = fixture(); writeFileSync(join(f.root, "review.md"), "Review only");
  f.config.roles.push({ role: "reviewer", capability_id: "review.code", materials: [{ path: "review.md", sha256: hash("Review only") }] });
  const loader = createMethodContext(f.config);
  const build = loader.load({ ...task, context: { role: "reviewer" } }, f.scope);
  expect(build.receipt.role).toBe("builder"); expect(build.text).not.toContain("Review only");
  expect(loader.load({ ...task, capability_id: "review.code" }, f.scope).receipt.role).toBe("reviewer");
  expect(() => loader.load({ ...task, task_id: "another" }, f.scope)).toThrow("method_context_task_mismatch");
});
it("allows multiple distinct capabilities for a role and snapshots parsed config", () => {
  const f = fixture(); f.config.roles.push({ ...f.config.roles[0]!, capability_id: "other.code" });
  const loader = createMethodContext(f.config); f.config.roles[0]!.materials[0]!.sha256 = "0".repeat(64);
  expect(loader.load(task, f.scope).receipt.materials[0]!.sha256).toBe(hash(f.body));
  expect(loader.load({ ...task, capability_id: "other.code" }, f.scope).receipt.role).toBe("builder");
});
it.each(["../method.md", "/method.md", "dir//file", "./method.md", "dir/../file", "a\\b", "a\u0000b"])("rejects unsafe declared path %j", path => {
  const f = fixture(); f.config.roles[0]!.materials[0]!.path = path;
  expect(() => createMethodContext(f.config)).toThrow("method_context_invalid_config");
});
it.each(["unknown-field", "missing-proposal", "digest-array", "role", "duplicate-capability", "duplicate-path"])("rejects malformed declaration %s", kind => {
  const f = fixture(); const raw: Record<string, unknown> = structuredClone(f.config);
  if (kind === "unknown-field") raw.extra = true;
  if (kind === "missing-proposal") delete raw.proposal_digest;
  if (kind === "digest-array") raw.proposal_digest = [f.config.proposal_digest];
  if (kind === "role") f.config.roles[0]!.role = "administrator";
  if (kind === "duplicate-capability") f.config.roles.push(f.config.roles[0]!);
  if (kind === "duplicate-path") f.config.roles[0]!.materials.push(f.config.roles[0]!.materials[0]!);
  expect(() => createMethodContext(["role", "duplicate-capability", "duplicate-path"].includes(kind) ? f.config : raw)).toThrow("method_context_invalid_config");
});
it.each(["leaf", "parent"])("rejects %s symlinks even when target remains in scope", kind => {
  const f = fixture(); mkdirSync(join(f.root, "folder")); writeFileSync(join(f.root, "folder", "method.md"), f.body);
  if (kind === "leaf") symlinkSync("method.md", join(f.root, "alias.md"));
  else symlinkSync("folder", join(f.root, "alias"));
  f.config.roles[0]!.materials[0]!.path = kind === "leaf" ? "alias.md" : "alias/method.md";
  expect(() => createMethodContext(f.config).load(task, f.scope)).toThrow("method_context_source_symlink");
});
it("rejects invalid UTF8 replacement under the original compiled material pin", () => {
  const f = fixture(); const raw = Buffer.from([0xc3, 0x28]); writeFileSync(join(f.root, "method.md"), raw);
  expect(() => createMethodContext(f.config).load(task, f.scope)).toThrow("method_context_pin_mismatch");
});
it("preserves UTF8 BOM and complete text; receipt counts original bytes", () => {
  const f = fixture(); const raw = Buffer.from("\ufeffFirst\r\n\n最后"); writeFileSync(join(f.root, "method.md"), raw); f.config.roles[0]!.materials[0]!.sha256 = hash(raw);
  const updated = compiledFixture(f.root, raw.toString("utf8")); f.config.compiled = updated.pin; f.config.proposal_digest = updated.compiled.proposal_digest;
  const prepared = createMethodContext(f.config).load(task, f.scope);
  expect(prepared.text).toContain("\ufeffFirst"); expect(prepared.receipt.material_bytes).toBe(raw.length);
  expect(prepared.receipt.framed_bytes).toBe(Buffer.byteLength(prepared.text));
});
it("rejects oversized replacement and multi-file role ambiguity", () => {
  const f = fixture(); writeFileSync(join(f.root, "method.md"), "x".repeat(32769)); f.config.max_bytes = 65536;
  expect(() => createMethodContext(f.config).load(task, f.scope)).toThrow("method_context_budget_exceeded");
  f.config.roles[0]!.materials.push({ path: "extra.md", sha256: hash(f.body) });
  expect(() => createMethodContext(f.config)).toThrow("method_context_invalid_config");
});
it("synchronously rechecks the exact preparation and refuses drift or forged preparation", () => {
  const f = fixture(); const loader = createMethodContext(f.config); const p = loader.load(task, f.scope);
  loader.validateSync(p, f.scope.signal);
  expect(() => loader.validateSync({ ...p }, f.scope.signal)).toThrow("method_context_unrecognized_preparation");
  writeFileSync(join(f.root, "method.md"), "changed");
  expect(() => loader.validateSync(p, f.scope.signal)).toThrow("method_context_pin_mismatch");
});
it("rejects aborted preparation and preinvoke validation", () => {
  const f = fixture(); const loader = createMethodContext(f.config); const p = loader.load(task, f.scope); const c = new AbortController(); c.abort();
  expect(() => loader.load(task, { ...f.scope, signal: c.signal })).toThrow("method_context_aborted");
  expect(() => loader.validateSync(p, c.signal)).toThrow("method_context_aborted");
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

it.each(["missing", "changed", "oversize", "symlink", "invalid-json"])("rejects %s compiled artifacts before method delivery", kind => {
  const f = fixture(); const path = join(f.root, "compiled.json");
  if (kind === "missing") rmSync(path);
  if (kind === "changed") writeFileSync(path, "{}");
  if (kind === "oversize") writeFileSync(path, "x".repeat(524289));
  if (kind === "symlink") { rmSync(path); symlinkSync("method.md", path); }
  if (kind === "invalid-json") { writeFileSync(path, "not JSON"); f.config.compiled.sha256 = hash("not JSON"); }
  const codes = { missing: "source_unavailable", changed: "pin_mismatch", oversize: "budget_exceeded", symlink: "source_symlink", "invalid-json": "compiled_invalid" };
  expect(() => createMethodContext(f.config).load(task, f.scope)).toThrow("method_context_" + codes[kind as keyof typeof codes]);
});
it("accepts coherently recompiled caller facts without calling them authenticated", () => {
  const f = fixture(); const body = "A revised caller-supplied method"; const compilation = compiledFixture(f.root, body);
  writeFileSync(join(f.root, "method.md"), body); f.config.compiled = compilation.pin; f.config.proposal_digest = compilation.compiled.proposal_digest;
  f.config.roles[0]!.materials[0]!.sha256 = hash(body);
  const p = createMethodContext(f.config).load(task, f.scope);
  expect(p.receipt.identity).toBe("caller_declared"); expect(p.receipt.proposal_binding).toBe("recompiled_caller_facts");
});
