import { expect, it } from "vitest";
import { handleAttentionCommand } from "./attention-command.js";
it("renders help without opening any database", async () => {
  const output: string[] = [];
  expect(
    await handleAttentionCommand(["--help"], { stdout: (s) => output.push(s) })
  ).toBe(0);
  expect(output.join()).toContain("No daemon");
});
it.each([
  ["status"],
  ["status", "--default-tenant", "--default-tenant"],
  ["status", "--tenant", "other"],
  ["answer"],
])("rejects unsafe/incomplete arguments %j", async (...args) => {
  expect(
    await handleAttentionCommand(args as string[], { stderr: () => {} })
  ).toBe(1);
});

it("routes explicit observation release with the inventory version", async () => {
  const calls: unknown[] = [];
  expect(
    await handleAttentionCommand(
      [
        "release",
        "--scope",
        "scope",
        "--kind",
        "session",
        "--subject",
        "session",
        "--expected-version",
        "7",
        "--json",
      ],
      {
        stdout: () => {},
        rpc: async (method, params) => {
          calls.push([method, params]);
          return { ok: true, result: { released: true } };
        },
      }
    )
  ).toBe(0);
  expect(calls).toEqual([
    [
      "attention.release",
      {
        scope_id: "scope",
        kind: "session",
        subject_id: "session",
        expected_version: 7,
      },
    ],
  ]);
});

it("escapes terminal format controls without changing JSON diagnostic identity",async()=>{
  const output:string[]=[];const unsafe="source"+String.fromCharCode(0x202e,0x009b)+"id";
  expect(await handleAttentionCommand(["recovery","--scope","scope","--json"],{stdout:text=>output.push(text),rpc:async()=>({ok:true,result:{subject_id:unsafe,canAutoRetry:false}})})).toBe(0);
  expect(output[0]).not.toContain(String.fromCharCode(0x202e));expect(output[0]).not.toContain(String.fromCharCode(0x009b));expect(JSON.parse(output[0]!).subject_id).toBe(unsafe);
});
