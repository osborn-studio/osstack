import { describe, expect, it } from "vitest";
import { PLUGINS_VERSION } from "./index.js";

describe("@osstack/plugins public contract", () => {
  it("exports an explicit placeholder API version until plugin slots land", () => {
    expect(PLUGINS_VERSION).toBe("0.0.0");
  });
});
