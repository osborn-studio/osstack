import { expect, it } from "vitest";
import { parseHarnessConfig } from "./config.js";
import { config, entry } from "./testkit/fixtures.js";

it("parses the pinned configuration", () => {
  expect(parseHarnessConfig(config)).toEqual({ ok: true, value: config });
});
it.each([
  { ...config, extra: 1 },
  { ...config, docker: { ...config.docker, extra: 1 } },
  { ...config, entries: [{ ...entry, extra: 1 }] },
  { ...config, entries: [{ ...entry, trusted_source: { ...entry.trusted_source, extra: 1 } }] },
  { ...config, entries: [entry, { ...entry, skill_id: "other" }] },
  { ...config, entries: [] },
  { ...config, docker: { ...config.docker, socket_path: "relative" } },
  { ...config, profiles_root: "relative" },
  { ...config, profiles_root: "/bad\0path" },
  ...[{ base_image_id: entry.profile_digest }, { profile_digest: "X".repeat(64) },
    { trusted_source: { ...entry.trusted_source, artifact_digest: "bad" } }, { failure_code: "Bad.Code" },
    { allowed_argv: ["one"] }, { allowed_argv: Array(129).fill("x") }, { allowed_argv: ["a", "x\u0085"] },
    { allowed_argv: ["a", "é".repeat(2049)] }].map(change => ({ ...config, entries: [{ ...entry, ...change }] })),
])("refuses invalid configuration %#", value => {
  expect(parseHarnessConfig(value)).toEqual({ ok: false });
});
