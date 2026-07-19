import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertServeAllowed, ControlPlaneGuardError, loadRoleFile, reserveHome } from "./control-plane-guard.js";

let root: string;
const DEFAULT = "/fake/home/.osstack";
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "cpg-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const declare = (v: unknown) => writeFileSync(join(root, "control-plane.json"), JSON.stringify(v));

describe("control-plane boot guard (G1.2, incident 2026-07-18)", () => {
  it("REFUSES an undeclared checkout serving the DEFAULT (stable) home", () => {
    expect(() => assertServeAllowed({ checkoutRoot: root, osstackHome: DEFAULT, defaultHome: DEFAULT }))
      .toThrowError(ControlPlaneGuardError);
    try { assertServeAllowed({ checkoutRoot: root, osstackHome: DEFAULT, defaultHome: DEFAULT }); }
    catch (e) { expect((e as ControlPlaneGuardError).code).toBe("undeclared_checkout_on_default_home"); }
  });

  it("allows an undeclared checkout on an explicit NON-default home (dev harnesses)", () => {
    const v = assertServeAllowed({ checkoutRoot: root, osstackHome: join(root, "dev-home"), defaultHome: DEFAULT });
    expect(v).toMatchObject({ role: "undeclared-dev", homeCategory: "custom" });
  });

  it("allows a declared stable-serving checkout on the default home; verdict is category-only", () => {
    declare({ role: "stable-serving", allowed_osstack_homes: ["~/.osstack"], schema: { min: 8, max: 8 } });
    const v = assertServeAllowed({ checkoutRoot: root, osstackHome: "~/.osstack" });
    expect(v.role).toBe("stable-serving");
    expect(v.homeCategory).toBe("default-stable");
    expect(v.schema).toEqual({ min: 8, max: 8 });
    expect(JSON.stringify(v)).not.toContain(root);
  });

  it("REFUSES a declared checkout serving a home outside its allowlist", () => {
    declare({ role: "candidate", allowed_osstack_homes: [join(root, "cand-home")] });
    try { assertServeAllowed({ checkoutRoot: root, osstackHome: DEFAULT, defaultHome: DEFAULT }); throw new Error("unreachable"); }
    catch (e) { expect((e as ControlPlaneGuardError).code).toBe("home_not_allowed"); }
  });

  it("refusal messages never echo the requested home path (no sensitive values)", () => {
    declare({ role: "candidate", allowed_osstack_homes: [join(root, "cand-home")] });
    try { assertServeAllowed({ checkoutRoot: root, osstackHome: "/very/secret/home", defaultHome: DEFAULT }); }
    catch (e) { expect((e as Error).message).not.toContain("/very/secret/home"); }
  });

  it("fails CLOSED on a malformed role file (bad JSON / bad shape)", () => {
    writeFileSync(join(root, "control-plane.json"), "{nope");
    expect(() => loadRoleFile(root)).toThrowError(/not valid JSON/);
    declare({ role: "boss", allowed_osstack_homes: [] });
    expect(() => loadRoleFile(root)).toThrowError(/must declare role/);
    declare({ role: "dev", allowed_osstack_homes: ["x"], schema: { min: 9, max: 8 } });
    expect(() => loadRoleFile(root)).toThrowError(/min <= max/);
  });
});

describe("guard hardening (review round 2)", () => {
  it("a SYMLINK alias to the default home is refused for an undeclared checkout (F2)", () => {
    const base = mkdtempSync(join(tmpdir(), "cpg2-"));
    const real = join(base, "stable-home"); const alias = join(base, "alias");
    mkdirSync(real);
    symlinkSync(real, alias);
    expect(() => assertServeAllowed({ checkoutRoot: root, osstackHome: alias, defaultHome: real }))
      .toThrowError(ControlPlaneGuardError);
    rmSync(base, { recursive: true, force: true });
  });

  it("a candidate/dev declaration listing the default home is still refused (F3 — role IS the boundary)", () => {
    declare({ role: "candidate", allowed_osstack_homes: [DEFAULT] });
    try { assertServeAllowed({ checkoutRoot: root, osstackHome: DEFAULT, defaultHome: DEFAULT }); throw new Error("unreachable"); }
    catch (e) { expect((e as ControlPlaneGuardError).code).toBe("home_not_allowed"); }
  });

  it("an ANCESTOR role file grants NOTHING — only the module's own dir counts (round-3 F1)", () => {
    const nested = join(root, "a", "b", "c");
    mkdirSync(nested, { recursive: true });
    declare({ role: "stable-serving", allowed_osstack_homes: [DEFAULT] }); // at root (ancestor)
    expect(() => assertServeAllowed({ checkoutRoot: nested, osstackHome: DEFAULT, defaultHome: DEFAULT }))
      .toThrowError(ControlPlaneGuardError);
  });

  it("distinct NONEXISTENT root-level homes do not canonicalize to the same path (round-3 F4)", () => {
    declare({ role: "dev", allowed_osstack_homes: ["/nonexistent-a/home"] });
    try { assertServeAllowed({ checkoutRoot: root, osstackHome: "/nonexistent-b/home", defaultHome: DEFAULT }); throw new Error("unreachable"); }
    catch (e) { expect((e as ControlPlaneGuardError).code).toBe("home_not_allowed"); }
  });
});

describe("home reservation (release-review F1)", () => {
  it("an UNDECLARED checkout cannot serve a RESERVED non-default home", () => {
    const home = join(root, "moved-stable-home");
    reserveHome(home);
    try { assertServeAllowed({ checkoutRoot: root, osstackHome: home, defaultHome: DEFAULT }); throw new Error("unreachable"); }
    catch (e) { expect((e as ControlPlaneGuardError).code).toBe("home_not_allowed"); }
  });

  it("a DECLARED role allowing the reserved home may serve it", () => {
    const home = join(root, "moved-stable-home");
    reserveHome(home);
    declare({ role: "stable-serving", allowed_osstack_homes: [home] });
    const v = assertServeAllowed({ checkoutRoot: root, osstackHome: home, defaultHome: DEFAULT });
    expect(v.role).toBe("stable-serving");
  });

  it("unreserved custom homes keep working for undeclared dev checkouts", () => {
    const v = assertServeAllowed({ checkoutRoot: root, osstackHome: join(root, "plain-dev-home"), defaultHome: DEFAULT });
    expect(v.role).toBe("undeclared-dev");
  });
});
