// control-plane-guard.ts — boot guard for `osstack serve` (Phase 2 closure
// G1.2; incident 2026-07-18: a development clone started with the DEFAULT
// OSSTACK_HOME, attached to the stable control plane's state.db, and migrated
// its schema forward, killing the stable daemon).
//
// Rule: serving the DEFAULT (stable) home requires an EXPLICIT, per-checkout,
// UNTRACKED role declaration (`control-plane.json` at the checkout root —
// gitignored, written by the deploy step, so a fresh/stray clone can never
// carry one). A checkout without a declaration may only serve a NON-default
// home it was pointed at explicitly (dev/test harnesses keep working).
//
// Log output reports only CATEGORIES (role, home-category, schema version) —
// never raw values beyond what the operator already passed on the command line.

import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, resolve } from "node:path";

export interface ControlPlaneRole {
  /** Declared role of this checkout. Only "stable-serving" may serve the default home. */
  role: "stable-serving" | "candidate" | "dev";
  /** Absolute or ~-prefixed OSSTACK_HOME paths this checkout may serve. */
  allowed_osstack_homes: string[];
  /** Inclusive schema range this deployment expects to encounter on disk. */
  schema?: { min: number; max: number };
}

export class ControlPlaneGuardError extends Error {
  readonly code: "undeclared_checkout_on_default_home" | "home_not_allowed" | "invalid_role_file";
  constructor(code: ControlPlaneGuardError["code"], msg: string) {
    super(msg);
    this.name = "ControlPlaneGuardError";
    this.code = code;
  }
}

const expand = (p: string): string => {
  const lexical = resolve(p.replace(/^~(?=$|\/)/, homedir()));
  // Canonicalize through symlinks so an alias to the stable home cannot be
  // classified as "custom" (review F2). Walk up to the nearest existing
  // ancestor for not-yet-created homes.
  let probe = lexical;
  const segments: string[] = [];
  while (!existsSync(probe)) {
    const parent = resolve(probe, "..");
    if (parent === probe) return lexical;
    segments.unshift(basename(probe));
    probe = parent;
  }
  try { return resolve(realpathSync(probe), ...segments); } catch { return lexical; }
};

export function defaultOsstackHome(): string {
  return resolve(homedir(), ".osstack");
}

export function loadRoleFile(checkoutRoot: string): ControlPlaneRole | null {
  // EXACTLY ONE authoritative location: control-plane.json in the running
  // module's own directory (round-3 F1/F2: no ancestor search — an unrelated
  // parent directory must never be able to grant stable authority, and the
  // provisioning path is computed identically via realpath of the binary).
  const file = resolve(checkoutRoot, "control-plane.json");
  if (!existsSync(file)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    throw new ControlPlaneGuardError("invalid_role_file", `control-plane.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  const r = raw as Partial<ControlPlaneRole>;
  if (r === null || typeof r !== "object"
    || (r.role !== "stable-serving" && r.role !== "candidate" && r.role !== "dev")
    || !Array.isArray(r.allowed_osstack_homes)
    || r.allowed_osstack_homes.some((h) => typeof h !== "string" || h.length === 0)) {
    throw new ControlPlaneGuardError("invalid_role_file", "control-plane.json must declare role (stable-serving|candidate|dev) and allowed_osstack_homes (non-empty strings)");
  }
  if (r.schema !== undefined) {
    const s = r.schema as { min?: unknown; max?: unknown };
    if (!Number.isInteger(s.min) || !Number.isInteger(s.max) || (s.min as number) > (s.max as number)) {
      throw new ControlPlaneGuardError("invalid_role_file", "control-plane.json schema must be { min <= max } integers");
    }
  }
  return { role: r.role, allowed_osstack_homes: [...r.allowed_osstack_homes], ...(r.schema ? { schema: { min: r.schema.min, max: r.schema.max } } : {}) };
}

export interface GuardVerdict {
  role: ControlPlaneRole["role"] | "undeclared-dev";
  homeCategory: "default-stable" | "declared" | "custom";
  schema?: { min: number; max: number };
}

/**
 * Decide whether this checkout may serve `osstackHome`. Pure — throws
 * ControlPlaneGuardError on refusal, returns a category-only verdict on allow.
 */
export function assertServeAllowed(opts: {
  checkoutRoot: string;
  osstackHome: string;
  defaultHome?: string;
}): GuardVerdict {
  const defaultHome = expand(opts.defaultHome ?? defaultOsstackHome());
  const home = expand(opts.osstackHome);
  const declared = loadRoleFile(opts.checkoutRoot);

  if (declared === null) {
    if (home === defaultHome) {
      throw new ControlPlaneGuardError(
        "undeclared_checkout_on_default_home",
        "this checkout has no control-plane.json role declaration and may NOT serve the default (stable) OSSTACK_HOME; point OSSTACK_HOME at a dev/test home, or deploy this checkout properly (the deploy step writes the untracked role file)",
      );
    }
    return { role: "undeclared-dev", homeCategory: "custom" };
  }

  const allowed = declared.allowed_osstack_homes.map(expand);
  if (!allowed.includes(home)) {
    throw new ControlPlaneGuardError(
      "home_not_allowed",
      `this checkout's control-plane.json (role=${declared.role}) does not allow the requested OSSTACK_HOME`,
    );
  }
  // The DEFAULT (stable) home is reserved for role stable-serving even when a
  // candidate/dev declaration lists it (review F3): the role IS the boundary.
  if (home === defaultHome && declared.role !== "stable-serving") {
    throw new ControlPlaneGuardError(
      "home_not_allowed",
      `role ${declared.role} may not serve the default (stable) OSSTACK_HOME; only stable-serving may`,
    );
  }
  return {
    role: declared.role,
    homeCategory: home === defaultHome ? "default-stable" : "declared",
    ...(declared.schema ? { schema: declared.schema } : {}),
  };
}

/**
 * Provision (or verify) the stable-serving role declaration next to the REAL
 * binary, then PROVE the guard accepts the requested home. Used by
 * `serve --install` and the self-upgrade path (round-4 F1/F2): an install that
 * would produce a daemon the guard refuses must fail loudly, never silently.
 * Returns the role-file path. Throws ControlPlaneGuardError on any mismatch.
 */
export function provisionStableServing(binPath: string, osstackHome: string, schemaVersion: number): string {
  let realBin = binPath;
  try { realBin = realpathSync(binPath); } catch { /* not yet existing */ }
  const dir = dirname(realBin);
  const file = resolve(dir, "control-plane.json");
  mkdirSync(dir, { recursive: true });
  if (!existsSync(file)) {
    writeFileSync(file, `${JSON.stringify({
      role: "stable-serving",
      allowed_osstack_homes: [osstackHome],
      schema: { min: schemaVersion, max: schemaVersion },
    }, null, 2)}\n`);
  }
  // Verify: the guard MUST accept this exact deployment; otherwise the install
  // is broken (pre-existing mismatched declaration, write failure, etc.).
  assertServeAllowed({ checkoutRoot: dir, osstackHome });
  return file;
}
