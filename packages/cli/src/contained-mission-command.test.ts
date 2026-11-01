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

  it("validates locally before reading the credential", async () => {
    const r = await run(["decide", "--mission", MID, "--decision", "merge"]);
    expect(r.code).toBe(1); expect(r.reads).toBe(0); expect(r.calls).toEqual([]);
    expect(r.err.join("\n")).toContain("invalid_request");
    const missing = await run(["start", "--scope", "s", "--repo", "r", "--base", "main", "--goal", "g", "--allow", "**"]);
    expect(missing.err.join("\n")).toContain("required:--verify-arg");
  });

  it("rejects unknown commands and flags, and reports daemon errors without the credential", async () => {
    expect((await run(["merge"])).err.join("\n")).toContain("unknown_mission_command");
    expect((await run(["status", "--mission", MID, "--force", "1"])).err.join("\n")).toContain("unknown_flag:--force");
    const failed = await run(["status", "--mission", MID], { ok: false, error: { code: "permission_denied" } });
    expect(failed.code).toBe(1); expect(failed.err.join("\n")).toContain("permission_denied"); expect(failed.err.join("\n")).not.toContain(credential);
  });

  it("prints help without a daemon", async () => {
    const r = await handleContainedMissionCommand(["--help"], { stdout: () => {}, stderr: () => {} });
    expect(r).toBe(0);
  });
});
