import { expect, it } from "vitest";
import {
  checkLocalFailureRepairPaths,
  dispatchLocalFailureRepair,
  recoverLocalFailureDispatch,
  type LocalFailureDispatchPorts,
} from "./contained-mission-local-failure-dispatch.js";
import { diagnosisFixture, eligibleRequest } from "@osstack/core/dist/state/diagnosis-fixtures.js";
import { matchMissionProtectedPath, missionProtectedSetDigest } from "@osstack/governance";

function portsFor(f: ReturnType<typeof diagnosisFixture>): LocalFailureDispatchPorts {
  return {
    store: f.store,
    now: () => f.facts.now,
    worktreesRoot: f.root,
    keys: () =>
      new Map([
        [
          f.facts.grant.key_id,
          {
            public_key: f.keys.publicKey,
            key_id: f.facts.grant.key_id,
            max_validity_ms: 86400000,
          },
        ],
      ]),
    access: { refresh: () => f.principal },
    loadInstalledProfile: () => ({
      binding: f.facts.profile,
      profile: {
        checks: [{ check_id: "fixture-check" }],
        limits: { timeout_seconds: 20 },
      },
    }),
    launchCaps: { executor_seconds: 1, verify_seconds: 1 },
  };
}

it("preserves the base digest pinned by existing grants", () => {
  expect(missionProtectedSetDigest()).toBe("eb07aa03104fc42c9b259e5dc26f7a8a4d2ee0d9c3a1c8b4b7dc56fd2cd89ee1");
  expect(matchMissionProtectedPath(".github/workflows/ci.yml")).toContain("ci.github");
});

it("protects paths from the root verification scope", () => {
  expect(checkLocalFailureRepairPaths(["tools/check.ts"], ["tools/*.ts"])).toBe("verify_protected_path");
});

it.each([
  "src/a.test.ts",
  "skills/verify/SKILL.md",
  ".github/workflows/ci.yml",
  "verification-profiles/fixture.json",
  "**/*.test.ts",
  ".github/**",
])("refuses protected file %s", (path) => {
  expect(checkLocalFailureRepairPaths([path])).toBe("verify_protected_path");
  const f = diagnosisFixture({ allowedPaths: [path], protectedDigest: missionProtectedSetDigest() });
  try {
    const r = eligibleRequest(f);
    expect(dispatchLocalFailureRepair(portsFor(f), r.request_id)).toMatchObject({ reason: "verify_protected_path" });
    expect(f.store.receipt(r.receipt_id!).consumed_by).toBeNull();
  } finally {
    f.close();
  }
});
it("refreshes the live session under the lock and recovers without reauthorization", () => {
  const f = diagnosisFixture({
    allowedPaths: ["src/a.ts"],
    protectedDigest: missionProtectedSetDigest(),
  });
  try {
    const r = eligibleRequest(f);
    let revoked = true,
      calls = 0;
    const p = portsFor(f);
    p.access = {
      refresh: () => {
        expect(f.db.inTransaction).toBe(true);
        calls++;
        if (revoked) throw Error("revoked");
        return f.principal;
      },
    };
    expect(recoverLocalFailureDispatch(p, r.request_id)).toBeNull();
    expect(dispatchLocalFailureRepair(p, r.request_id)).toMatchObject({
      reason: "verify_grant_invalid",
    });
    revoked = false;
    const d = dispatchLocalFailureRepair(p, r.request_id);
    if (d.status !== "dispatched") throw Error(d.reason);
    expect(recoverLocalFailureDispatch(p, r.request_id)).toEqual(d);
    expect(dispatchLocalFailureRepair(p, r.request_id)).toEqual(d);
    expect(calls).toBe(2);
    const row = f.db
      .prepare("SELECT spec_json FROM engineering_contained_missions WHERE mission_id=?")
      .get(d.child_mission_id) as { spec_json: string };
    expect(JSON.parse(row.spec_json)).toMatchObject({
      start_commit: r.head_sha,
      publication: { preauthorized: false },
      local_failure_repair: {
        request_id: r.request_id,
        receipt_id: r.receipt_id,
      },
    });
    expect(row.spec_json).not.toContain("ci_repair");
  } finally {
    f.close();
  }
});

it.each([
  { locations: undefined },
  { locations: ["src/lib/a.ts"] },
])("dispatches within the root globs with locations $locations", ({ locations }) => {
  const allowed = ["src/**", "lib/*.ts"];
  const f = diagnosisFixture({ allowedPaths: allowed, protectedDigest: missionProtectedSetDigest() });
  try {
    const r = eligibleRequest(f);
    const result = dispatchLocalFailureRepair({ ...portsFor(f), ...(locations && { locations }) }, r.request_id);
    if (result.status !== "dispatched") throw Error(result.reason);
    const row = f.db
      .prepare("SELECT spec_json FROM engineering_contained_missions WHERE mission_id=?")
      .get(result.child_mission_id) as { spec_json: string };
    const spec = JSON.parse(row.spec_json);
    expect(spec.allowed_paths).toEqual(locations ?? allowed);
    for (const path of spec.allowed_paths) expect(spec.goal).toContain(JSON.stringify(path));
  } finally {
    f.close();
  }
});

it.each(["src-other/a.ts", "src/**", "src/../src/a.ts", "src/a.test.ts"])(
  "rolls back an unauthorized explicit location %s",
  (path) => {
    const f = diagnosisFixture({ allowedPaths: ["src/**"], protectedDigest: missionProtectedSetDigest() });
    try {
      const r = eligibleRequest(f);
      const snapshot = () =>
        [
          "contained_missions",
          "mission_lineage",
          "host_receipts",
          "revision_chains",
          "local_failure_dispatches",
          "diagnosis_requests",
          "local_failure_intakes",
        ].map((table) => f.db.prepare("SELECT * FROM engineering_" + table).all());
      const before = snapshot();
      expect(dispatchLocalFailureRepair({ ...portsFor(f), locations: [path] }, r.request_id)).toMatchObject({
        status: "refused",
        reason: "verify_protected_path",
      });
      expect(snapshot()).toEqual(before);
    } finally {
      f.close();
    }
  },
);
