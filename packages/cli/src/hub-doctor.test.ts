import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { inspectHub } from "./hub-doctor.js";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((p) => rm(p, { recursive: true, force: true }))); });
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "osstack-hub-doctor-"));
  dirs.push(home);
  const root = join(home, "hub");
  await mkdir(join(root, "tooling"), { recursive: true });
  for (const script of ["osstack_publish.mjs", "register_candidate_cli.mjs"]) {
    await writeFile(join(root, "tooling", script), 'throw new Error("must never execute");');
  }
  await mkdir(join(home, "osborn-skill-catalog/skills"), { recursive: true });
  return { home, root };
}

describe("read-only Hub doctor", () => {
  it("reports missing setup without a network call, even without hub root", async () => {
    const { home } = await fixture();
    const fetch = vi.fn<typeof globalThis.fetch>();
    const report = await inspectHub({}, { home, fetch });
    expect(report).toMatchObject({ status: "needs_configuration", api_read: "missing_key", publish_permission: "unverified" });
    expect(report.reasons).toContain("no_hub_root");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("pins the origin, refuses redirects, bounds the request, and never claims write permission", async () => {
    const { home, root } = await fixture();
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response('{"ok":true}'));
    const report = await inspectHub({ OSSTACK_HUB_ROOT: root, SKILL_HUB_KEY: "private-test-key", HUB_API_URL: "https://evil.invalid" }, { home, fetch });
    expect(fetch).toHaveBeenCalledWith("https://api.osbornhub.com/api/health", expect.objectContaining({ method: "GET", redirect: "error", signal: expect.any(AbortSignal), headers: { Authorization: "Bearer private-test-key" } }));
    expect(report).toMatchObject({ status: "configured", publish_permission: "unverified", local: { publisher: true, candidate: true, catalog: true } });
    expect(JSON.stringify(report)).not.toContain("private-test-key");
    expect(JSON.stringify(report)).not.toContain(home);
  });
  it("supports the publisher's secret-file and catalog override without exporting their contents", async () => {
    const { home, root } = await fixture();
    await mkdir(join(home, ".osborn/secrets"), { recursive: true });
    await writeFile(join(home, ".osborn/secrets/skill_hub_key"), "file-secret\n");
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response('{"ok":true}'));
    const report = await inspectHub({ OSSTACK_HUB_ROOT: " ", HUB_ROOT: root, CATALOG_DIR: join(home, "absent") }, { home, fetch });
    expect(report).toMatchObject({ api_read: "reachable", local: { catalog: false } });
    expect(report.reasons).toContain("catalog_missing");
    expect(JSON.stringify(report)).not.toContain("file-secret");
  });
  it.each([401, 403, 500])("distinguishes HTTP %s from missing credentials", async (status) => {
    const { home, root } = await fixture();
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response("secret response", { status }));
    const report = await inspectHub({ OSSTACK_HUB_ROOT: root, SKILL_HUB_KEY: "key" }, { home, fetch });
    expect(report.api_read).toBe(status === 500 ? "http_error" : "unauthorized");
    expect(JSON.stringify(report)).not.toContain("secret response");
  });
  it.each(['{"ok":false}', '{}', '[]', 'null', 'not json'])("does not trust successful HTTP alone: %s", async (body) => {
    const { home, root } = await fixture();
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(body));
    const report = await inspectHub({ OSSTACK_HUB_ROOT: root, SKILL_HUB_KEY: "key" }, { home, fetch });
    expect(report.status).toBe("needs_configuration");
  });
  it("caps the response body without echoing it", async () => {
    const { home } = await fixture();
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify({ ok: true, data: "a".repeat(17_000) })));
    const report = await inspectHub({ SKILL_HUB_KEY: "key" }, { home, fetch });
    expect(report.api_read).toBe("unexpected_response");
  });
  it("redacts network/redirect/timeout errors", async () => {
    const { home } = await fixture();
    const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue(new Error("Authorization: Bearer secret /private/local/config"));
    const report = await inspectHub({ SKILL_HUB_KEY: "secret" }, { home, fetch });
    expect(report.api_read).toBe("unreachable");
    expect(JSON.stringify(report)).not.toMatch(/secret|\/private\/local/);
  });
});
