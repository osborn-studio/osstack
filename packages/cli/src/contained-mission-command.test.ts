import { describe, expect, it } from "vitest";
import { handleContainedMissionCommand } from "./contained-mission-command.js";

const credential = "k".repeat(40);
const MID = "cm_00000000-0000-4000-8000-000000000000";
function run(args: string[], result: unknown = { ok: true, result: { mission_id: MID } }) {
  const out: string[] = []; const err: string[] = []; const calls: Array<{ method: string; params: unknown }> = []; let reads = 0;
  const promise = handleContainedMissionCommand(args, {
    stdout: l => out.push(l), stderr: l => err.push(l), cwd: "/work",
    readCredential: () => { reads++; return credential; },
    rpc: async (method, params) => { calls.push({ method, params }); return result; },
  });
  return promise.then(code => ({ code, out, err, calls, reads }));
}

describe("osstack mission", () => {
  it("builds a start request with repeated allow and verify arguments", async () => {
    const r = await run(["start", "--scope", "s1", "--repo", "repo", "--base", "main", "--goal", "fix it", "--allow", "src/**", "--allow", "test/**",
      "--verify-arg", "pnpm", "--verify-arg", "--filter", "--verify-arg", "x", "--max-repair", "1", "--json"]);
    expect(r.code).toBe(0);
    expect(r.calls).toEqual([{ method: "mission.start", params: { scope_id: "s1", credential,
      request: { goal: "fix it", repo_path: "/work/repo", base_ref: "main", allowed_paths: ["src/**", "test/**"], verify: { argv: ["pnpm", "--filter", "x"] }, max_repair_cycles: 1 } } }]);
    expect(r.out.join("\n")).not.toContain(credential);
  });

  it("selects the sandbox CI route without accepting a local command", async () => {
    const args = ["start", "--scope", "s1", "--repo", "repo", "--base", "main", "--goal", "sandbox seed", "--allow", "probe/**",
      "--publish-repository", "osborn-studio/osstack-bridge-sandbox", "--github-ci"];
    const accepted = await run(args);
    expect(accepted.code).toBe(0);
    expect(accepted.calls[0]?.params).toMatchObject({ request: { verification_mode: "github_actions", max_repair_cycles: 0, verify: { argv: [] } } });
    const conflict = await run([...args, "--verify-arg", "true"]);
    expect(conflict.reads).toBe(0);
    expect(conflict.err[0]).toContain("conflict:--github-ci");
  });

  it("lists CI chains with scope filtering in text and JSON", async () => {
    const row = { mission_id: MID, scope_id: "s1", repository: "o/r", pr: 7, state: "repair_ci_waiting", since: 1234,
      head_before: "a", head_after: "b", merge_commit_sha: null, stop_reason: null };
    const text = await run(["list", "--github-ci", "--scope", "s1"], { ok: true, result: [row] });
    expect(text.calls).toEqual([{ method: "mission.list", params: { scope_id: "s1", credential } }]);
    expect(text.out).toEqual([`${MID}\ts1\to/r\t7\trepair_ci_waiting\t1234\ta\tb\t-\t-`]);
    const json = await run(["list", "--github-ci", "--json"], { ok: true, result: [row] });
    expect(JSON.parse(json.out[0]!)).toEqual([row]);
    expect((await run(["list"])).err[0]).toContain("required:--github-ci");
  });

  it("shows scan health and repair refusal in text and JSON", async () => {
    const row = { mission_id: MID, scan: { failing: true, reason: "auth", step: "ci_jobs_read", consecutive: 4, since: 1000 },
      repair_refused: { reason: "verify_chain_busy", holder: "review", since: 900 } };
    const text = await run(["list", "--github-ci"], { ok: true, result: [row] });
    expect(text.out[0]).toContain(" scan_failing=auth@ci_jobs_read x4 since=1970-01-01T00:00:01.000Z repair_refused=verify_chain_busy@review");
    const json = await run(["list", "--github-ci", "--json"], { ok: true, result: [row] });
    expect(JSON.parse(json.out[0]!)).toEqual([row]);
  });

  it("validates locally before reading the credential", async () => {
    const r = await run(["decide", "--mission", MID, "--decision", "merge"]);
    expect(r.code).toBe(1); expect(r.reads).toBe(0); expect(r.calls).toEqual([]);
    expect(r.err.join("\n")).toContain("invalid_request");
    const missing = await run(["start", "--scope", "s", "--repo", "r", "--base", "main", "--goal", "g", "--allow", "**"]);
    expect(missing.err.join("\n")).toContain("required:--verify-arg");
  });

  it("passes bounded decision identity and expected revision to mission.decide", async () => {
    const r = await run(["decide", "--mission", MID, "--decision", "abandon", "--decision-id", "operator:42", "--expected-revision", "3", "--json"]);
    expect(r.code).toBe(0);
    expect(r.calls).toEqual([{ method: "mission.decide", params: { credential, mission_id: MID, decision: "abandon", decision_id: "operator:42", expected_revision: 3 } }]);
    for (const bad of ["", "!bad", "x".repeat(129)]) {
      const result = await run(["decide", "--mission", MID, "--decision", "abandon", "--decision-id", bad]);
      expect(result.calls).toEqual([]);
    }
    const stale = await run(["decide", "--mission", MID, "--decision", "abandon", "--expected-revision", "0"]);
    expect(stale.calls).toEqual([]);
  });

  it("rejects unknown commands and flags, and reports daemon errors without the credential", async () => {
    expect((await run(["merge"])).err.join("\n")).toContain("unknown_mission_command");
    expect((await run(["status", "--mission", MID, "--force", "1"])).err.join("\n")).toContain("unknown_flag:--force");
    const failed = await run(["status", "--mission", MID], { ok: false, error: { code: "permission_denied" } });
    expect(failed.code).toBe(1); expect(failed.err.join("\n")).toContain("permission_denied"); expect(failed.err.join("\n")).not.toContain(credential);
  });

  it("sends publish-check as mission.publish_check and rejects unknown flags", async () => {
    const r = await run(["publish-check", "--mission", MID, "--json"]);
    expect(r.code).toBe(0);
    expect(r.calls).toEqual([{ method: "mission.publish_check", params: { mission_id: MID, credential } }]);
    expect((await run(["publish-check", "--mission", MID, "--force", "1"])).err.join("\n")).toContain("unknown_flag:--force");
    const missing = await run(["publish-check"]);
    expect(missing.err.join("\n")).toContain("required:--mission"); expect(missing.reads).toBe(0);
    expect((await run(["publish-check", "--mission", "nope"])).err.join("\n")).toContain("invalid_request");
    const help: string[] = []; await handleContainedMissionCommand(["help"], { stdout: l => help.push(l) });
    expect(help.join("\n")).toContain("publish-check --mission ID");
  });

  it("prints help without a daemon", async () => {
    const r = await handleContainedMissionCommand(["--help"], { stdout: () => {}, stderr: () => {} });
    expect(r).toBe(0);
  });
});

