import { describe, expect, it } from "vitest";
import { evaluateNeatPatchPolicy } from "./neat-patch-policy.js";

describe("neat patch policy", () => {
  it.each([
    [undefined, "policy profile is required"],
    [{ schema_version: 1, mode: "observe" }, "mode observe"],
    [{ schema_version: 1, mode: "propose" }, "mode propose"],
    [{ schema_version: 1, mode: "execute" }, "auto_apply"],
    [{
      schema_version: 1,
      mode: "execute",
      auto_apply: true,
      requires_approval: ["docs"],
    }, "require recorded approval"],
    [{
      schema_version: 1,
      mode: "execute",
      auto_apply: true,
      forbidden: ["docs"],
    }, "forbids docs"],
    [{
      schema_version: 1,
      mode: "execute",
      auto_apply: true,
      allowed_auto_changes: ["tests"],
    }, "does not allow docs"],
    [{ schema_version: 1, mode: "execute", bogus: true }, "invalid policy profile"],
  ])("refuses unsafe profile %#", (profile, reason) => {
    expect(evaluateNeatPatchPolicy(profile)).toEqual({
      allow: false,
      reason: expect.stringContaining(reason),
    });
  });

  it("allows only execute + auto_apply + docs allowlist", () => {
    expect(evaluateNeatPatchPolicy({
      schema_version: 1,
      mode: "execute",
      auto_apply: true,
      allowed_auto_changes: ["docs"],
    })).toEqual({ allow: true });
  });
});
