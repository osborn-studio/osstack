import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { z } from "zod";

const sha256 = z.string().regex(/^[a-f0-9]{64}$/);

export const DependencyObligationStateV2Core = z.enum([
  "candidate",
  "advisory",
  "promoted",
  "dismissed",
  "expired",
]);
export type DependencyObligationStateV2Core = z.infer<
  typeof DependencyObligationStateV2Core
>;

const obligationTransitions: Readonly<
  Partial<Record<DependencyObligationStateV2Core, ReadonlySet<DependencyObligationStateV2Core>>>
> = {
  candidate: new Set(["advisory", "dismissed", "expired"]),
  advisory: new Set(["promoted", "dismissed", "expired"]),
};

export const DependencyObligationEventV2Core = z.object({
  schema_version: z.literal("2"),
  event_id: z.string().regex(/^khoe_[a-f0-9]{64}$/),
  obligation_id: z.string().regex(/^kho_[a-f0-9]{64}$/),
  registry_scope: sha256,
  downstream_repo_id: z.string().min(1),
  revision: z.number().int().positive(),
  from_state: DependencyObligationStateV2Core.nullable(),
  to_state: DependencyObligationStateV2Core,
  snapshot_json: z.string().min(2),
  actor: z.string().trim().min(1),
  reason: z.string().trim().min(1),
  occurred_at: z.string().datetime(),
}).strict().superRefine((event, context) => {
  try {
    const snapshot = JSON.parse(event.snapshot_json) as Record<string, unknown>;
    if (
      snapshot["obligation_id"] !== event.obligation_id
      || snapshot["registry_scope"] !== event.registry_scope
      || snapshot["downstream_repo_id"] !== event.downstream_repo_id
      || snapshot["revision"] !== event.revision
      || snapshot["state"] !== event.to_state
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["snapshot_json"],
        message: "obligation snapshot does not match event metadata",
      });
    }
  } catch {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["snapshot_json"],
      message: "obligation snapshot must be valid JSON",
    });
  }
  if (event.from_state === null) {
    if (event.to_state !== "candidate" || event.revision !== 1) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "first obligation event must create candidate revision 1",
      });
    }
  } else if (!obligationTransitions[event.from_state]?.has(event.to_state)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["to_state"],
      message: "illegal dependency obligation transition",
    });
  }
});
export type DependencyObligationEventV2Core = z.infer<
  typeof DependencyObligationEventV2Core
>;

export interface DependencyObligationProjectionV2 {
  obligation_id: string;
  registry_scope: string;
  downstream_repo_id: string;
  revision: number;
  state: DependencyObligationStateV2Core;
  snapshot_json: string;
  last_event_id: string;
  updated_at: number;
}

export class DependencyObligationEventConflictErrorV2 extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DependencyObligationEventConflictErrorV2";
  }
}

export function registerDependencyRegistryScopeV2(
  db: Database.Database,
  input: { registry_scope: string; registry_path: string; updated_at: string },
): void {
  const scope = sha256.parse(input.registry_scope);
  if (!input.registry_path.startsWith("/")) {
    throw new Error("dependency registry path must be canonical and absolute");
  }
  const expected = createHash("sha256").update(input.registry_path).digest("hex");
  if (scope !== expected) throw new Error("dependency registry scope/path mismatch");
  const existing = db.prepare(`
    SELECT registry_path FROM dependency_registry_scopes WHERE registry_scope = ?
  `).get(scope) as { registry_path: string } | undefined;
  if (existing !== undefined && existing.registry_path !== input.registry_path) {
    throw new DependencyObligationEventConflictErrorV2(
      `registry scope collision: ${scope}`,
    );
  }
  db.prepare(`
    INSERT INTO dependency_registry_scopes (registry_scope, registry_path, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(registry_scope) DO UPDATE SET updated_at = excluded.updated_at
  `).run(scope, input.registry_path, Date.parse(input.updated_at));
}