describe("osstack mission start publication grant", () => {
  const base = ["start", "--scope", "s1", "--repo", "/r", "--base", "main", "--goal", "g", "--allow", "**", "--verify-arg", "true"];
  it("adds a bounded, draft-by-default grant", async () => {
    const r = await run([...base, "--publish-repository", "o/r", "--publish-preauthorized"]);
    expect(r.code).toBe(0);
    expect((r.calls[0]!.params as { request: { publication: unknown } }).request.publication).toEqual({ repository: "o/r", remote: "origin", base: "main", draft: true, preauthorized: true });
  });
  it("rejects publication flags without a repository and an invalid draft value", async () => {
    expect((await run([...base, "--publish-preauthorized"])).err.join("\n")).toContain("required:--publish-repository");
    expect((await run([...base, "--publish-repository", "o/r", "--publish-draft", "maybe"])).err.join("\n")).toContain("invalid:--publish-draft");
    expect((await run([...base, "--publish-repository", "not a repo"])).err.join("\n")).toContain("invalid_request");
  });
});

it("requires the exact candidate before reading the credential for local failure approval", async () => {
  const args = ["approve-local-failure-repair", "--mission", MID];
  const candidate = "a".repeat(40);
  const accepted = await run([...args, "--candidate", candidate]);
  expect(accepted.code).toBe(0);
  expect(accepted.calls).toEqual([{ method: "mission.approve_local_failure_repair", params: { credential, mission_id: MID, candidate } }]);
  const missing = await run(args);
  expect(missing).toMatchObject({ code: 1, reads: 0, calls: [] });
  expect(missing.err[0]).toContain("required:--candidate");
});
