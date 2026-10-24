import { createHash, randomUUID, verify, type KeyObject } from "node:crypto";
import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type Database from "better-sqlite3";
import type { z } from "zod";
import {
  FollowUpDeliveryTarget,
  FollowUpDeliverySubject,
  FollowUpDeliveryEnvelope,
  FollowUpDeliveryReceipt,
  SignedFollowUpDeliveryGrant,
  FollowUpDeliveryPrepareParams,
  FollowUpDeliveryActionParams,
  FollowUpDeliveryAuthorizeParams,
  FollowUpDeliveryRevokeParams,
  FollowUpDeliveryInspectParams,
  FollowUpDeliveryListParams,
  FollowUpDeliveryAttempt,
  FollowUpDeliveryResult,
  FollowUpDeliveryListItem,
  FollowUpDeliveryListResult,
} from "@osstack/protocol";
import { preflightDiskSpace } from "./db.js";

export function deliveryCanonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(deliveryCanonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${deliveryCanonical((value as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("invalid_delivery_value");
  return encoded;
}
const hash = (value: unknown) => createHash("sha256").update(deliveryCanonical(value)).digest("hex");
const bodyHash = (body: string) => createHash("sha256").update(body).digest("hex");
export const FOLLOW_UP_DELIVERY_ERRORS = [
  "invalid_delivery_request",
  "delivery_repository_unavailable",
  "delivery_not_found",
  "delivery_revision_conflict",
  "delivery_obligation_changed",
  "delivery_destination_unavailable",
  "delivery_idempotency_conflict",
  "delivery_unresolved_attempt",
  "delivery_authorization_required",
  "delivery_invalid_authorization",
  "delivery_authorization_revoked",
  "delivery_authorization_expired",
  "delivery_terminal",
  "delivery_invalid_clock",
  "delivery_durability_unavailable",
  "delivery_database_unavailable",
  "delivery_response_too_large",
  "delivery_unsupported_method",
] as const;
export class FollowUpDeliveryError extends Error {
  constructor(readonly code: (typeof FOLLOW_UP_DELIVERY_ERRORS)[number]) {
    super(code);
    this.name = "FollowUpDeliveryError";
  }
}
export interface FollowUpDeliveryTrust {
  publicKey: KeyObject;
  purpose: "follow_up_delivery";
  repo_path: string;
  provider_id: "github_comment";
  destination_refs: readonly string[];
  max_validity_ms: number;
}
export interface FollowUpTransport {
  qualification: "test_only" | "sandbox_qualified" | "production_qualified";
  /** The adapter must disable SDK retries; declaration is not provider qualification. */
  automatic_retries: boolean;
  lookup_receipt: boolean;
  /** Effect-free readiness checks, before consuming a grant. Implementations MUST NOT POST here. */
  preflight?(envelope: Readonly<FollowUpDeliveryEnvelope>, signal: AbortSignal): Promise<void>;
  /** Synchronous readiness/credential fence, called inside the consuming transaction. */
  assertReady?(envelope: Readonly<FollowUpDeliveryEnvelope>): void;
  sendOnce(envelope: Readonly<FollowUpDeliveryEnvelope>, signal: AbortSignal): Promise<unknown>;
  /** Trusted provider lookup; caller-supplied receipt objects never enter this port. */
  lookup(
    envelope: Readonly<FollowUpDeliveryEnvelope>,
    signal: AbortSignal,
    context?: { createdAtMs: number },
  ): Promise<unknown>;
}
export interface FollowUpDeliveryOptions {
  targets?: ReadonlyMap<string, FollowUpDeliveryTarget>;
  trustedKeys?: ReadonlyMap<string, FollowUpDeliveryTrust>;
  transports?: ReadonlyMap<string, FollowUpTransport>;
  allowTestTransports?: boolean;
  nowMs?: () => number;
  timeoutMs?: number;
  /** Trusted synchronous host revocation fence, evaluated inside authority transactions. */
  assertHostConfiguration?: () => void;
}
interface Row {
  attempt_id: string;
  repo_path: string;
  obligation_id: string;
  obligation_revision: number;
  idempotency_key: string;
  create_digest: string;
  envelope_json: string;
  state: FollowUpDeliveryAttempt["state"];
  revision: number;
  created_at_ms: number;
  updated_at_ms: number;
  qualification: FollowUpDeliveryAttempt["qualification"];
  receipt_json: string | null;
  receipt_sha256: string | null;
  reason: string | null;
}
interface GrantRow {
  grant_id: string;
  key_id: string;
  signed_json: string;
  state: "active" | "consumed" | "revoked";
}
export function serializeFollowUpDelivery(value: unknown): string {
  return JSON.stringify(value).replace(/[\u007f-\u009f\u2028\u2029\p{Cf}]/gu, (c) =>
    c
      .split("")
      .map((u) => `\\u${u.charCodeAt(0).toString(16).padStart(4, "0")}`)
      .join(""),
  );
}
function bounded<T>(value: T): T {
  if (Buffer.byteLength(serializeFollowUpDelivery(value)) + 1 > 65536)
    throw new FollowUpDeliveryError("delivery_response_too_large");
  return value;
}
function parsed<T extends z.ZodTypeAny>(schema: T, value: unknown): z.infer<T> {
  const result = schema.safeParse(value);
  if (!result.success) throw new FollowUpDeliveryError("invalid_delivery_request");
  return result.data;
}
function repoPath(path: string): string {
  try {
    if (!isAbsolute(path) || /[\p{C}]/u.test(path)) throw Error();
    const repo = realpathSync(path);
    if (!statSync(repo).isDirectory() || Buffer.byteLength(repo) > 4096) throw Error();
    accessSync(repo, constants.R_OK | constants.X_OK);
    return repo;
  } catch {
    throw new FollowUpDeliveryError("delivery_repository_unavailable");
  }
}
function storedRepoPath(path: string): string {
  if (!isAbsolute(path) || resolve(path) !== path || /[\p{C}]/u.test(path) || Buffer.byteLength(path) > 4096)
    throw new FollowUpDeliveryError("delivery_repository_unavailable");
  return path;
}
function frozen<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    Object.freeze(value);
    for (const child of Object.values(value)) frozen(child);
  }
  return value;
}

/** Host registries/keys are trusted composition, never RPC input. Construction performs no I/O. */
export class FollowUpDeliveryService {
  private observedClock = 0;
  constructor(
    private readonly db: Database.Database,
    private readonly dbPath: string,
    private readonly options: FollowUpDeliveryOptions = {},
  ) {}
  async handle(method: string, input: unknown): Promise<FollowUpDeliveryResult | FollowUpDeliveryListResult> {
    switch (method) {
      case "follow-up-delivery.prepare":
        return this.prepare(input);
      case "follow-up-delivery.list":
        return this.list(input);
      case "follow-up-delivery.inspect":
        return this.inspect(input);
      case "follow-up-delivery.authorize":
        return this.authorize(input);
      case "follow-up-delivery.revoke":
        return this.revoke(input);
      case "follow-up-delivery.dispatch":
        return this.dispatch(input);
      case "follow-up-delivery.reconcile":
        return this.reconcile(input);
      default:
        throw new FollowUpDeliveryError("delivery_unsupported_method");
    }
  }
  prepare(input: unknown): FollowUpDeliveryResult {
    const p = parsed(FollowUpDeliveryPrepareParams, input),
      repo = repoPath(p.repo_path),
      createDigest = hash({ ...p, repo_path: repo });
    return this.safe(() =>
      this.durableWrite(() => {
        const existing = this.db
          .prepare(
            "SELECT * FROM follow_up_delivery_attempts WHERE repo_path=? AND tenant='default' AND idempotency_key=?",
          )
          .get(repo, p.idempotency_key) as Row | undefined;
        if (existing) {
          if (existing.create_digest !== createDigest)
            throw new FollowUpDeliveryError("delivery_idempotency_conflict");
          return this.result(existing, "unchanged", true);
        }
        this.obligation(repo, p.obligation_id, p.expected_obligation_revision);
        if (
          this.db
            .prepare(
              "SELECT 1 FROM follow_up_delivery_attempts WHERE repo_path=? AND tenant='default' AND obligation_id=? AND state IN ('prepared','started','delivery_unknown')",
            )
            .get(repo, p.obligation_id)
        )
          throw new FollowUpDeliveryError("delivery_unresolved_attempt");
        const target = this.target(repo, p.destination_ref),
          now = this.clock(),
          attemptId = randomUUID();
        const payload = {
          repo_path: repo,
          default_tenant: true as const,
          attempt_id: attemptId,
          obligation_id: p.obligation_id,
          obligation_revision: p.expected_obligation_revision,
          destination: target,
          destination_digest: hash(target),
          body: p.body,
          body_sha256: bodyHash(p.body),
        };
        const envelope = FollowUpDeliveryEnvelope.parse({ ...payload, envelope_digest: hash(payload) });
        if (Buffer.byteLength(JSON.stringify(envelope)) > 49152)
          throw new FollowUpDeliveryError("delivery_response_too_large");
        this.db
          .prepare(
            "INSERT INTO follow_up_delivery_attempts(attempt_id,repo_path,tenant,obligation_id,obligation_revision,idempotency_key,create_digest,envelope_json,state,revision,created_at_ms,updated_at_ms,qualification) VALUES(?,?,'default',?,?,?,?,?,'prepared',1,?,?,'qualification_pending')",
          )
          .run(
            attemptId,
            repo,
            p.obligation_id,
            p.expected_obligation_revision,
            p.idempotency_key,
            createDigest,
            JSON.stringify(envelope),
            now,
            now,
          );
        const row = this.row(repo, attemptId);
        this.reserveReceiptSpace(row);
        this.event(attemptId, 1, "prepared", { envelope_digest: envelope.envelope_digest }, now);
        return this.result(row, "prepared");
      }),
    );
  }
  inspect(input: unknown): FollowUpDeliveryResult {
    const p = parsed(FollowUpDeliveryInspectParams, input),
      repo = storedRepoPath(p.repo_path);
    return this.safe(() => this.result(this.row(repo, p.attempt_id), "unchanged"));
  }
  list(input: unknown): FollowUpDeliveryListResult {
    const p = parsed(FollowUpDeliveryListParams, input),
      repo = storedRepoPath(p.repo_path);
    return this.safe(() => {
      const rows = this.db
        .prepare(
          "SELECT * FROM follow_up_delivery_attempts WHERE repo_path=? AND tenant='default' AND attempt_id>? ORDER BY attempt_id LIMIT ?",
        )
        .all(repo, p.after_id ?? "", p.limit + 1) as Row[];
      const items: z.infer<typeof FollowUpDeliveryListItem>[] = [];
      let after: string | null = null;
      for (let i = 0; i < Math.min(rows.length, p.limit); i++) {
        const row = rows[i]!,
          view = this.view(row),
          { envelope, authorization_subject: _subject, receipt: _receipt, ...rest } = view;
        const item = FollowUpDeliveryListItem.parse({
          ...rest,
          destination_ref: envelope.destination.destination_ref,
          body_sha256: envelope.body_sha256,
        });
        const more = i + 1 < rows.length,
          candidate = {
            schema_version: 1 as const,
            scope: { repo_path: repo, default_tenant: true as const },
            attempts: [...items, item],
            next_after_id: more ? row.attempt_id : null,
          };
        if (Buffer.byteLength(serializeFollowUpDelivery(candidate)) + 1 > 65536) {
          if (!items.length) throw new FollowUpDeliveryError("delivery_response_too_large");
          after = items[items.length - 1]!.attempt_id;
          break;
        }
        items.push(item);
        after = candidate.next_after_id;
      }
      return bounded(
        FollowUpDeliveryListResult.parse({
          schema_version: 1,
          scope: { repo_path: repo, default_tenant: true },
          attempts: items,
          next_after_id: after,
        }),
      );
    });
  }
  authorize(input: unknown): FollowUpDeliveryResult {
    const p = parsed(FollowUpDeliveryAuthorizeParams, input),
      repo = repoPath(p.repo_path);
    return this.safe(() =>
      this.durableWrite(() => {
        const row = this.row(repo, p.attempt_id),
          existing = this.grant(row.attempt_id);
        if (existing && deliveryCanonical(JSON.parse(existing.signed_json)) === deliveryCanonical(p.grant))
          return this.result(row, "unchanged", true);
        this.revision(row, p.expected_revision);
        if (row.state !== "prepared") throw new FollowUpDeliveryError("delivery_terminal");
        if (existing) throw new FollowUpDeliveryError("delivery_invalid_authorization");
        this.options.assertHostConfiguration?.();
        const now = this.clock(row.updated_at_ms);
        this.verifyGrant(row, p.grant, now);
        if (
          this.db
            .prepare("SELECT 1 FROM follow_up_delivery_grants WHERE grant_id=?")
            .get(p.grant.body.grant_id)
        )
          throw new FollowUpDeliveryError("delivery_invalid_authorization");
        this.db
          .prepare(
            "INSERT INTO follow_up_delivery_grants(grant_id,attempt_id,key_id,signed_json,state,created_at_ms,updated_at_ms) VALUES(?,?,?,?,'active',?,?)",
          )
          .run(p.grant.body.grant_id, row.attempt_id, p.grant.key_id, JSON.stringify(p.grant), now, now);
        return this.result(
          this.bump(row, "prepared", "authorized", now, {
            grant_id: p.grant.body.grant_id,
            key_id: p.grant.key_id,
          }),
          "authorized",
        );
      }),
    );
  }
  revoke(input: unknown): FollowUpDeliveryResult {
    const p = parsed(FollowUpDeliveryRevokeParams, input),
      repo = storedRepoPath(p.repo_path);
    return this.safe(() =>
      this.durableWrite(() => {
        const row = this.row(repo, p.attempt_id);
        this.revision(row, p.expected_revision);
        if (["delivered", "definitely_not_sent"].includes(row.state))
          return this.result(row, "unchanged", true);
        const now = this.evidenceClock(row.updated_at_ms);
        this.db
          .prepare(
            "UPDATE follow_up_delivery_grants SET state='revoked',updated_at_ms=? WHERE attempt_id=? AND state='active'",
          )
          .run(now, row.attempt_id);
        return this.result(
          this.bump(
            row,
            row.state === "prepared" ? "definitely_not_sent" : "delivery_unknown",
            row.state === "prepared" ? "revoked_before_send" : "revoked_after_start",
            now,
            { reason: p.reason, timestamp_basis: "monotone_revocation_record" },
          ),
          "revoked",
        );
      }),
    );
  }
  async dispatch(input: unknown): Promise<FollowUpDeliveryResult> {
    const p = parsed(FollowUpDeliveryActionParams, input),
      repo = repoPath(p.repo_path);
    // A transient read-only provider preflight does not consume or wedge a still-prepared attempt.
    const admission = this.safe(() =>
      this.durableWrite(() => {
        const row = this.row(repo, p.attempt_id);
        this.revision(row, p.expected_revision);
        if (row.state !== "prepared") return undefined;
        const envelope = this.envelope(row),
          transport = this.transport(envelope);
        if (!transport?.preflight) return undefined;
        const grant = this.grant(row.attempt_id);
        if (!grant) throw new FollowUpDeliveryError("delivery_authorization_required");
        if (grant.state !== "active") throw new FollowUpDeliveryError("delivery_authorization_revoked");
        this.options.assertHostConfiguration?.();
        this.verifyGrant(
          row,
          SignedFollowUpDeliveryGrant.parse(JSON.parse(grant.signed_json)),
          this.clock(row.updated_at_ms),
        );
        return { envelope: frozen(envelope), transport };
      }),
    );
    if (admission) {
      const readiness = await this.boundedCall((signal) =>
        admission.transport.preflight!(admission.envelope, signal),
      );
      if (!readiness.ok) throw new FollowUpDeliveryError("delivery_destination_unavailable");
    }
    const claim = this.safe(() =>
      this.durableWrite(() => {
        const row = this.row(repo, p.attempt_id);
        this.revision(row, p.expected_revision);
        if (row.state !== "prepared")
          return {
            result: this.result(
              row,
              row.state === "started"
                ? "in_flight"
                : row.state === "delivery_unknown"
                  ? "delivery_unknown"
                  : "unchanged",
              true,
            ),
          };
        const envelope = this.envelope(row),
          transport = this.transport(envelope);
        if (!transport) return { result: this.result(row, "qualification_pending") };
        const grant = this.grant(row.attempt_id);
        if (!grant) throw new FollowUpDeliveryError("delivery_authorization_required");
        if (grant.state !== "active") throw new FollowUpDeliveryError("delivery_authorization_revoked");
        const now = this.clock(row.updated_at_ms);
        this.options.assertHostConfiguration?.();
        // Verify current key, exact target, immutable content and time INSIDE the consuming transaction.
        this.verifyGrant(row, SignedFollowUpDeliveryGrant.parse(JSON.parse(grant.signed_json)), now);
        this.obligation(repo, row.obligation_id, row.obligation_revision);
        transport.assertReady?.(envelope);
        const consumed = this.db
          .prepare(
            "UPDATE follow_up_delivery_grants SET state='consumed',updated_at_ms=? WHERE attempt_id=? AND state='active'",
          )
          .run(now, row.attempt_id);
        if (consumed.changes !== 1) throw new FollowUpDeliveryError("delivery_authorization_revoked");
        const started = this.bump(
          row,
          "started",
          "send_started",
          now,
          { grant_id: grant.grant_id },
          transport.qualification,
        );
        return { row: started, envelope: frozen(envelope), transport };
      }),
    );
    if ("result" in claim) return claim.result;
    // No retry or fallback exists here. A throw after this call cannot prove non-delivery.
    const outcome = await this.boundedCall((signal) => claim.transport.sendOnce(claim.envelope, signal));
    return this.safe(() =>
      this.durableWrite(() => {
        const current = this.row(repo, p.attempt_id);
        if (current.state !== "started" || current.revision !== claim.row.revision)
          return this.result(current, "unchanged", true);
        const now = this.evidenceClock(current.updated_at_ms),
          receipt = outcome.ok ? this.receipt(claim.envelope, outcome.value) : null;
        if (!receipt)
          return this.result(
            this.bump(
              current,
              "delivery_unknown",
              outcome.ok ? "receipt_unconfirmed" : "send_outcome_unknown",
              now,
              {},
            ),
            "delivery_unknown",
          );
        return this.result(
          this.bump(
            current,
            "delivered",
            "provider_receipt",
            now,
            { receipt_sha256: hash(receipt) },
            current.qualification,
            receipt,
          ),
          "delivered",
        );
      }),
    );
  }
  async reconcile(input: unknown): Promise<FollowUpDeliveryResult> {
    const p = parsed(FollowUpDeliveryActionParams, input),
      repo = storedRepoPath(p.repo_path);
    const claim = this.safe(() =>
      this.durableWrite(() => {
        let row = this.row(repo, p.attempt_id);
        this.revision(row, p.expected_revision);
        if (row.state === "prepared") throw new FollowUpDeliveryError("delivery_authorization_required");
        if (["delivered", "definitely_not_sent"].includes(row.state))
          return { result: this.result(row, "unchanged", true) };
        const envelope = this.envelope(row),
          transport = this.transport(envelope);
        if (!transport?.lookup_receipt || transport.qualification !== row.qualification)
          return { result: this.result(row, "qualification_pending") };
        const now = this.evidenceClock(row.updated_at_ms);
        if (row.state === "started") row = this.bump(row, "delivery_unknown", "started_unconfirmed", now, {});
        const started = this.db
          .prepare(
            "SELECT created_at_ms FROM follow_up_delivery_events WHERE attempt_id=? AND transition='send_started' ORDER BY revision LIMIT 1",
          )
          .get(row.attempt_id) as { created_at_ms: number } | undefined;
        return {
          row,
          envelope: frozen(envelope),
          transport,
          lookupSinceMs: started?.created_at_ms ?? row.created_at_ms,
        };
      }),
    );
    if ("result" in claim) return claim.result;
    const outcome = await this.boundedCall((signal) =>
      claim.transport.lookup(claim.envelope, signal, { createdAtMs: claim.lookupSinceMs }),
    );
    return this.safe(() =>
      this.durableWrite(() => {
        const row = this.row(repo, p.attempt_id);
        if (row.state !== "delivery_unknown" || row.revision !== claim.row.revision)
          return this.result(row, "unchanged", true);
        const now = this.evidenceClock(row.updated_at_ms),
          receipt = outcome.ok ? this.receipt(claim.envelope, outcome.value) : null;
        if (!receipt)
          return this.result(
            this.bump(row, "delivery_unknown", "lookup_unconfirmed", now, {}),
            "delivery_unknown",
          );
        return this.result(
          this.bump(
            row,
            "delivered",
            "provider_lookup_receipt",
            now,
            { receipt_sha256: hash(receipt) },
            row.qualification,
            receipt,
          ),
          "delivered",
        );
      }),
    );
  }
  private async boundedCall(
    call: (signal: AbortSignal) => Promise<unknown>,
  ): Promise<{ ok: true; value: unknown } | { ok: false }> {
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        Promise.resolve()
          .then(() => call(controller.signal))
          .then(
            (value) => ({ ok: true as const, value }),
            () => ({ ok: false as const }),
          ),
        new Promise<{ ok: false }>((resolve) => {
          timer = setTimeout(
            () => {
              controller.abort();
              resolve({ ok: false });
            },
            Math.max(1, Math.min(30000, this.options.timeoutMs ?? 5000)),
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      controller.abort();
    }
  }
  private target(repo: string, ref: string): FollowUpDeliveryTarget {
    const result = FollowUpDeliveryTarget.safeParse(this.options.targets?.get(ref));
    if (!result.success || result.data.destination_ref !== ref || result.data.repo_path !== repo)
      throw new FollowUpDeliveryError("delivery_destination_unavailable");
    return result.data;
  }
  private transport(envelope: FollowUpDeliveryEnvelope): FollowUpTransport | undefined {
    const current = this.target(envelope.repo_path, envelope.destination.destination_ref);
    if (hash(current) !== envelope.destination_digest)
      throw new FollowUpDeliveryError("delivery_destination_unavailable");
    const t = this.options.transports?.get(current.provider_id);
    if (
      !t ||
      t.automatic_retries ||
      !(["test_only", "sandbox_qualified", "production_qualified"] as string[]).includes(t.qualification) ||
      (t.qualification === "test_only" && !this.options.allowTestTransports)
    )
      return undefined;
    return t;
  }
  private subject(envelope: FollowUpDeliveryEnvelope) {
    return FollowUpDeliverySubject.parse({
      domain: "osstack.follow-up-delivery.v1",
      repo_path: envelope.repo_path,
      default_tenant: true,
      attempt_id: envelope.attempt_id,
      provider_id: envelope.destination.provider_id,
      account_id: envelope.destination.account_id,
      destination_digest: envelope.destination_digest,
      body_sha256: envelope.body_sha256,
      envelope_digest: envelope.envelope_digest,
    });
  }
  private verifyGrant(row: Row, grant: SignedFollowUpDeliveryGrant, now: number): void {
    const envelope = this.envelope(row),
      body = grant.body,
      { grant_id: _id, issued_at_ms, expires_at_ms, max_calls: _calls, ...subject } = body,
      key = this.options.trustedKeys?.get(grant.key_id);
    if (
      key?.purpose !== "follow_up_delivery" ||
      key.publicKey.type !== "public" ||
      key.publicKey.asymmetricKeyType !== "ed25519" ||
      key.repo_path !== row.repo_path ||
      key.provider_id !== envelope.destination.provider_id ||
      !key.destination_refs.includes(envelope.destination.destination_ref) ||
      !Number.isSafeInteger(key.max_validity_ms) ||
      key.max_validity_ms < 1 ||
      expires_at_ms - issued_at_ms > key.max_validity_ms ||
      deliveryCanonical(subject) !== deliveryCanonical(this.subject(envelope))
    )
      throw new FollowUpDeliveryError("delivery_invalid_authorization");
    if (now < issued_at_ms || now >= expires_at_ms)
      throw new FollowUpDeliveryError("delivery_authorization_expired");
    if (
      hash(this.target(row.repo_path, envelope.destination.destination_ref)) !== envelope.destination_digest
    )
      throw new FollowUpDeliveryError("delivery_destination_unavailable");
    if (
      !verify(
        null,
        Buffer.from(deliveryCanonical(body)),
        key.publicKey,
        Buffer.from(grant.signature, "base64"),
      )
    )
      throw new FollowUpDeliveryError("delivery_invalid_authorization");
  }
  private receipt(envelope: FollowUpDeliveryEnvelope, raw: unknown): FollowUpDeliveryReceipt | null {
    const result = FollowUpDeliveryReceipt.safeParse(raw);
    if (!result.success) return null;
    const r = result.data;
    return r.provider_id === envelope.destination.provider_id &&
      r.account_id === envelope.destination.account_id &&
      r.target_node_id === envelope.destination.target_node_id &&
      r.author_node_id === envelope.destination.actor_node_id &&
      r.destination_digest === envelope.destination_digest &&
      r.body_sha256 === envelope.body_sha256 &&
      r.attempt_id === envelope.attempt_id
      ? r
      : null;
  }
  private envelope(row: Row): FollowUpDeliveryEnvelope {
    const e = FollowUpDeliveryEnvelope.parse(JSON.parse(row.envelope_json)),
      { envelope_digest, ...payload } = e;
    if (
      e.attempt_id !== row.attempt_id ||
      e.repo_path !== row.repo_path ||
      e.obligation_id !== row.obligation_id ||
      e.obligation_revision !== row.obligation_revision ||
      e.body_sha256 !== bodyHash(e.body) ||
      e.destination_digest !== hash(e.destination) ||
      envelope_digest !== hash(payload)
    )
      throw new FollowUpDeliveryError("delivery_database_unavailable");
    return e;
  }
  private grant(id: string): GrantRow | undefined {
    return this.db.prepare("SELECT * FROM follow_up_delivery_grants WHERE attempt_id=?").get(id) as
      | GrantRow
      | undefined;
  }
  private row(repo: string, id: string): Row {
    const r = this.db
      .prepare(
        "SELECT * FROM follow_up_delivery_attempts WHERE repo_path=? AND tenant='default' AND attempt_id=?",
      )
      .get(repo, id) as Row | undefined;
    if (!r) throw new FollowUpDeliveryError("delivery_not_found");
    return r;
  }
  private revision(row: Row, expected: number) {
    if (row.revision !== expected) throw new FollowUpDeliveryError("delivery_revision_conflict");
  }
  private obligation(repo: string, id: string, revision: number) {
    const row = this.db
      .prepare(
        "SELECT revision FROM follow_up_obligations WHERE repo_path=? AND tenant='default' AND obligation_id=?",
      )
      .get(repo, id) as { revision: number } | undefined;
    if (!row || row.revision !== revision) throw new FollowUpDeliveryError("delivery_obligation_changed");
  }
  private readClock(): number {
    const now = (this.options.nowMs ?? Date.now)();
    if (Number.isSafeInteger(now) && now >= 0 && now <= 8_640_000_000_000_000)
      this.observedClock = Math.max(this.observedClock, now);
    return now;
  }
  private highWater(): number {
    return (
      this.db.prepare("SELECT observed_at_ms FROM follow_up_delivery_clock WHERE singleton=1").get() as {
        observed_at_ms: number;
      }
    ).observed_at_ms;
  }
  private clock(minimum = 0): number {
    const now = this.readClock();
    if (
      !Number.isSafeInteger(now) ||
      now < Math.max(minimum, this.highWater()) ||
      now > 8_640_000_000_000_000
    )
      throw new FollowUpDeliveryError("delivery_invalid_clock");
    return now;
  }
  private evidenceClock(minimum: number): number {
    this.readClock();
    return Math.max(minimum, this.observedClock, this.highWater());
  }
  /** FULL commit is required before an irreversible call. No await permits connection sharing here. */
  private durableWrite<T>(call: () => T): T {
    if (this.db.inTransaction || this.db.pragma("journal_mode", { simple: true }) !== "wal")
      throw new FollowUpDeliveryError("delivery_durability_unavailable");
    const observedBefore = this.observedClock;
    const previous = this.db.pragma("synchronous", { simple: true }) as number;
    const previousFullFsync = this.db.pragma("fullfsync", { simple: true }) as number;
    const persistClock = () => {
      this.db
        .prepare("UPDATE follow_up_delivery_clock SET observed_at_ms=MAX(observed_at_ms,?) WHERE singleton=1")
        .run(this.observedClock);
    };
    try {
      this.db.pragma("synchronous=FULL");
      if (process.platform === "darwin") this.db.pragma("fullfsync=ON");
      if (
        this.db.pragma("synchronous", { simple: true }) !== 2 ||
        (process.platform === "darwin" && this.db.pragma("fullfsync", { simple: true }) !== 1)
      )
        throw new FollowUpDeliveryError("delivery_durability_unavailable");
      try {
        preflightDiskSpace(this.dbPath);
        return this.db
          .transaction(() => {
            const result = call();
            persistClock();
            return result;
          })
          .immediate();
      } catch (error) {
        // Failed expiry checks also advance the observed clock: a later rollback cannot revive the grant.
        if (this.observedClock > observedBefore) {
          preflightDiskSpace(this.dbPath);
          this.db.transaction(persistClock).immediate();
        }
        throw error;
      }
    } finally {
      this.db.pragma(`synchronous=${previous}`);
      if (process.platform === "darwin") this.db.pragma(`fullfsync=${previousFullFsync}`);
    }
  }
  private safe<T>(call: () => T): T {
    try {
      return call();
    } catch (error) {
      if (error instanceof FollowUpDeliveryError) throw error;
      throw new FollowUpDeliveryError("delivery_database_unavailable");
    }
  }
  private bump(
    row: Row,
    state: Row["state"],
    reason: string,
    now: number,
    evidence: unknown,
    qualification = row.qualification,
    receipt: FollowUpDeliveryReceipt | null = null,
  ): Row {
    if (row.revision >= Number.MAX_SAFE_INTEGER - 1)
      throw new FollowUpDeliveryError("delivery_revision_conflict");
    const result = this.db
      .prepare(
        "UPDATE follow_up_delivery_attempts SET state=?,revision=revision+1,updated_at_ms=?,qualification=?,receipt_json=?,receipt_sha256=?,reason=? WHERE attempt_id=? AND revision=?",
      )
      .run(
        state,
        now,
        qualification,
        receipt ? JSON.stringify(receipt) : null,
        receipt ? hash(receipt) : null,
        reason,
        row.attempt_id,
        row.revision,
      );
    if (result.changes !== 1) throw new FollowUpDeliveryError("delivery_revision_conflict");
    this.event(row.attempt_id, row.revision + 1, reason, evidence, now);
    return this.row(row.repo_path, row.attempt_id);
  }
  private event(id: string, revision: number, transition: string, evidence: unknown, now: number) {
    this.db
      .prepare(
        "INSERT INTO follow_up_delivery_events(attempt_id,revision,transition,evidence_json,created_at_ms) VALUES(?,?,?,?,?)",
      )
      .run(id, revision, transition, JSON.stringify(evidence), now);
  }
  private view(row: Row): FollowUpDeliveryAttempt {
    const envelope = this.envelope(row);
    return FollowUpDeliveryAttempt.parse({
      attempt_id: row.attempt_id,
      repo_path: row.repo_path,
      default_tenant: true,
      obligation_id: row.obligation_id,
      obligation_revision: row.obligation_revision,
      state: row.state,
      revision: row.revision,
      created_at_ms: row.created_at_ms,
      updated_at_ms: row.updated_at_ms,
      envelope,
      authorization_subject: this.subject(envelope),
      authorization_status: this.grant(row.attempt_id)?.state ?? "missing",
      qualification: row.qualification,
      receipt: row.receipt_json === null ? null : JSON.parse(row.receipt_json),
      receipt_sha256: row.receipt_sha256,
      reason: row.reason,
      delivery_uncertain: row.state === "started" || row.state === "delivery_unknown",
      promise_fulfillment: "independent_local_obligation",
    });
  }
  /** Reserve the largest valid receipt before an irreversible transport call is possible. */
  private reserveReceiptSpace(row: Row): void {
    const view = this.view(row),
      e = view.envelope;
    const receipt: FollowUpDeliveryReceipt = {
      provider_id: e.destination.provider_id,
      account_id: e.destination.account_id,
      target_node_id: e.destination.target_node_id,
      author_node_id: e.destination.actor_node_id,
      destination_digest: e.destination_digest,
      body_sha256: e.body_sha256,
      attempt_id: e.attempt_id,
      provider_message_id: "x" + "\0".repeat(255),
      provider_request_id: "x" + "\0".repeat(255),
    };
    bounded({
      schema_version: 1,
      outcome: "delivery_unknown",
      attempt: {
        ...view,
        state: "delivery_unknown",
        revision: Number.MAX_SAFE_INTEGER - 1,
        updated_at_ms: 8_640_000_000_000_000,
        qualification: "production_qualified",
        authorization_status: "consumed",
        receipt,
        receipt_sha256: "f".repeat(64),
        reason: "x".repeat(128),
        delivery_uncertain: true,
      },
      duplicate: false,
    });
  }
  private result(
    row: Row,
    outcome: FollowUpDeliveryResult["outcome"],
    duplicate = false,
  ): FollowUpDeliveryResult {
    return bounded(
      FollowUpDeliveryResult.parse({ schema_version: 1, outcome, attempt: this.view(row), duplicate }),
    );
  }
}