export function getDependencyRegistryPathV2(
  db: Database.Database,
  registryScope: string,
): string | undefined {
  const row = db.prepare(`
    SELECT registry_path FROM dependency_registry_scopes WHERE registry_scope = ?
  `).get(sha256.parse(registryScope)) as { registry_path: string } | undefined;
  return row?.registry_path;
}

export function getDependencyObligationProjectionV2(
  db: Database.Database,
  id: string,
): DependencyObligationProjectionV2 | undefined {
  return db.prepare(`
    SELECT obligation_id, registry_scope, downstream_repo_id, revision,
           state, snapshot_json, last_event_id, updated_at
    FROM dependency_obligation_projection WHERE obligation_id = ?
  `).get(id) as DependencyObligationProjectionV2 | undefined;
}

export function listDependencyObligationInboxV2(
  db: Database.Database,
  input: { registry_scope: string; downstream_repo_id?: string },
): DependencyObligationProjectionV2[] {
  const registryScope = sha256.parse(input.registry_scope);
  return (input.downstream_repo_id === undefined
    ? db.prepare(`
        SELECT obligation_id, registry_scope, downstream_repo_id, revision,
               state, snapshot_json, last_event_id, updated_at
        FROM dependency_obligation_projection
        WHERE registry_scope = ? AND state IN ('candidate','advisory')
        ORDER BY updated_at, obligation_id
      `).all(registryScope)
    : db.prepare(`
        SELECT obligation_id, registry_scope, downstream_repo_id, revision,
               state, snapshot_json, last_event_id, updated_at
        FROM dependency_obligation_projection
        WHERE registry_scope = ? AND downstream_repo_id = ?
          AND state IN ('candidate','advisory')
        ORDER BY updated_at, obligation_id
      `).all(registryScope, input.downstream_repo_id)) as DependencyObligationProjectionV2[];
}

export function countOpenDependencyObligationsV2(
  db: Database.Database,
  registryScope: string,
): number {
  const row = db.prepare(`
    SELECT COUNT(*) AS count FROM dependency_obligation_projection
    WHERE registry_scope = ? AND state IN ('candidate','advisory')
  `).get(sha256.parse(registryScope)) as { count: number };
  return row.count;
}

