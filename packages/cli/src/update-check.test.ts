import { describe, expect, it } from "vitest";
import {
  renderUpdateCheckStatus,
  isUpdateCacheFresh,
  UPDATE_CHECK_INTERVAL_MS,
  type UpdateCheckCache,
} from "./update-check.js";

const nowSeconds = 2_000_000;

function cache(overrides: Partial<UpdateCheckCache> = {}): UpdateCheckCache {
  return {
    checked_at: nowSeconds - 60,
    current: "0.14.0",
    latest: "0.15.0",
    update_available: true,
    ...overrides,
  };
}

describe("isUpdateCacheFresh", () => {
  it("accepts a recent cache produced by the running CLI version", () => {
    expect(isUpdateCacheFresh(cache(), nowSeconds, "0.14.0")).toBe(true);
  });

  it("rejects a recent cache produced by a different CLI version", () => {
    expect(
      isUpdateCacheFresh(cache({ current: "0.12.0" }), nowSeconds, "0.14.0"),
    ).toBe(false);
  });

  it("rejects a cache older than the registry-check interval", () => {
    expect(
      isUpdateCacheFresh(
        cache({ checked_at: nowSeconds - UPDATE_CHECK_INTERVAL_MS / 1000 }),
        nowSeconds,
        "0.14.0",
      ),
    ).toBe(false);
  });

  it("rejects a missing cache", () => {
    expect(isUpdateCacheFresh(null, nowSeconds, "0.14.0")).toBe(false);
  });
});

describe("renderUpdateCheckStatus", () => {
  it("does not report a cache from another CLI version as up to date", () => {
    expect(
      renderUpdateCheckStatus(cache({ current: "0.12.0" }), "0.14.0"),
    ).toBe("registry latest:  unknown (version cache refresh pending)");
  });

  it("reports a newer registry version from a matching cache", () => {
    expect(renderUpdateCheckStatus(cache(), "0.14.0")).toBe(
      "update available: 0.15.0 (run: osstack upgrade)",
    );
  });

  it("reports a matching registry version as current", () => {
    expect(
      renderUpdateCheckStatus(
        cache({ latest: "0.14.0", update_available: false }),
        "0.14.0",
      ),
    ).toBe("registry latest:  0.14.0 (up to date)");
  });
});
