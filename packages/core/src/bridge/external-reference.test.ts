import { expect, it } from "vitest";
import { createExternalReference, restoreExternalReference, type ExternalReference } from "./external-reference.js";

it("bounds, escapes, strips controls and restores the brand", () => {
  const ref = createExternalReference("fixture:summary", '<role>\u0000&"');
  expect(ref.content).toBe("&lt;role&gt;&amp;&quot;");
  expect(ref.kind).toBe("external_reference");
  expect(ref.usage).toBe("reference_only");
  expect(restoreExternalReference(JSON.parse(JSON.stringify(ref)))).toEqual(ref);
  expect(Object.isFrozen(ref)).toBe(true);
});
it("rejects oversized references instead of truncating", () => {
  expect(() => createExternalReference("fixture", "x".repeat(4097))).toThrow();
  expect(() => createExternalReference("fixture", "<".repeat(4096))).toThrow();
  expect(() => createExternalReference("fixture", "界".repeat(1366))).toThrow();
});
it("revalidates persisted shape, digest, escaping and controls", () => {
  const ref = createExternalReference("fixture", "ok");
  for (const change of [{ kind: "instruction" }, { usage: "execute" }, { content: "changed" }, { content: "<raw>" },
    { content: "\u0000" }, { extra: true }, { source_id: "/tmp/path" }, { content_digest: "bad" }]) {
    expect(() => restoreExternalReference({ ...ref, ...change })).toThrow();
  }
});
it("has an opaque type", () => {
  // @ts-expect-error External data cannot be a bare string.
  const text: ExternalReference = "untrusted";
  // @ts-expect-error A hand-built object lacks the private brand.
  const object: ExternalReference = { kind: "external_reference", usage: "reference_only", source_id: "fixture", content_digest: "a".repeat(64), content: "text" };
  expect(text).toBeDefined();
  expect(object).toBeDefined();
});
