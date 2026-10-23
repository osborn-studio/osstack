import { AttentionInbox } from "@osstack/protocol";
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import {
  AttentionStore,
  AttentionObserver,
  AttentionExperience,
  AttentionActions,
  attentionDigest,
  type AttentionSender,
} from "@osstack/core";
/** The daemon has already acquired its kernel process lock before construction. */
export class SupervisionService {
  readonly store: AttentionStore;
  readonly observer: AttentionObserver;
  readonly experience: AttentionExperience;
  private delivering = false;
  private deliveryDone: Promise<void> | undefined;
  private ciReader: import("@osstack/github").AttentionCiReader | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  constructor(
    db: Database.Database,
    path: string,
    readonly sender?: AttentionSender
  ) {
    this.store = new AttentionStore(db, path);
    this.observer = new AttentionObserver(
      this.store,
      this.store.claimOwner(randomUUID())
    );
    this.experience = new AttentionExperience(this.store, this.observer.owner);
    this.experience.recoverDeliveries();
    new AttentionActions(this.store, this.observer.owner).recover();
  }
  start(): void {
    this.scan();
    this.timer = setInterval(() => this.scan(), 30000);
    this.timer.unref();
  }
  private scan(): void {
    try {
      this.observer.tick();
      const loops = this.store.db
        .prepare(
          "SELECT scope_id,subject_id,payload_json FROM attention_subjects WHERE kind='loop' AND admitted=1"
        )
        .all() as {
        scope_id: string;
        subject_id: string;
        payload_json: string;
      }[];
      for (const row of loops) {
        const path = JSON.parse(row.payload_json).state_path;
        void this.handle("attention.loop", {
          scope_id: row.scope_id,
          loop_id: row.subject_id,
          state_path: path,
        }).catch(() => {
          /* previous sample expires */
        });
      }
      for (const scope of this.store.listScopes())
        this.experience.enqueue(scope.scope_id);
      if (this.sender && !this.delivering) {
        this.delivering = true;
        this.deliveryDone = this.experience
          .drain(this.sender)
          .catch(() => {
            /* delivery state retained */
          })
          .finally(() => {
            this.delivering = false;
          });
      }
    } catch {
      /* coverage expires even if timer is alive */
    }
  }
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.deliveryDone;
  }
  async handle(method: string, params: unknown): Promise<unknown> {
    if (!params || typeof params !== "object")
      throw new Error("explicit_scope_required");
    const p = params as Record<string, unknown>;
    const str = (key: string) => {
      const value = p[key];
      if (typeof value !== "string" || !value || value.length > 4096)
        throw new Error(`invalid_${key}`);
      return value;
    };
    if (method === "attention.watch") {
      if (p["default_tenant"] !== true)
        throw new Error("explicit_default_tenant_required");
      const scope = this.store.registerScope(
        this.observer.owner,
        str("task_id"),
        str("repo_path")
      );
      this.observer.tick();
      return this.observer.inventory(scope.scope_id);
    }
    const scopeId = str("scope_id");
    if (!this.store.getScope(scopeId)) throw new Error("not_found");
    if (method === "attention.release") {
      this.store.release(
        this.observer.owner,
        scopeId,
        str("kind"),
        str("subject_id"),
        Number(p["expected_version"])
      );
      return {
        released: true,
        execution_affected: false,
        coverage: "uncovered",
      };
    }
    if (method === "attention.loop") {
      const { readAttentionLoop } = await import("./attention-loop-source.js");
      const path = str("state_path");
      const id = str("loop_id");
      const facts = await readAttentionLoop({
        repo: this.store.getScope(scopeId)!.repo_path,
        path,
        loop_id: id,
      });
      this.store.write(this.observer.owner, () => {
        const binding = attentionDigest([path, id]);
        const old = this.store.db
          .prepare(
            "SELECT binding_hash,admitted,payload_json FROM attention_subjects WHERE scope_id=? AND kind='loop' AND subject_id=?"
          )
          .get(scopeId, id) as
          | { binding_hash: string; admitted: number; payload_json: string }
          | undefined;
        if (old && old.binding_hash !== binding)
          throw new Error("loop_binding_conflict");
        const count = (
          this.store.db
            .prepare(
              "SELECT COUNT(*) n FROM attention_subjects WHERE admitted=1"
            )
            .get() as { n: number }
        ).n;
        const released =
          old && JSON.parse(old.payload_json).reason === "owner_released";
        const admitted = released
          ? 0
          : old?.admitted === 1 || count < 100
          ? 1
          : 0;
        this.store.db
          .prepare(
            `INSERT INTO attention_subjects(scope_id,kind,subject_id,binding_hash,source_version,admitted,discovered_at,sampled_at,generation,payload_json) VALUES(?,'loop',?,?,0,?,?,?,?,?) ON CONFLICT(scope_id,kind,subject_id) DO UPDATE SET admitted=excluded.admitted,payload_json=excluded.payload_json,sampled_at=excluded.sampled_at,generation=excluded.generation`
          )
          .run(
            scopeId,
            id,
            binding,
            admitted,
            Date.now(),
            Date.now(),
            this.observer.owner.generation,
            JSON.stringify({
              ...facts,
              state_path: path,
              reason: released
                ? "owner_released"
                : !admitted
                ? "capacity_exceeded"
                : facts.state === "source_missing"
                ? "source_missing"
                : facts.recovery_required
                ? "recovery_required"
                : "snapshot_only",
            })
          );
      });
      return facts;
    }
    if (method === "attention.ci") {
      const { AttentionCiReader } = await import("@osstack/github");
      this.ciReader ??= new AttentionCiReader();
      return await this.ciReader.read({
        repo: str("github_repo"),
        pr: p["pr"],
        head: str("head"),
        required: p["required"],
      });
    }
    if (method === "attention.brief")
      return this.experience.brief(scopeId, str("actor"));
    if (method === "attention.posture") {
      const posture = str("posture");
      if (!["quiet", "away", "attended"].includes(posture))
        throw new Error("invalid_posture");
      this.experience.posture(
        scopeId,
        str("actor"),
        posture as "quiet" | "away" | "attended"
      );
      return { posture };
    }
    if (method === "attention.seen") {
      if (!Array.isArray(p["revisions"])) throw new Error("invalid_revisions");
      this.experience.seen(scopeId, str("actor"), p["revisions"]);
      return { marked: true };
    }
    if (method === "attention.foreground") {
      if (!Array.isArray(p["subjects"])) throw new Error("invalid_subjects");
      return this.experience.foreground(scopeId, p["subjects"]);
    }
    if (method === "attention.handoff")
      return this.experience.handoff(scopeId, str("client_id"), str("token"));
    if (method === "attention.turn-end")
      return this.experience.turnEnd(
        scopeId,
        str("client_id"),
        str("token"),
        str("role")
      );
    if (method === "attention.deliveries")
      return this.store.db
        .prepare(
          "SELECT * FROM attention_deliveries WHERE scope_id=? AND delivery_id>? ORDER BY delivery_id LIMIT 100"
        )
        .all(scopeId, typeof p["after"] === "string" ? p["after"] : "");
    if (method === "attention.inventory")
      return this.observer.inventory(
        scopeId,
        Date.now(),
        typeof p["after"] === "string" ? p["after"] : ""
      );
    if (method === "attention.inbox") {
      const items = this.store.listItems(
        scopeId,
        typeof p["after"] === "string" ? p["after"] : ""
      );
      const counts = this.store.db
        .prepare(
          "SELECT state,COUNT(*) total FROM attention_items WHERE scope_id=? GROUP BY state"
        )
        .all(scopeId);
      return AttentionInbox.parse({
        schema_version: 1,
        execution_takeover: false,
        scope_id: scopeId,
        items,
        counts,
        next_after: items.length === 100 ? items.at(-1)!.item_id : null,
        coverage: this.observer.inventory(scopeId).coverage,
      });
    }
    if (method === "attention.get") {
      const item = this.store.getItem(scopeId, str("item_id"));
      if (!item) throw new Error("not_found");
      return item;
    }
    throw new Error("unsupported_attention_method");
  }
}
