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
  const config = { schema_version: 1, task_id: "task", package_version: "0.15.36", proposal_digest: "a".repeat(64), max_bytes: 4096,
    roles: [{ role: "builder", capability_id: "code.write", materials: [{ path: "method.md", sha256: hash(body) }] }] };
  return { root, body, config, scope: { workspacePath: root, signal: new AbortController().signal } };
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
it("rejects invalid UTF8 rather than substituting bytes", () => {
  const f = fixture(); const raw = Buffer.from([0xc3, 0x28]); writeFileSync(join(f.root, "method.md"), raw); f.config.roles[0]!.materials[0]!.sha256 = hash(raw);
  expect(() => createMethodContext(f.config).load(task, f.scope)).toThrow("method_context_invalid_utf8");
});
it("preserves UTF8 BOM and complete text; receipt counts original bytes", () => {
  const f = fixture(); const raw = Buffer.from("\ufeffFirst\r\n\n最后"); writeFileSync(join(f.root, "method.md"), raw); f.config.roles[0]!.materials[0]!.sha256 = hash(raw);
  const prepared = createMethodContext(f.config).load(task, f.scope);
  expect(prepared.text).toContain("\ufeffFirst"); expect(prepared.receipt.material_bytes).toBe(raw.length);
  expect(prepared.receipt.framed_bytes).toBe(Buffer.byteLength(prepared.text));
});
it("rejects per-file and aggregate overflow without truncation", () => {
  const f = fixture(); const raw = "x".repeat(32769); writeFileSync(join(f.root, "method.md"), raw); f.config.max_bytes = 65536; f.config.roles[0]!.materials[0]!.sha256 = hash(raw);
  expect(() => createMethodContext(f.config).load(task, f.scope)).toThrow("method_context_budget_exceeded");
  writeFileSync(join(f.root, "method.md"), f.body); writeFileSync(join(f.root, "extra.md"), f.body);
  f.config.roles[0]!.materials = [{ path: "method.md", sha256: hash(f.body) }, { path: "extra.md", sha256: hash(f.body) }]; f.config.max_bytes = Buffer.byteLength(f.body);
  expect(() => createMethodContext(f.config).load(task, f.scope)).toThrow("method_context_budget_exceeded");
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
