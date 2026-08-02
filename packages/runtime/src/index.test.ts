import { describe, expect, it } from "vitest";
import { RUNTIME_VERSION } from "./index.js";

describe("@osstack/runtime public contract", () => {
  it("exports an explicit placeholder API version until the launcher lands", () => {
    expect(RUNTIME_VERSION).toBe("0.0.0");
  });
});
