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
type LoopReadInput = { repo: string; path: string; loop_id: string; signal: AbortSignal };
export interface SupervisionOptions {
  loopReader?: (input: LoopReadInput) => Promise<unknown>;
  readTimeoutMs?: number;
}
type ReadFailure = "timeout" | "aborted" | "invalid_payload" | "read_failed" | "read_capacity_exceeded";
type LoopFacts = Record<string, unknown> & { state: string; reason?: string };
interface ReadSlot {
  controller: AbortController;
  logical: Promise<LoopFacts>;
}
interface LoopBinding {
  binding_hash: string;
  admitted: number;
  generation: number;
  payload_json: string;
}
function loopPayload(json: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(json);
    return value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown> : null;
  } catch { return null; }
}
function validLoopFacts(value: unknown, id: string): value is LoopFacts {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (v.loop_id !== id || typeof v.path !== "string" || v.process_liveness !== "unknown") return false;
  if (v.state === "source_missing") return v.coverage === "uncovered" && v.gap === "source_missing";
  return v.state === "snapshot_available" && v.coverage === "snapshot_only"
    && v.gap === "best_effort_snapshot_no_event_replay" && typeof v.updated_at === "string"
    && Array.isArray(v.in_progress) && Array.isArray(v.pending)
    && Number.isSafeInteger(v.completed_count) && (v.completed_count as number) >= 0
    && typeof v.recovery_required === "boolean";
}
/** The daemon has already acquired its kernel process lock before construction. */
export class SupervisionService {
  readonly store: AttentionStore;
  readonly observer: AttentionObserver;
  readonly experience: AttentionExperience;
  private delivering = false;
  private deliveryDone: Promise<void> | undefined;
  private ciReader: import("@osstack/github").AttentionCiReader | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private started = false;
  private stopped = false;
  private dirty = false;
  private scanDone: Promise<void> | undefined;
  private stopDone: Promise<void> | undefined;
  private epoch = 0;
  // A slot outlives its logical timeout until the underlying promise settles.
  // It holds no continuation that can access SQLite after stop.
  private readonly readers = new Map<string, ReadSlot>();
  private readonly logicalReads = new Set<Promise<LoopFacts>>();
  private readonly readTimeoutMs: number;
  constructor(
    db: Database.Database,
    path: string,
    readonly sender?: AttentionSender,
    private readonly options: SupervisionOptions = {}
  ) {
    this.readTimeoutMs = options.readTimeoutMs ?? 1000;
    if (!Number.isFinite(this.readTimeoutMs) || this.readTimeoutMs < 1 || this.readTimeoutMs > 1000)
      throw new Error("invalid_read_timeout");
    this.store = new AttentionStore(db, path);
    this.observer = new AttentionObserver(
      this.store,
      this.store.claimOwner(randomUUID())
    );
    this.experience = new AttentionExperience(this.store, this.observer.owner);
    this.experience.recoverDeliveries();
    new AttentionActions(this.store, this.observer.owner).recover();
  }
  private assertRunning(): void {
    if (this.stopped) throw new Error("supervision_stopped");
  }
  start(): void {
    this.assertRunning();
    if (this.started) return;
    this.started = true;
    void this.requestScan("start").catch(() => {});
    this.timer = setInterval(() => { void this.requestScan("timer").catch(() => {}); }, 30000);
    this.timer.unref();
  }
  /** Dirty signals are hints; each pass still reads the persisted source facts. */
  requestScan(_reason?: string): Promise<void> {
    if (this.stopped) return Promise.reject(new Error("supervision_stopped"));
    this.dirty = true;
    this.scanDone ??= Promise.resolve().then(async () => {
      while (this.dirty && !this.stopped) {
        this.dirty = false;
        try { await this.scan(); } catch { /* prior coverage expires */ }
      }
    }).finally(() => {
      this.scanDone = undefined;
      // A dirty signal can arrive after the loop exits but before this cleanup.
      if (this.dirty && !this.stopped) return this.requestScan("coalesced");
      return undefined;
    });
    return this.scanDone;
  }
  private async scan(): Promise<void> {
    this.assertRunning();
    this.observer.tick();
    const loops = this.store.db.prepare(
      "SELECT scope_id,subject_id,payload_json FROM attention_subjects WHERE kind='loop' AND admitted=1"
    ).all() as { scope_id: string; subject_id: string; payload_json: string }[];
    await Promise.allSettled(loops.map(async (row) => {
      let path: unknown;
      try { path = (JSON.parse(row.payload_json) as Record<string, unknown>).state_path; } catch { /* below */ }
      if (typeof path !== "string" || !path || path.length > 4096) {
        if (!this.stopped) this.store.write(this.observer.owner, () => {
          // Do not replace newer metadata or an explicit owner release.
          this.store.db.prepare("UPDATE attention_subjects SET sampled_at=?,payload_json=? WHERE scope_id=? AND kind='loop' AND subject_id=? AND payload_json=?")
            .run(Date.now(), JSON.stringify({ state: "unknown", reason: "invalid_payload", process_liveness: "unknown" }), row.scope_id, row.subject_id, row.payload_json);
        });
        return;
      }
      try {
        await this.handle("attention.loop", {
          scope_id: row.scope_id, loop_id: row.subject_id,
          state_path: path,
        });
      } catch { /* source errors never suppress other readers */ }
    }));
    if (this.stopped) return;
    for (const scope of this.store.listScopes()) this.experience.enqueue(scope.scope_id);
    if (this.sender && !this.delivering) {
      this.delivering = true;
      this.deliveryDone = this.experience.drain(this.sender)
        .catch(() => { /* delivery state retained */ })
        .finally(() => { this.delivering = false; });
    }
  }
  stop(): Promise<void> {
    if (this.stopDone) return this.stopDone;
    this.stopped = true;
    this.epoch++;
    this.dirty = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    for (const slot of this.readers.values()) slot.controller.abort();
    this.stopDone = Promise.allSettled([this.scanDone, this.deliveryDone, ...this.logicalReads]).then(() => {});
    return this.stopDone;
  }
  private loopBinding(scope: string, id: string): LoopBinding | undefined {
    return this.store.db.prepare(
      "SELECT binding_hash,admitted,generation,payload_json FROM attention_subjects WHERE scope_id=? AND kind='loop' AND subject_id=?"
    ).get(scope, id) as LoopBinding | undefined;
  }
  private readLoop(scopeId: string, id: string, path: string): Promise<LoopFacts> {
    this.assertRunning();
    const epoch = this.epoch;
    const binding = attentionDigest([path, id]);
    const key = JSON.stringify([scopeId, "loop", id, binding]);
    const scope = this.store.getScope(scopeId)!;
    // Register the binding before IO, so release and competing RPCs see it.
    this.store.write(this.observer.owner, () => {
      this.assertRunning();
      const old = this.loopBinding(scopeId, id);
      if (old && old.binding_hash !== binding) throw new Error("loop_binding_conflict");
      if (old) {
        const payload = loopPayload(old.payload_json);
        if (!payload || payload.reason === "owner_released") return;
        const count = (this.store.db.prepare("SELECT COUNT(*) n FROM attention_subjects WHERE admitted=1").get() as { n: number }).n;
        if (old.generation !== this.observer.owner.generation || (!old.admitted && count < 100))
          this.store.db.prepare("UPDATE attention_subjects SET admitted=?,generation=?,sampled_at=0,payload_json=? WHERE scope_id=? AND kind='loop' AND subject_id=?")
            .run(old.admitted || count < 100 ? 1 : 0, this.observer.owner.generation,
              JSON.stringify({ ...payload, state: "unknown", reason: "read_pending" }), scopeId, id);
        return;
      }
      const count = (this.store.db.prepare("SELECT COUNT(*) n FROM attention_subjects WHERE admitted=1").get() as { n: number }).n;
      this.store.db.prepare(
        "INSERT INTO attention_subjects(scope_id,kind,subject_id,binding_hash,source_version,admitted,discovered_at,sampled_at,generation,payload_json) VALUES(?,'loop',?,?,0,?,?,?,?,?)"
      ).run(scopeId, id, binding, count < 100 ? 1 : 0, Date.now(), 0, this.observer.owner.generation,
        JSON.stringify({ state_path: path, state: "unknown", reason: count < 100 ? "read_pending" : "capacity_exceeded" }));
    });
    const old = this.loopBinding(scopeId, id)!;
    const failure = (reason: ReadFailure): LoopFacts => ({ loop_id: id, path, state: "unknown",
      process_liveness: "unknown", coverage: "uncovered", gap: "snapshot_unavailable", reason });
    const payload = loopPayload(old.payload_json);
    if (!payload) return Promise.resolve(failure("invalid_payload"));
    if (payload.reason === "owner_released")
      return Promise.resolve({ state: "unknown", reason: "owner_released" });
    const existing = this.readers.get(key);
    if (existing) return existing.logical;
    const commit = (facts: LoopFacts): LoopFacts => {
      // No await from the lifecycle check through the owner-fenced commit.
      if (this.stopped || epoch !== this.epoch) return facts;
      this.store.write(this.observer.owner, () => {
        const current = this.loopBinding(scopeId, id);
        const currentPayload = current ? loopPayload(current.payload_json) : null;
        if (!current || current.binding_hash !== binding || current.generation !== this.observer.owner.generation
          || current.admitted !== old.admitted || !currentPayload || currentPayload.reason === "owner_released") return;
        this.store.db.prepare(
          "UPDATE attention_subjects SET sampled_at=?,payload_json=? WHERE scope_id=? AND kind='loop' AND subject_id=?"
        ).run(Date.now(), JSON.stringify({ ...facts, state_path: path,
          reason: facts.reason ?? (!current.admitted ? "capacity_exceeded" : facts.state === "source_missing"
            ? "source_missing" : facts.recovery_required ? "recovery_required" : "snapshot_only") }), scopeId, id);
      });
      return facts;
    };
    if (!old.admitted || this.readers.size >= 100)
      return Promise.resolve(commit(failure("read_capacity_exceeded")));
    const controller = new AbortController();
    let reason: ReadFailure = "aborted";
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abortListener: (() => void) | undefined;
    const aborted = new Promise<LoopFacts>((resolve) => {
      abortListener = () => resolve(failure(reason));
      controller.signal.addEventListener("abort", abortListener, { once: true });
      timer = setTimeout(() => { reason = "timeout"; controller.abort(); }, this.readTimeoutMs);
    });
    const physical = Promise.resolve().then(async () => {
      controller.signal.throwIfAborted();
      const reader = this.options.loopReader ?? (await import("./attention-loop-source.js")).readAttentionLoop;
      controller.signal.throwIfAborted();
      return await reader({ repo: scope.repo_path, path, loop_id: id, signal: controller.signal });
    }).then((value) => validLoopFacts(value, id) ? value : failure("invalid_payload"), (error: unknown) =>
      failure(controller.signal.aborted ? reason : error instanceof SyntaxError
        || (error instanceof Error && error.name === "ZodError") ? "invalid_payload" : "read_failed"));
    // Physical settlement has no DB access, even if the logical deadline passed.
    const settled = physical.finally(() => { this.readers.delete(key); });
    const logical = Promise.race([settled, aborted]).then(commit).finally(() => {
      if (timer) clearTimeout(timer);
      if (abortListener) controller.signal.removeEventListener("abort", abortListener);
      this.logicalReads.delete(logical);
    });
    this.readers.set(key, { controller, logical });
    this.logicalReads.add(logical);
    return logical;
  }
  async handle(method: string, params: unknown): Promise<unknown> {
    this.assertRunning();
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
      await this.requestScan("watch");
      this.assertRunning();
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
    if (method === "attention.loop")
      return await this.readLoop(scopeId, str("loop_id"), str("state_path"));
    if (method === "attention.ci") {
      const { AttentionCiReader } = await import("@osstack/github");
      this.assertRunning();
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
