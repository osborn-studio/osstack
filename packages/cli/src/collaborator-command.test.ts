import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { verifyContinuationGrant } from "@osstack/autonomy";
import { handleCollaboratorCommand } from "./collaborator-command.js";
import { readContinuationTrust } from "./session-collaborator.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
async function directory() { const path = await mkdtemp(join(tmpdir(), "osstack-grant-cli-")); directories.push(path); return path; }

describe("collaborator CLI", () => {
  it("drafts a bound plan, signs externally, and installs only the signed envelope", async () => {
    const root = await directory();
    const owner = generateKeyPairSync("ed25519");
    const key = join(root, "owner.pem");
    const steps = join(root, "steps.json");
    const bodyPath = join(root, "body.json");
    const signedPath = join(root, "signed.json");
    await writeFile(key, owner.privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
    await writeFile(steps, JSON.stringify([{ phase: "plan", instruction: "review", checks: [{ kind: "text_equals", expected: "ready" }] }]));
    const rpc = vi.fn(async () => ({ ok: true, result: { session_id: "session", runtime_id: "claude-controlled-session", repo_path: root, turn_id: "turn", version: 4, runtime_policy: { fingerprint: "a".repeat(64) } } }));
    const deps = { rpc, stdout: vi.fn(), stderr: vi.fn() };
    expect(await handleCollaboratorCommand(["draft", "session", "--steps", steps, "--out", bodyPath], deps)).toBe(0);
    expect(await handleCollaboratorCommand(["sign", "--file", bodyPath, "--key-id", "owner", "--private-key", key, "--out", signedPath], deps)).toBe(0);
    const signed: unknown = JSON.parse(await readFile(signedPath, "utf8"));
    const verified = verifyContinuationGrant(signed, { trusted_public_keys: new Map([["owner", owner.publicKey.export({ type: "spki", format: "pem" }).toString()]]), now: () => new Date().toISOString() });
    expect(verified.body).toMatchObject({ initial_turn_id: "turn", initial_version: 4, max_resumes: 1, max_checks: 1 });
    expect(await handleCollaboratorCommand(["install", "--file", signedPath], deps)).toBe(0);
    expect(rpc).toHaveBeenLastCalledWith("collaborator.install", signed, 10_000);
    expect(JSON.stringify(rpc.mock.calls)).not.toContain("PRIVATE KEY");
    expect(await handleCollaboratorCommand(["draft", "session", "--steps", steps, "--out", bodyPath], deps)).toBe(1);
  });
  it("rejects unknown or repeated flags without a mutating RPC", async () => {
    const deps = { rpc: vi.fn(), stdout: vi.fn(), stderr: vi.fn() };
    for (const args of [["install", "--yes"], ["revoke"], ["status", "g", "--private-key", "k"], ["install", "--file", "a", "--file", "b"]]) {
      expect(await handleCollaboratorCommand(args, deps)).toBe(1);
    }
    expect(deps.rpc).not.toHaveBeenCalled();
  });
  it("defaults to no trusted issuers and rejects duplicate trust keys", async () => {
    const path = join(await directory(), "trust.json");
    expect((await readContinuationTrust(path)).size).toBe(0);
    const pair = generateKeyPairSync("ed25519");
    const publicPem = pair.publicKey.export({ type: "spki", format: "pem" }).toString();
    await writeFile(path, JSON.stringify({ schema_version: 1, keys: [{ key_id: "a", public_key_pem: publicPem }, { key_id: "a", public_key_pem: publicPem }] }));
    await expect(readContinuationTrust(path)).rejects.toThrow("duplicate");
    await writeFile(path, JSON.stringify({ schema_version: 1, keys: [], private_key: "forbidden" }));
    await expect(readContinuationTrust(path)).rejects.toThrow();
    const privatePem = pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    for (const pem of [privatePem, publicPem + privatePem, publicPem + publicPem]) {
      await writeFile(path, JSON.stringify({ schema_version: 1, keys: [{ key_id: "a", public_key_pem: pem }] }));
      await expect(readContinuationTrust(path)).rejects.toThrow("PUBLIC KEY");
    }
  });
});
