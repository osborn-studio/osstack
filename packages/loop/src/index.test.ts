import { describe, expect, it } from "vitest";
import { GitDiffScanner, Scheduler, createScanner } from "./index.js";

describe("loop public exports", () => {
  it("should expose the first Loop primitives from the package entrypoint", () => {
    expect(Scheduler).toBeTypeOf("function");
    expect(GitDiffScanner).toBeTypeOf("function");
    expect(createScanner).toBeTypeOf("function");
  });
});
