import type { KeyObject } from "node:crypto";
import { GRANT_LIMITS, RevisionGrantError, RevisionGrantSchema, parseStoredGrant, verifyRevisionGrantSignature, type RevisionGrant } from "./revision-grant.js";
import { LocalFailureRevisionGrantSchema, parseLocalFailureRevisionGrant, verifyLocalFailureRevisionGrantSignature, type LocalFailureRevisionGrant } from "./revision-local-failure-grant.js";

/** Version-aware data contract only. Existing authority fences remain V1-only until explicitly integrated. */
export type StoredRevisionGrant = RevisionGrant | LocalFailureRevisionGrant;

/** Read historical V1 or explicit V2 without converting versions or broadening the V1 parser.
 * Parsing establishes neither signature validity nor current grant/profile/owner authority.
 */
export function parseStoredRevisionGrant(json: string): StoredRevisionGrant {
  if (typeof json !== "string" || Buffer.byteLength(json) > GRANT_LIMITS.max_json_bytes) throw new RevisionGrantError("grant_invalid");
  let value: unknown;
  try { value = JSON.parse(json); } catch { throw new RevisionGrantError("grant_invalid"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new RevisionGrantError("grant_invalid");
  const version = (value as { version?: unknown }).version;
  if (version === 1) return parseStoredGrant(json);
  if (version === 2) return parseLocalFailureRevisionGrant(json);
  throw new RevisionGrantError("grant_invalid");
}

/** Cryptographic integrity only; no time, revocation, scope, profile or host-evidence checks. Never throws. */
export function verifyStoredRevisionGrantSignature(value: unknown, publicKey: KeyObject): boolean {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const version = (value as { version?: unknown }).version;
    const parsed = version === 1 ? RevisionGrantSchema.safeParse(value) : version === 2 ? LocalFailureRevisionGrantSchema.safeParse(value) : undefined;
    if (!parsed?.success || Buffer.byteLength(JSON.stringify(parsed.data)) > GRANT_LIMITS.max_json_bytes) return false;
    const grant = parsed.data;
    return grant.version === 1 ? verifyRevisionGrantSignature(grant, publicKey) : verifyLocalFailureRevisionGrantSignature(grant, publicKey);
  } catch { return false; }
}
