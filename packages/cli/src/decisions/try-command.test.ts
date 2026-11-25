import { expect, it, vi } from "vitest";
import { handleDecisionsCommand } from "./command.js";

const id = "a".repeat(32);
const base = { probe_id: id, revision: 1, state: "pending", created_at: 0, expires_at: 3600000, answer: null, continued_at: null };
function fixture(status = "pending") {
  let now = 0;
  const sleep = vi.fn(async (ms: number) => { now += ms; });
  const stdout = vi.fn<(text: string) => void>();
  const stderr = vi.fn();
  const rpc = vi.fn(async (method: string, _params: unknown) => {
    const state = method === "decisions.try_status" ? status : method === "decisions.try_continue" ? "continued" : "pending";
    return { ok: true, result: { ...base, state, answer: ["answered","continued"].includes(state) ? "blue" : null,
      continued_at: state === "continued" ? now : null, ...(method === "decisions.try_create" ? { created: true } : {}) } };
  });
  const run = (...args: string[]) => handleDecisionsCommand(["try", ...args], { now: () => now, sleep, stdout, stderr, rpc, credential: () => "c".repeat(32) });
  return { run, rpc, sleep, stdout, stderr };
}
it.each(["answered", "continued"])("waits for %s and prints the selected colour", async state => {
  const f = fixture(state);
  expect(await f.run("--wait", "4")).toBe(0);
  expect(f.sleep).toHaveBeenCalledWith(2000);
  expect(f.stdout.mock.calls.flat().join("\n")).toContain(`osstack decisions answer --source probe --id ${id} --answer <red|green|blue> --answer-id try:${id} --source-revision 1`);
  expect(f.stdout).toHaveBeenLastCalledWith("continued: you picked blue");
  expect(f.rpc.mock.calls.map(([m]) => m).includes("decisions.try_continue")).toBe(state === "answered");
});
it.each(["pending", "expired"])("reports timeout or expiry for %s", async state => {
  const f = fixture(state);
  expect(await f.run("--wait", "3")).toBe(1);
  expect(f.stdout.mock.calls.at(-1)?.[0]).toMatch(state === "expired" ? /expired/ : /timed out/);
});
it.each([["--wait","0"],["--wait","3601"],["--wait","1.5"],["status"],["continue",id,"--wait","1"],["--json","--json"]])("rejects invalid arguments %s", async (...args) => {
  const f = fixture();
  expect(await f.run(...args)).toBe(1);
  expect(f.rpc).not.toHaveBeenCalled();
});
it.each(["create", "status"])("prints the %s expiry in UTC", async action => {
  const f = fixture();
  expect(await f.run(...(action === "create" ? [] : ["status", id]))).toBe(0);
  expect(f.stdout.mock.calls[0]![0]).toContain("expires_at: 1970-01-01T01:00:00.000Z");
});
it.each(["status","continue","create"])("prints %s as JSON", async action => {
  const f = fixture();
  expect(await f.run(...(action === "create" ? [] : [action, id]), "--json")).toBe(0);
  expect(f.rpc.mock.calls[0]).toEqual([`decisions.try_${action}`, { credential: "c".repeat(32), ...(action === "create" ? {} : { probe_id: id }) }]);
  expect(JSON.parse(f.stdout.mock.calls[0]![0]).expires_at).toBe(base.expires_at);
  expect(JSON.parse(f.stdout.mock.calls[0]![0])).toMatchObject({ probe_id: id, state: action === "continue" ? "continued" : "pending" });
});

it.each(["answered","pending","expired"])("prints the initial and final JSON records when waiting on %s", async state => {
  const f = fixture(state);
  expect(await f.run("--wait", "3", "--json")).toBe(state === "answered" ? 0 : 1);
  const records = f.stdout.mock.calls.map(([line]) => JSON.parse(line));
  expect(records).toHaveLength(2);
  expect(records[0]).toMatchObject({ created: true, probe_id: id, answer_command: expect.stringContaining(id) });
  expect(records[1]).toMatchObject(state === "answered" ? { state: "continued", answer: "blue" }
    : state === "pending" ? { state: "pending", reason: "timeout" } : { state: "expired" });
});
