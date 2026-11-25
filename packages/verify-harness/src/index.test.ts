import { expect, it } from "vitest";
import * as harness from "./index.js";

it("exports the core operations", () => {
  expect(Object.keys(harness).sort()).toEqual(["acceptRun", "buildRecord", "parseHarnessConfig", "readPullRequest",
    "runHarness", "writeEvidence", "writeRequestFile"]);
});
