import { describe, expect, it } from "vitest";
import { parsePublisherAllowlist, parsePublishRequest } from "./config.js";
import { config, request } from "./testkit/fixtures.js";

describe("publisher config", () => {
  const c = config(), b = c.allow[0]!, q = request();
  it("accepts the synthetic binding and leaves the harness payload to the builder", () => {
    expect(parsePublisherAllowlist(c)).toEqual({ ok: true, value: c });
    expect(parsePublishRequest(q)).toEqual({ ok: true, value: q });
    expect(parsePublishRequest({ ...q, record: {} }).ok).toBe(true);
  });
  it.each([
    { ...c, extra: 1 }, { ...c, producer: { ...c.producer, extra: 1 } },
    { ...c, allow: [{ ...b, extra: 1 }] }, { ...c, allow: [{ ...b, trusted_source: { ...b.trusted_source, extra: 1 } }] },
    { ...c, allow: [] }, { ...c, allow: [b, b] }, { ...c, allow: Array.from({ length: 33 }, (_, n) => ({ ...b, skill_id: "skill" + n })) },
    { ...c, producer: { ...c.producer, installation_id: 0 } }, { ...c, producer: { ...c.producer, app_id: 1.5 } },
    ...[{ repository: "bad/name/extra" }, { repository_id: -1 }, { skill_id: "invalid id" }, { skill_blob: "bad" },
      { skill_manifest_digest: "bad" }, { trusted_source: { ...b.trusted_source, commit_sha: "short" } }].map(change => ({ ...c, allow: [{ ...b, ...change }] })),
  ])("rejects invalid allowlist %#", value => { expect(parsePublisherAllowlist(value)).toEqual({ ok: false }); });
  it.each([
    { extra: 1 }, { version: 2 }, { pr: 0 }, { repository_id: 1.5 }, { skill_id: "bad id" }, { head_sha: "a" },
    { base_sha: "B".repeat(40) }, { record: null }, { record: [] }, { record: new Date() }, { record: undefined },
  ])("rejects invalid request %#", change => { expect(parsePublishRequest({ ...q, ...change })).toEqual({ ok: false }); });
});