export function appendDependencyObligationEventV2(
  db: Database.Database,
  rawEvent: DependencyObligationEventV2Core,
): { inserted: boolean; state: DependencyObligationStateV2Core } {
  const event = DependencyObligationEventV2Core.parse(rawEvent);
  const eventJson = JSON.stringify(event);
  return db.transaction(() => {
    const existing = db.prepare(`
      SELECT event_json, to_state FROM dependency_obligation_events WHERE event_id = ?
    `).get(event.event_id) as {
      event_json: string;
      to_state: DependencyObligationStateV2Core;
    } | undefined;
    if (existing !== undefined) {
      if (existing.event_json !== eventJson) {
        throw new DependencyObligationEventConflictErrorV2(
          `obligation event id collision: ${event.event_id}`,
        );
      }
      return { inserted: false, state: existing.to_state };
    }
    const projection = getDependencyObligationProjectionV2(db, event.obligation_id);
    if (projection === undefined) {
      if (event.from_state !== null) {
        throw new DependencyObligationEventConflictErrorV2(
          `obligation projection does not exist: ${event.obligation_id}`,
        );
      }
    } else if (
      projection.state !== event.from_state
      || event.revision !== projection.revision + 1
      || projection.registry_scope !== event.registry_scope
      || projection.downstream_repo_id !== event.downstream_repo_id
      || Date.parse(event.occurred_at) < projection.updated_at
    ) {
      throw new DependencyObligationEventConflictErrorV2(
        `stale obligation event: ${event.event_id}`,
      );
    }
    db.prepare(`
      INSERT INTO dependency_obligation_events (
        event_id, obligation_id, revision, from_state, to_state, event_json, occurred_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      event.event_id,
      event.obligation_id,
      event.revision,
      event.from_state,
      event.to_state,
      eventJson,
      Date.parse(event.occurred_at),
    );
    db.prepare(`
      INSERT INTO dependency_obligation_projection (
        obligation_id, registry_scope, downstream_repo_id, revision, state,
        snapshot_json, last_event_id, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(obligation_id) DO UPDATE SET
        revision = excluded.revision,
        state = excluded.state,
        snapshot_json = excluded.snapshot_json,
        last_event_id = excluded.last_event_id,
        updated_at = excluded.updated_at
    `).run(
      event.obligation_id,
      event.registry_scope,
      event.downstream_repo_id,
      event.revision,
      event.to_state,
      event.snapshot_json,
      event.event_id,
      Date.parse(event.occurred_at),
    );
    return { inserted: true, state: event.to_state };
  }).immediate();
}

export const DeclaredDependencyEdgeStateV2Core = z.enum([
  "confirmed",
  "review_due",
  "revoked",
]);
export type DeclaredDependencyEdgeStateV2Core = z.infer<
  typeof DeclaredDependencyEdgeStateV2Core
>;

const edgeTransitions: Readonly<
  Partial<Record<DeclaredDependencyEdgeStateV2Core, ReadonlySet<DeclaredDependencyEdgeStateV2Core>>>
> = {
  confirmed: new Set(["confirmed", "review_due", "revoked"]),
  review_due: new Set(["confirmed", "revoked"]),
  revoked: new Set(["confirmed"]),
};

export const DeclaredDependencyEdgeEventV2Core = z.object({
  schema_version: z.literal("2"),
  event_id: z.string().regex(/^khee_[a-f0-9]{64}$/),
  edge_id: z.string().regex(/^khe_[a-f0-9]{64}$/),
  registry_scope: sha256,
  downstream_repo_id: z.string().min(1),
  revision: z.number().int().positive(),
  from_state: DeclaredDependencyEdgeStateV2Core.nullable(),
  to_state: DeclaredDependencyEdgeStateV2Core,
  source_config_sha256: sha256,
  edge_json: z.string().min(2),
  actor: z.string().trim().min(1),
  reason: z.string().trim().min(1),
  occurred_at: z.string().datetime(),
}).strict().superRefine((event, context) => {
  try {
    const edge = JSON.parse(event.edge_json) as Record<string, unknown>;
    if (edge["edge_id"] !== event.edge_id) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["edge_json"],
        message: "declared edge snapshot does not match event metadata",
      });
    }
  } catch {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["edge_json"],
      message: "declared edge snapshot must be valid JSON",
    });
  }
  if (event.from_state === null) {
    if (event.to_state !== "confirmed" || event.revision !== 1) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "first declared edge event must confirm revision 1",
      });
    }
  } else if (!edgeTransitions[event.from_state]?.has(event.to_state)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["to_state"],
      message: "illegal declared dependency edge transition",
    });
  }
});
export type DeclaredDependencyEdgeEventV2Core = z.infer<
  typeof DeclaredDependencyEdgeEventV2Core
>;

export interface DeclaredDependencyEdgeProjectionV2 {
  edge_id: string;
  registry_scope: string;
  downstream_repo_id: string;
  revision: number;
  state: DeclaredDependencyEdgeStateV2Core;
  source_config_sha256: string;
  edge_json: string;
  last_event_id: string;
  updated_at: number;
}

export function getDeclaredDependencyEdgeProjectionV2(
  db: Database.Database,
  id: string,
): DeclaredDependencyEdgeProjectionV2 | undefined {
  return db.prepare(`
    SELECT edge_id, registry_scope, downstream_repo_id, revision, state,
           source_config_sha256, edge_json, last_event_id, updated_at
    FROM declared_dependency_edge_projection WHERE edge_id = ?
  `).get(id) as DeclaredDependencyEdgeProjectionV2 | undefined;
}

export function listDeclaredDependencyEdgeProjectionsV2(
  db: Database.Database,
  input: { registry_scope: string; downstream_repo_id?: string },
): DeclaredDependencyEdgeProjectionV2[] {
  const registryScope = sha256.parse(input.registry_scope);
  return (input.downstream_repo_id === undefined
    ? db.prepare(`
        SELECT edge_id, registry_scope, downstream_repo_id, revision, state,
               source_config_sha256, edge_json, last_event_id, updated_at
        FROM declared_dependency_edge_projection
        WHERE registry_scope = ?
        ORDER BY downstream_repo_id, edge_id
      `).all(registryScope)
    : db.prepare(`
        SELECT edge_id, registry_scope, downstream_repo_id, revision, state,
               source_config_sha256, edge_json, last_event_id, updated_at
        FROM declared_dependency_edge_projection
        WHERE registry_scope = ? AND downstream_repo_id = ?
        ORDER BY edge_id
      `).all(registryScope, input.downstream_repo_id)) as
    DeclaredDependencyEdgeProjectionV2[];
}

export function appendDeclaredDependencyEdgeEventV2(
  db: Database.Database,
  rawEvent: DeclaredDependencyEdgeEventV2Core,
): { inserted: boolean; state: DeclaredDependencyEdgeStateV2Core } {
  const event = DeclaredDependencyEdgeEventV2Core.parse(rawEvent);
  const eventJson = JSON.stringify(event);
  return db.transaction(() => {
    const existing = db.prepare(`
      SELECT event_json, to_state FROM declared_dependency_edge_events WHERE event_id = ?
    `).get(event.event_id) as {
      event_json: string;
      to_state: DeclaredDependencyEdgeStateV2Core;
    } | undefined;
    if (existing !== undefined) {
      if (existing.event_json !== eventJson) {
        throw new DependencyObligationEventConflictErrorV2(
          `declared edge event id collision: ${event.event_id}`,
        );
      }
      return { inserted: false, state: existing.to_state };
    }
    const projection = getDeclaredDependencyEdgeProjectionV2(db, event.edge_id);
    if (projection === undefined) {
      if (event.from_state !== null) {
        throw new DependencyObligationEventConflictErrorV2(
          `declared edge projection does not exist: ${event.edge_id}`,
        );
      }
    } else if (
      projection.state !== event.from_state
      || event.revision !== projection.revision + 1
      || projection.registry_scope !== event.registry_scope
      || projection.downstream_repo_id !== event.downstream_repo_id
      || Date.parse(event.occurred_at) < projection.updated_at
    ) {
      throw new DependencyObligationEventConflictErrorV2(
        `stale declared edge event: ${event.event_id}`,
      );
    }
    db.prepare(`
      INSERT INTO declared_dependency_edge_events (
        event_id, edge_id, revision, from_state, to_state, event_json, occurred_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      event.event_id,
      event.edge_id,
      event.revision,
      event.from_state,
      event.to_state,
      eventJson,
      Date.parse(event.occurred_at),
    );
    db.prepare(`
      INSERT INTO declared_dependency_edge_projection (
        edge_id, registry_scope, downstream_repo_id, revision, state,
        source_config_sha256, edge_json, last_event_id, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(edge_id) DO UPDATE SET
        revision = excluded.revision,
        state = excluded.state,
        source_config_sha256 = excluded.source_config_sha256,
        edge_json = excluded.edge_json,
        last_event_id = excluded.last_event_id,
        updated_at = excluded.updated_at
    `).run(
      event.edge_id,
      event.registry_scope,
      event.downstream_repo_id,
      event.revision,
      event.to_state,
      event.source_config_sha256,
      event.edge_json,
      event.event_id,
      Date.parse(event.occurred_at),
    );
    return { inserted: true, state: event.to_state };
  }).immediate();
}
