import { describe, expect, it } from "vitest";
import { PublishedAssetEvidence } from "./types.js";

describe("PublishedAssetEvidence state-recovery invariants", () => {
  it("rejects release identity on a NON-published (blocked/error) record", () => {
    expect(() => PublishedAssetEvidence.parse({ status: "blocked", asset_id: "research.alpha", gate: "team", release_id: "organization__osborn/research.alpha@0.1.0", reasons: [] })).toThrow();
    expect(() => PublishedAssetEvidence.parse({ status: "error", asset_id: "research.alpha", gate: "team", digest: `sha256:${"a".repeat(64)}`, reasons: [] })).toThrow();
  });
  it("rejects an unsafe (dist/packages or spaced) storage_key", () => {
    expect(() => PublishedAssetEvidence.parse({ status: "published", asset_id: "a.b", gate: "team", storage_key: "dist/packages/x/a/1.0.0", reasons: [] })).toThrow();
    expect(() => PublishedAssetEvidence.parse({ status: "published", asset_id: "a.b", gate: "team", storage_key: "safe/has space/x", reasons: [] })).toThrow();
  });
  it("accepts a valid published record with a logical locator", () => {
    expect(() => PublishedAssetEvidence.parse({ status: "published", asset_id: "research.alpha", gate: "team", release_id: "organization__osborn/research.alpha@0.1.0", digest: `sha256:${"a".repeat(64)}`, namespace: "organization/osborn", storage_key: "organization__osborn/research.alpha/0.1.0", reasons: [] })).not.toThrow();
  });
});
