import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { runMigrations } from "./db.js";
import {
  appendDependencyObligationEventV2,
  appendDeclaredDependencyEdgeEventV2,
  countOpenDependencyObligationsV2,
  getDependencyObligationProjectionV2,
  listDependencyObligationInboxV2,
} from "./dependency-obligation-store.js";

const sha = (character: string) => character.repeat(64);

function db(): Database.Database {
  const value = new Database(":memory:");
  value.pragma("foreign_keys = ON");
  runMigrations(value);
  return value;
}

describe("dependency obligation and declared edge event store", () => {
  it("records idempotent CAS obligation transitions and inbox counts", () => {
    const database = db();
    const created = {
      schema_version: "2" as const,
      event_id: `khoe_${sha("1")}`,
      obligation_id: `kho_${sha("2")}`,
      registry_scope: sha("3"),
      downstream_repo_id: "downstream",
      revision: 1,
      from_state: null,
      to_state: "candidate" as const,
      snapshot_json: JSON.stringify({
        obligation_id: `kho_${sha("2")}`,
        registry_scope: sha("3"),
        downstream_repo_id: "downstream",
        revision: 1,
        state: "candidate",
      }),
      actor: "system:scan",
      reason: "Deterministic candidate.",
      occurred_at: "2026-07-18T00:00:00.000Z",
    };
    expect(appendDependencyObligationEventV2(database, created).inserted).toBe(true);
    expect(appendDependencyObligationEventV2(database, created).inserted).toBe(false);
    expect(countOpenDependencyObligationsV2(database, sha("3"))).toBe(1);
    expect(listDependencyObligationInboxV2(database, {
      registry_scope: sha("3"),
      downstream_repo_id: "downstream",
    })).toHaveLength(1);

    const advisory = {
      ...created,
      event_id: `khoe_${sha("4")}`,
      revision: 2,
      from_state: "candidate" as const,
      to_state: "advisory" as const,
      snapshot_json: JSON.stringify({
        obligation_id: created.obligation_id,
        registry_scope: sha("3"),
        downstream_repo_id: "downstream",
        revision: 2,
        state: "advisory",
      }),
      occurred_at: "2026-07-18T00:01:00.000Z",
    };
    appendDependencyObligationEventV2(database, advisory);
    expect(getDependencyObligationProjectionV2(database, created.obligation_id))
      .toMatchObject({ state: "advisory", revision: 2 });
  });

  it("tracks declared edge projections with config hashes and revocation history", () => {
    const database = db();
    const confirmed = {
      schema_version: "2" as const,
      event_id: `khee_${sha("1")}`,
      edge_id: `khe_${sha("2")}`,
      registry_scope: sha("3"),
      downstream_repo_id: "downstream",
      revision: 1,
      from_state: null,
      to_state: "confirmed" as const,
      source_config_sha256: sha("4"),
      edge_json: JSON.stringify({ edge_id: `khe_${sha("2")}` }),
      actor: "owner",
      reason: "Confirmed dependency.",
      occurred_at: "2026-07-18T00:00:00.000Z",
    };
    appendDeclaredDependencyEdgeEventV2(database, confirmed);
    expect(() => appendDeclaredDependencyEdgeEventV2(database, {
      ...confirmed,
      event_id: `khee_${sha("5")}`,
      revision: 2,
      from_state: "confirmed",
      to_state: "revoked",
      source_config_sha256: sha("6"),
      occurred_at: "2026-07-18T00:01:00.000Z",
    })).not.toThrow();
  });
});
