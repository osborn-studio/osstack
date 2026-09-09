import { readFile } from "node:fs/promises";
import { createPublicKey } from "node:crypto";
import { z } from "zod";
import { isControlledSessionAdapter, type AgentAdapter } from "@osstack/agents";
import { verifyContinuationGrant } from "@osstack/autonomy";
import type { SessionContinuationRepository } from "@osstack/core";
import { checkContinuationOutput } from "./continuation-output-checks.js";

type Reservation = Extract<ReturnType<SessionContinuationRepository["finishCheck"]>, { outcome: "reserved" }>;
interface CollaboratorPorts {
  repository: SessionContinuationRepository;
  adapters: ReadonlyMap<string, AgentAdapter>;
  trustedPublicKeys: ReadonlyMap<string, string>;
  draining: () => boolean;
  /** Must atomically commit the receipt/new turn and repository.completeAttempt. */
  send: (reservation: Reservation, controller: AbortController) => Promise<{ ok: boolean; error?: { code: string } }>;
}

const TrustStore = z.object({
  schema_version: z.literal(1),
  keys: z.array(z.object({ key_id: z.string().min(1).max(256), public_key_pem: z.string().min(1).max(8192) }).strict()).max(32),
}).strict();

export async function readContinuationTrust(path: string): Promise<ReadonlyMap<string, string>> {
  let text: string;
  try { text = await readFile(path, "utf8"); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Map();
    throw error;
  }
  if (text.length > 300_000) throw new Error("continuation trust store is too large");
  const parsed = TrustStore.parse(JSON.parse(text));
  for (const key of parsed.keys) {
    // createPublicKey alone also accepts PRIVATE KEY PEM and derives a public
    // key. Refuse that accidental secret import before building daemon state.
    if (!/^\s*-----BEGIN PUBLIC KEY-----[A-Za-z0-9+/=\r\n\t ]+-----END PUBLIC KEY-----\s*$/.test(key.public_key_pem)
      || createPublicKey(key.public_key_pem).asymmetricKeyType !== "ed25519") {
      throw new Error("continuation trust entries must contain only Ed25519 PUBLIC KEY PEM");
    }
  }
  const keys = new Map(parsed.keys.map((key) => [key.key_id, key.public_key_pem]));
  if (keys.size !== parsed.keys.length) throw new Error("duplicate continuation trust key_id");
  return keys;
}

/** Finite, signed phase continuation. All durable decisions live in the repository. */
export class SessionCollaborator {
  private readonly running = new Map<string, { controller: AbortController; done: Promise<void> }>();
  private stopped = false;
  constructor(private readonly ports: CollaboratorPorts) {}

  async policy(runtimeId: string) {
    const adapter = this.ports.adapters.get(runtimeId);
    if (!isControlledSessionAdapter(adapter)) throw new Error("controlled_runtime_required");
    return await adapter.continuationPolicy();
  }

  async install(signed: unknown) {
    if (this.stopped || this.ports.draining()) throw new Error("daemon_draining");
    const verified = verifyContinuationGrant(signed, {
      trusted_public_keys: this.ports.trustedPublicKeys, now: () => new Date().toISOString(),
    });
    const policy = await this.policy(verified.body.runtime_id);
    if (policy.fingerprint !== verified.body.runtime_policy_sha256) throw new Error("runtime_policy_mismatch");
    // No await between the final clock check, repository CAS, and scheduling.
    verifyContinuationGrant(signed, { trusted_public_keys: this.ports.trustedPublicKeys, now: () => new Date().toISOString() });
    if (this.stopped || this.ports.draining()) throw new Error("daemon_draining");
    const grant = this.ports.repository.install(verified.body, verified.digest, verified.key_id, Date.now() / 1000, verified.signature);
    if (grant.status === "active") this.schedule(grant.body.grant_id);
    return grant;
  }

  revoke(grantId: string) {
    const grant = this.ports.repository.revoke(grantId, Date.now() / 1000);
    this.running.get(grantId)?.controller.abort();
    return grant;
  }

  recover(): void {
    this.ports.repository.recover(Date.now() / 1000);
    this.resumePending();
  }

  resumePending(): void {
    for (const grant of this.ports.repository.listActive()) this.schedule(grant.body.grant_id);
  }

  isScheduled(grantId: string): boolean {
    return !this.stopped && !this.ports.draining() && this.running.has(grantId);
  }

  schedule(grantId: string): void {
    if (this.stopped || this.ports.draining() || this.running.has(grantId)) return;
    const controller = new AbortController();
    const done = Promise.resolve().then(async () => {
      const repo = this.ports.repository;
      while (!this.stopped && !controller.signal.aborted && !this.ports.draining()) {
        const grant = repo.get(grantId);
        if (grant === undefined || grant.status !== "active") return;
        if (Date.parse(grant.body.expires_at) <= Date.now()) { repo.block(grantId, "expired", Date.now() / 1000); return; }
        const verified = verifyContinuationGrant({ body: grant.body, key_id: grant.key_id, signature: grant.signature }, {
          trusted_public_keys: this.ports.trustedPublicKeys, now: () => new Date().toISOString(),
        });
        if (verified.digest !== grant.digest) throw new Error("grant_digest_mismatch");
        const policy = await this.policy(grant.body.runtime_id);
        if (policy.fingerprint !== grant.body.runtime_policy_sha256) throw new Error("runtime_policy_mismatch");
        if (this.stopped || controller.signal.aborted || this.ports.draining()) return;
        const check = repo.beginCheck(grantId, Date.now() / 1000);
        if (check.outcome !== "checking") return;
        const result = checkContinuationOutput(check.session.assistant_text, check.step.checks);
        const reservation = repo.finishCheck(check.attempt.attempt_id, result, Date.now() / 1000);
        if (reservation.outcome !== "reserved") return;
        // One timer bounds both the delegated turn and the remaining grant lifetime.
        const remainingMs = Math.max(1, Date.parse(grant.body.expires_at) - Date.now());
        const timer = setTimeout(() => controller.abort(), Math.min(grant.body.turn_timeout_ms, remainingMs));
        try {
          const response = await this.ports.send(reservation, controller);
          if (!response.ok) { repo.failAttempt(reservation.attempt.attempt_id, response.error?.code ?? "delivery_failed", Date.now() / 1000); return; }
        } catch {
          repo.failAttempt(reservation.attempt.attempt_id, "delivery_uncertain", Date.now() / 1000);
          return;
        } finally { clearTimeout(timer); }
      }
    }).catch((error: unknown) => {
      const reason = error instanceof Error && /^[a-z_]{1,80}$/.test(error.message) ? error.message : "continuation_failed";
      // Never turn a repository failure into a fresh delivery. Durable accepted receipts
      // are recovered as uncertain on the next boot even if this block write fails.
      try { this.ports.repository.block(grantId, reason, Date.now() / 1000); } catch { /* fail closed */ }
    }).finally(() => { this.running.delete(grantId); });
    this.running.set(grantId, { controller, done });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const run of this.running.values()) run.controller.abort();
    await Promise.allSettled([...this.running.values()].map((run) => run.done));
  }
}
