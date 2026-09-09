import { createHash, createPublicKey, verify as verifySignature } from "node:crypto";
import { ContinuationGrantBody, SignedContinuationGrant } from "@osstack/protocol";
import { z } from "zod";

const MAX_VALIDITY_MS = 24 * 60 * 60 * 1_000;
const SINGLE_PUBLIC_KEY_PEM = /^-----BEGIN PUBLIC KEY-----\r?\n[A-Za-z0-9+/=\s]+\r?\n-----END PUBLIC KEY-----$/;
// Parse this package's local input independently; do not compose schemas from
// different packages, which may resolve different Zod major versions.
const VerifierTimestamp = z.string().datetime({ offset: true });

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  // Optional object fields explicitly set to undefined have the same wire
  // representation as absent fields; never emit invalid JSON "undefined".
  return `{${Object.keys(record).filter((key) => record[key] !== undefined).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(record[key])}`,
  ).join(",")}}`;
}

/**
 * Exact UTF-8 signing representation: strict protocol parse, defaults included,
 * recursively sorted object keys, unchanged array order and instruction text.
 * Issuers must sign these bytes with Ed25519; no R3 approval is implied.
 */
export function canonicalContinuationGrantBody(value: unknown): string {
  return canonicalJson(ContinuationGrantBody.parse(value));
}

export function continuationGrantDigest(value: unknown): string {
  return createHash("sha256").update(canonicalContinuationGrantBody(value)).digest("hex");
}

type DeepReadonly<T> = T extends readonly (infer Element)[]
  ? readonly DeepReadonly<Element>[]
  : T extends object
    ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
    : T;

const verifiedGrantBrand: unique symbol = Symbol("VerifiedContinuationGrant");
const verifiedGrants = new WeakSet<object>();

/** A verified grant is a local runtime capability, not a serializable claim. */
export interface VerifiedContinuationGrant {
  readonly [verifiedGrantBrand]: true;
  readonly body: DeepReadonly<ContinuationGrantBody>;
  readonly key_id: string;
  readonly signature: string;
  readonly digest: string;
}

export interface ContinuationGrantVerificationContext {
  /** Public verification keys only; issuance/private keys live outside here. */
  trusted_public_keys: ReadonlyMap<string, string>;
  now: () => string;
}

export function isVerifiedContinuationGrant(value: unknown): value is VerifiedContinuationGrant {
  return typeof value === "object" && value !== null && verifiedGrants.has(value);
}

function deepFreeze<T>(value: T): DeepReadonly<T> {
  if (typeof value === "object" && value !== null) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value as DeepReadonly<T>;
}

function timestamp(value: string, label: string): number {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) throw new Error(`${label} is not a valid timestamp`);
  return milliseconds;
}

/**
 * Verifies signature and time validity at this instant, returning a frozen copy.
 * Durable grant consumption, current session/runtime/repository binding and
 * rechecking expiry on each action belong to the continuation control plane.
 * Output checks establish only their declared contract, not open-ended quality.
 */
export function verifyContinuationGrant(
  value: unknown,
  context: ContinuationGrantVerificationContext,
): VerifiedContinuationGrant {
  const grant = SignedContinuationGrant.parse(value);
  const now = timestamp(VerifierTimestamp.parse(context.now()), "continuation verifier clock");
  const issuedAt = timestamp(grant.body.issued_at, "continuation issued_at");
  const expiresAt = timestamp(grant.body.expires_at, "continuation expires_at");
  if (expiresAt <= issuedAt) throw new Error("continuation grant validity interval must be positive");
  if (expiresAt - issuedAt > MAX_VALIDITY_MS) throw new Error("continuation grant validity exceeds 24 hours");
  if (issuedAt > now) throw new Error("continuation grant was issued in the future");
  if (now >= expiresAt) throw new Error("continuation grant has expired");

  const publicKeyPem = context.trusted_public_keys.get(grant.key_id);
  if (publicKeyPem === undefined) throw new Error(`continuation grant key_id ${grant.key_id} is not trusted`);
  // createPublicKey also accepts private PEM and silently derives its public
  // half. Reject that input, preambles and extra PEM blocks before parsing.
  if (!SINGLE_PUBLIC_KEY_PEM.test(publicKeyPem.trim())) {
    throw new Error("continuation verification key must be a single SPKI PUBLIC KEY PEM block");
  }
  const publicKey = createPublicKey(publicKeyPem);
  if (publicKey.asymmetricKeyType !== "ed25519") throw new Error("continuation verification key must be Ed25519");
  const signature = Buffer.from(grant.signature, "base64");
  if (signature.length !== 64 || signature.toString("base64") !== grant.signature) {
    throw new Error("continuation signature must be canonical base64 for 64 bytes");
  }
  const canonical = canonicalContinuationGrantBody(grant.body);
  if (!verifySignature(null, Buffer.from(canonical), publicKey, signature)) {
    throw new Error("continuation grant signature is invalid");
  }
  const verified: VerifiedContinuationGrant = Object.freeze({
    [verifiedGrantBrand]: true as const,
    body: deepFreeze(grant.body),
    key_id: grant.key_id,
    signature: grant.signature,
    digest: createHash("sha256").update(canonical).digest("hex"),
  });
  verifiedGrants.add(verified);
  return verified;
}
