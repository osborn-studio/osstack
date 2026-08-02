import assert from "node:assert/strict";
import test from "node:test";
import { fixture } from "../src/index.js";

test("loads the R3 fixture", () => {
  assert.equal(fixture, "r3-auth");
});
