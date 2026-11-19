import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { canonicalJson } from "./revision-grant.js";
import { passedVerificationFixture } from "./verification-result-fixtures.js";
import { verificationDedupKey } from "./verification-result.js";
import { classifyRecheck, parseRecheckResult, type HostRecheckProof } from "./recheck.js";
import { issueHostRecheckProof } from "./recheck-host-proof.js";

const v = passedVerificationFixture();
const pinned = {
  ...v,
  pr_number: v.pr,
  new_head_sha: v.head_sha,
  original_result_id: "other",
  trusted_source_digest: createHash("sha256").update(canonicalJson(v.trusted_source)).digest("hex"),
  original_checks: ["fixture-check"],
  failed_check_id: "fixture-check",
};
const fields = { ...pinned, receipt_id: "receipt", receipt_digest: v.profile_digest, outcome: "passed" as const };
const actions = {
  head_sha: v.head_sha,
  attempt: 1,
  complete: true,
  conclusion: "success" as const,
  digest: v.profile_digest,
};
function result(patch: Record<string, unknown> = {}) {
  const wire = { ...v, ...patch };
  return parseRecheckResult(JSON.stringify({ ...wire, dedup_key: verificationDedupKey(wire) }));
}
function classify(patch = {}, facts = actions, host: HostRecheckProof | null = issueHostRecheckProof(fields)) {
  return classifyRecheck(pinned, { result: result(patch), actions: facts, host });
}
it.each([
  { repository_id: 2 },
  { pr: 2 },
  { base_sha: "1".repeat(40) },
  { head_sha: "1".repeat(40) },
  { outcome: "blocked" },
  { outcome: "cancelled" },
])("ignores unrelated or incomplete result %j", (patch) => {
  expect(classify(patch).missing).toEqual(["result"]);
});
it("ignores the original result", () => {
  expect(
    classifyRecheck({ ...pinned, original_result_id: v.result_id }, { result: result(), actions, host: null }).missing
  ).toEqual(["result", "host"]);
});
it.each([
  { skill_version: "2.0.0" },
  { profile_digest: "1".repeat(64) },
  { checks: [] },
  { trusted_source: { ...v.trusted_source, commit_sha: "1".repeat(40) } },
])("binding change precedes failure %j", (patch) => {
  expect(classify({ ...patch, outcome: "failed" }).reason).toBe("verify_recheck_binding_changed");
});
it.each([
  { outcome: "failed" },
  ...[{ exit: null }, { exit: 1 }, { failure_code: "failed" }].map((p) => ({
    checks: [v.checks[0], { ...v.checks[0], check_id: "another", ...p }],
  })),
])("failure precedes missing proof %j", (patch) => {
  expect(classifyRecheck(pinned, { result: result(patch), actions: null, host: null }).reason).toBe(
    "verify_recheck_failed"
  );
});
it("permits a larger passing check set", () => {
  expect(classify({ checks: [...v.checks, { ...v.checks[0], check_id: "extra" }] }).state).toBe("recheck_passed");
});
it.each([
  { complete: false },
  { conclusion: "failure" },
  { attempt: 0 },
  { digest: "invalid" },
  { head_sha: "0".repeat(40) },
])("ignores an incomplete or invalid Actions read %j", (patch) =>
  expect(classify({}, { ...actions, ...patch } as typeof actions).missing).toEqual(["actions"])
);
it("requires issued host proof for the pinned binding", () => {
  // @ts-expect-error Host receipts require issuance.
  const forged: HostRecheckProof = { ...fields };
  expect(classify({}, actions, forged).missing).toEqual(["host"]);
  for (const patch of [
    { head_sha: "1".repeat(40) },
    { base_sha: "1".repeat(40) },
    { profile_digest: "1".repeat(64) },
    { trusted_source_digest: "1".repeat(64) },
    { outcome: "failed" as const },
  ]) {
    expect(classify({}, actions, issueHostRecheckProof({ ...fields, ...patch })).missing).toEqual(["host"]);
  }
});

it("keeps the host proof issuer private in package sources and exports", async () => {
  const { readdirSync, readFileSync, existsSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const packages = fileURLToPath(new URL("../../../", import.meta.url));
  for (const pkg of readdirSync(packages)) {
    const root = join(packages, pkg, "src");
    if (!existsSync(root)) continue;
    for (const file of readdirSync(root, { recursive: true, encoding: "utf8" })) {
      if (!/\.[cm]?[jt]sx?$/.test(file) || /\.test\.[cm]?[jt]sx?$/.test(file)) continue;
      const source = readFileSync(join(root, file), "utf8");
      if (pkg === "core" && file === "bridge/recheck.ts") {
        expect(
          source.replace('import { isHostRecheckProof, type HostRecheckProof } from "./recheck-host-proof.js";', "")
        ).not.toContain("recheck-host-proof");
      } else if (!(pkg === "core" && file === "state/engineering-local-failure-recheck-store.ts")) {
        expect(source, pkg + "/" + file).not.toContain("recheck-host-proof");
      }
    }
  }
  const { createRequire } = await import("node:module");
  const require = createRequire(import.meta.url);
  for (const path of ["src/bridge/recheck-host-proof.ts", "dist/bridge/recheck-host-proof.js"])
    expect(() => require.resolve("@osstack/core/" + path)).toThrow(/not defined by "exports"/);
});

it("requires parsed result data even if all fields match", () => {
  const parsed = result();
  if (!parsed) throw Error("invalid fixture");
  expect(
    classifyRecheck(pinned, { result: { ...parsed }, actions, host: issueHostRecheckProof(fields) }).missing
  ).toEqual(["result"]);
});
it.each([
  { receipt_id: "" },
  { receipt_id: "x".repeat(129) },
  { receipt_id: "a\0b" },
  { receipt_digest: "bad" },
  { profile_digest: "bad" },
  { trusted_source_digest: "bad" },
  { head_sha: "bad" },
  { base_sha: "bad" },
])("rejects invalid host proof fields %j", (patch) =>
  expect(() => issueHostRecheckProof({ ...fields, ...patch })).toThrow()
);
