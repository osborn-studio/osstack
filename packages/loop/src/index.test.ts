import { describe, expect, it } from "vitest";
import {
  GitDiffScanner,
  Iterator,
  LoopEngine,
  Scheduler,
  createInitialLoopState,
  createScanner,
  executePlan,
  evaluateIteration,
  renderLoopStateMarkdown,
  verifyRun,
} from "./index.js";

describe("loop public exports", () => {
  it("should expose Loop primitives from the package entrypoint", () => {
    expect(Scheduler).toBeTypeOf("function");
    expect(GitDiffScanner).toBeTypeOf("function");
    expect(createScanner).toBeTypeOf("function");
    expect(Iterator).toBeTypeOf("function");
    expect(evaluateIteration).toBeTypeOf("function");
    expect(createInitialLoopState).toBeTypeOf("function");
    expect(renderLoopStateMarkdown).toBeTypeOf("function");
    expect(LoopEngine).toBeTypeOf("function");
    expect(executePlan).toBeTypeOf("function");
    expect(verifyRun).toBeTypeOf("function");
  });
});
