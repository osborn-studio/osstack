import { constants, closeSync, fstatSync, openSync, readFileSync, realpathSync } from "node:fs";
import { createHash, timingSafeEqual } from "node:crypto";
import { isAbsolute, relative, sep } from "node:path";
import { z } from "zod";
import type { EngineeringPrincipal } from "@osstack/core";

const scope = z.string().regex(/^[a-f0-9]{64}$/);
const grants = z.array(scope).max(128);
const principalSchema = z.object({
  credential_sha256: scope,
  principal_id: z.string().min(1).max(256),
  client_session_id: z.string().min(1).max(256),
  read_scopes: grants,
  write_scopes: grants,
  stop_scopes: grants,
  operator_scopes: grants,
}).strict();
const authoritySchema = z.object({ version: z.literal(1), principals: z.array(principalSchema).max(64) }).strict();

type Authority = z.infer<typeof authoritySchema>;
function denied(): never { throw new Error("permission_denied"); }
function principal(row: Authority["principals"][number]): EngineeringPrincipal {
  const { credential_sha256: _secret, ...identity } = row;
  return identity;
}

/** Client credentials are provisioned out of band, never selected from the host's authority file. */
export function readEngineeringCredential(): string {
  const value = process.env["OSSTACK_ENGINEERING_CREDENTIAL"];
  if (!value || value.length < 32 || value.length > 4096) throw new Error("engineering_credential_required");
  return value;
}

/** Explicit trusted-process profile. A same-UID hostile worker is NOT isolated by this file.
 * Reload on every request and immediately before dispatch so cached identity cannot retain grants.
 */
export class EngineeringAccess {
  private readonly canonicalPath: string;
  constructor(readonly path: string) {
    if (!isAbsolute(path)) throw new Error("engineering_auth_invalid");
    this.canonicalPath = realpathSync(path);
    this.read();
  }
  private read(): Authority {
    let fd: number | undefined;
    try {
      // O_NOFOLLOW rejects the final symlink. Canonical identity also rejects a changed parent.
      if (realpathSync(this.path) !== this.canonicalPath) throw new Error("changed authority path");
      fd = openSync(this.path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0 || stat.size > 131072) throw new Error("insecure authority file");
      const value = authoritySchema.parse(JSON.parse(readFileSync(fd, "utf8")));
      const identities = new Set<string>();
      const credentials = new Set<string>();
      for (const row of value.principals) {
        const id = JSON.stringify([row.principal_id, row.client_session_id]);
        if (identities.has(id) || credentials.has(row.credential_sha256)) throw new Error("ambiguous authority");
        identities.add(id); credentials.add(row.credential_sha256);
      }
      return value;
    } catch { throw new Error("engineering_auth_invalid"); }
    finally { if (fd !== undefined) closeSync(fd); }
  }
  assertOutsideRepository(repoPath: string): void {
    this.assertOutsideCanonicalRepository(realpathSync(repoPath));
  }
  /** Existing Missions already bind a canonical path. Reading or stopping must
   * remain possible when the repository or its mount is unavailable. */
  assertOutsideCanonicalRepository(repoPath: string): void {
    if (!isAbsolute(repoPath)) throw new Error("engineering_auth_invalid");
    const rel = relative(repoPath, this.canonicalPath);
    if (rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel))) throw new Error("engineering_auth_inside_repository");
  }
  authenticate(credential: unknown): EngineeringPrincipal {
    if (typeof credential !== "string" || credential.length < 32 || credential.length > 4096) denied();
    const digest = createHash("sha256").update(credential).digest();
    const row = this.read().principals.find(candidate => timingSafeEqual(Buffer.from(candidate.credential_sha256, "hex"), digest));
    if (!row) denied();
    return principal(row);
  }
  /** Recovery preserves the originally authenticated identity; it never chooses another writer. */
  refresh(principalId: string, clientSessionId: string): EngineeringPrincipal {
    const row = this.read().principals.find(candidate => candidate.principal_id === principalId && candidate.client_session_id === clientSessionId);
    if (!row) denied();
    return principal(row);
  }
}
