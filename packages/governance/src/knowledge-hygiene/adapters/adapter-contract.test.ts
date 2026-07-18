import { describe, expect, it } from "vitest";
import {
  runKnowledgeSurfaceAdapter,
  type KnowledgeSurfaceAdapterV1,
} from "./adapter-contract.js";

function fakeAdapter(options: { detected: boolean }) {
  const calls = { detect: 0, inventory: 0, rules: 0 };
  const adapter: KnowledgeSurfaceAdapterV1 = {
    id: "fake-memory",
    version: "1",
    capabilities: ["read"],
    async detect() {
      calls.detect += 1;
      return {
        adapter_id: "fake-memory",
        adapter_version: "1",
        status: options.detected ? "available" : "absent",
        evidence_source: {
          kind: "official_documentation",
          ref: "https://example.test/fake-memory",
        },
        ...(options.detected ? { root: "/fixture/memory" } : {}),
      };
    },
    async inventory() {
      calls.inventory += 1;
      return {
        surfaces: [],
        completeness: { complete: true, skipped_files: 0, reasons: [] },
      };
    },
    rules() {
      calls.rules += 1;
      return [];
    },
  };
  return { adapter, calls };
}

describe("knowledge surface adapter contract", () => {
  it("does not call any adapter method without explicit enablement", async () => {
    const fake = fakeAdapter({ detected: true });

    await expect(runKnowledgeSurfaceAdapter(fake.adapter, {
      repo_root: "/fixture/repo",
      enabled: false,
      options: {},
    })).resolves.toEqual({
      adapter_id: "fake-memory",
      adapter_version: "1",
      status: "disabled",
    });
    expect(fake.calls).toEqual({ detect: 0, inventory: 0, rules: 0 });
  });

  it("treats an absent enabled platform as a clean skip", async () => {
    const fake = fakeAdapter({ detected: false });

    const result = await runKnowledgeSurfaceAdapter(fake.adapter, {
      repo_root: "/fixture/repo",
      enabled: true,
      options: {},
    });

    expect(result.status).toBe("absent");
    expect(fake.calls).toEqual({ detect: 1, inventory: 0, rules: 0 });
  });

  it("returns only read capability, versioned inventory, rules, and evidence", async () => {
    const fake = fakeAdapter({ detected: true });

    const result = await runKnowledgeSurfaceAdapter(fake.adapter, {
      repo_root: "/fixture/repo",
      enabled: true,
      options: { memory_directory: "/fixture/memory" },
    });

    expect(fake.adapter.capabilities).toEqual(["read"]);
    expect(result).toMatchObject({
      adapter_id: "fake-memory",
      adapter_version: "1",
      status: "available",
      detection: {
        evidence_source: {
          kind: "official_documentation",
          ref: "https://example.test/fake-memory",
        },
      },
      inventory: {
        completeness: { complete: true },
      },
      rules: [],
    });
    expect(fake.calls).toEqual({ detect: 1, inventory: 1, rules: 1 });
  });

  it("rejects adapter identity drift at the boundary", async () => {
    const fake = fakeAdapter({ detected: true });
    fake.adapter.detect = async () => ({
      adapter_id: "different-adapter",
      adapter_version: "1",
      status: "available",
      root: "/fixture/memory",
      evidence_source: {
        kind: "official_documentation",
        ref: "https://example.test/fake-memory",
      },
    });

    await expect(runKnowledgeSurfaceAdapter(fake.adapter, {
      repo_root: "/fixture/repo",
      enabled: true,
      options: {},
    })).rejects.toThrow(/identity mismatch/);
  });
});
