import { afterEach, describe, expect, it } from "vitest";
import { buildAgentChildEnv } from "./child-env.js";

const originalPath = process.env["PATH"];

afterEach(() => {
  delete process.env["OSSTACK_APPROVAL_TOKEN"];
  delete process.env["TELEGRAM_BOT_TOKEN"];
  if (originalPath === undefined) delete process.env["PATH"];
  else process.env["PATH"] = originalPath;
});

describe("buildAgentChildEnv", () => {
  it("inherits runtime essentials but drops arbitrary caller secrets", () => {
    process.env["PATH"] = "/safe/bin";
    process.env["OSSTACK_APPROVAL_TOKEN"] = "approval-secret";
    process.env["TELEGRAM_BOT_TOKEN"] = "notification-secret";

    const env = buildAgentChildEnv();

    expect(env["PATH"]).toBe("/safe/bin");
    expect(env["OSSTACK_APPROVAL_TOKEN"]).toBeUndefined();
    expect(env["TELEGRAM_BOT_TOKEN"]).toBeUndefined();
  });

  it("adds only explicit adapter-scoped overrides", () => {
    const env = buildAgentChildEnv({
      KIMI_CODE_EXPERIMENTAL_FLAG: "1",
      OSSTACK_EVALUATION_SPECS_FILE: "/tmp/specs.json",
    });

    expect(env["KIMI_CODE_EXPERIMENTAL_FLAG"]).toBe("1");
    expect(env["OSSTACK_EVALUATION_SPECS_FILE"]).toBe("/tmp/specs.json");
  });
});
