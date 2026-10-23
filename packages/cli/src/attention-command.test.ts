import { expect, it } from "vitest";
import { handleAttentionCommand } from "./attention-command.js";
it("renders help without opening any database", async () => {
  const output: string[] = [];
  expect(await handleAttentionCommand(["--help"], { stdout: (s) => output.push(s) })).toBe(0);
  expect(output.join()).toContain("No daemon");
});
it.each([["status"], ["status", "--default-tenant", "--default-tenant"], ["status", "--tenant", "other"], ["answer"]])("rejects unsafe/incomplete arguments %j", async (...args) => {
  expect(await handleAttentionCommand(args as string[], { stderr: () => {} })).toBe(1);
});
