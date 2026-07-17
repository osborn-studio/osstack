import { describe, expect, it } from "vitest";
import {
  assertKnowledgeHygienePathPatternV1,
  matchesKnowledgeHygienePathPatternV1,
} from "./path-pattern.js";

describe("knowledge hygiene path pattern v1", () => {
  it.each([
    ["README.md", "README.md", true],
    ["README.md", "docs/README.md", false],
    ["README*.md", "README.zh.md", true],
    ["docs/*.md", "docs/guide.md", true],
    ["docs/*.md", "docs/guides/start.md", false],
    ["docs/**", "docs", true],
    ["docs/**", "docs/guides/start.md", true],
    ["**/README.md", "README.md", true],
    ["**/README.md", "packages/cli/README.md", true],
    ["packages/**/src/*.ts", "packages/cli/src/bin.ts", true],
    ["packages/**/src/*.ts", "packages/cli/test/bin.ts", false],
  ])("matches %s against %s => %s", (pattern, path, expected) => {
    expect(matchesKnowledgeHygienePathPatternV1(pattern, path)).toBe(expected);
  });

  it("normalizes candidate separators without accepting backslashes in config", () => {
    expect(matchesKnowledgeHygienePathPatternV1("docs/**", "docs\\guide.md"))
      .toBe(true);
    expect(() => assertKnowledgeHygienePathPatternV1("docs\\**"))
      .toThrow();
  });

  it.each([
    "/absolute.md",
    "../outside.md",
    "./docs/**",
    "docs//**",
    "docs/{one,two}.md",
    "docs/[ab].md",
    "docs/?.md",
    "docs/@(one|two).md",
    "!docs/**",
    "docs/**.md",
    "docs/***",
  ])("rejects unsupported pattern %s", (pattern) => {
    expect(() => assertKnowledgeHygienePathPatternV1(pattern)).toThrow();
  });
});
