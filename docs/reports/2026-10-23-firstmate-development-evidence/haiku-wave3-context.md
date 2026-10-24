你是独立的 Haiku 5.5 挑战审计者。请对下列最终源码审计，不能调用工具，所有事实仅来自输入。重点复核上一轮的 P1：(1) subject 扫描后半段抛错时新发现的 history_gap 丢失；现用子事务 rollback 游标和投影，catch 留 invalid_source。(2) 非 ENOENT 来源错误拖住整个 discovery；现逐行隔离 source_error。(3) 全局容量永久耗尽；现在有显式带版本的 owner release，保留历史，释放后不自动准入，其他来源使用席位，整个 scope 仍 degraded；不静默驱逐是有意设计。(4) direct session.send 对 malformed structured decision fail-open；现 invalid_decision 拒绝，仅兼容旧 {question?, choices:string[]}。请检查这些修复是否真实有效及引入的新 P1。
边界：本地 owner CLI 和 Unix socket 是既有信任面，非多用户互联网 API；用户手动发送是既有权限，agent 标签不授予执行授权。这里不实现自动执行、自动审批或让 observer 调模型。global cap=100，主动 release 可以释放席位；不要求自动回收或自动恢复释放来源。notification retention/rate 与独立watchdog缺失为已记录 P2。不要将未提供其他模块当作肯定缺陷；明确条件性。输出中文，逐项结论，具体文件/函数/可复现触发，区分确认 P1、P2 和不能证明；不得仅为凑问题重复已修复发现。最后给出是否有剩余阻断项。测试代码只是待验证材料，不能凭审计宣称执行过。


--- FILE packages/core/src/state/attention-observer.ts ---
import { classifyAttentionWait, type WaitInput } from "../attention.js";
import { realpathSync } from "node:fs";
import {
  attentionDigest,
  AttentionStore,
  type AttentionOwner,
  type AttentionScope,
} from "./attention-store.js";
interface Subject {
  scope_id: string;
  kind: string;
  subject_id: string;
  binding_hash: string;
  source_version: number;
  ordinal_cursor: number;
  admitted: number;
  discovered_at: number;
  sampled_at: number;
  generation: number;
  payload_json: string;
}
interface Source {
  session_id: string;
  run_id: string;
  request_sha256: string;
  agent_id: string;
  native_session_id: string | null;
  repo_path: string;
  version: number;
  state: string;
}
interface Turn {
  turn_id: string;
  ordinal: number;
  decision_json: string | null;
  state: string;
}
/** Bounded synchronous transactions; no adapter, network, or model port. */
export class AttentionObserver {
  constructor(readonly store: AttentionStore, readonly owner: AttentionOwner) {}
  tick(now = Date.now()): void {
    if (!Number.isFinite(now)) throw new Error("invalid_clock");
    this.store.assertOwner(this.owner);
    for (const scope of this.store.listScopes()) {
      try {
        this.store.write(this.owner, () => this.scan(scope, now));
      } catch (error) {
        if (error instanceof Error && error.message === "stale_owner")
          throw error;
        this.store.write(this.owner, () =>
          this.store.db
            .prepare(
              "UPDATE attention_scopes SET error=?,scan_complete=0 WHERE scope_id=?"
            )
            .run(
              error instanceof Error
                ? error.message.slice(0, 300)
                : "source_error",
              scope.scope_id
            )
        );
      }
    }
  }
  private scan(scope: AttentionScope, now: number): void {
    const db = this.store.db;
    const task = db
      .prepare(
        "SELECT created_at FROM tasks WHERE task_id=? AND tenant_id IS NULL"
      )
      .get(scope.task_id) as { created_at: number } | undefined;
    if (
      !task ||
      attentionDigest([
        this.owner.home_id,
        scope.task_id,
        scope.repo_path,
        task.created_at,
      ]) !== scope.scope_id
    ) {
      db.prepare(
        "UPDATE attention_items SET state='source_missing',revision=revision+1 WHERE scope_id=? AND state='open'"
      ).run(scope.scope_id);
      db.prepare(
        "UPDATE attention_scopes SET error='source_missing',scan_complete=0 WHERE scope_id=?"
      ).run(scope.scope_id);
      return;
    }
    // A scan advances a durable keyset, then restarts from the beginning. New IDs
    // inserted behind the cursor are picked up on the next pass, never evicted.
    const rows = db
      .prepare(
        `SELECT '0:'||s.session_id AS key,s.session_id AS id,'session' AS kind FROM agent_sessions s JOIN runs r ON r.run_id=s.run_id AND r.task_id=s.task_id
      WHERE s.task_id=? AND r.tenant_id IS NULL AND '0:'||s.session_id>?
      UNION ALL SELECT '1:'||r.run_id,r.run_id,'run' FROM runs r WHERE r.task_id=? AND r.tenant_id IS NULL AND '1:'||r.run_id>? AND NOT EXISTS (SELECT 1 FROM agent_sessions s WHERE s.run_id=r.run_id AND s.task_id=r.task_id)
      ORDER BY key LIMIT 250`
      )
      .all(
        scope.task_id,
        scope.discovery_after,
        scope.task_id,
        scope.discovery_after
      ) as { key: string; id: string; kind: string }[];
    for (const row of rows) {
      if (
        db
          .prepare(
            "SELECT 1 FROM attention_subjects WHERE scope_id=? AND kind=? AND subject_id=? AND admitted=1"
          )
          .get(scope.scope_id, row.kind, row.id)
      )
        continue;
      const count = (
        db
          .prepare("SELECT COUNT(*) n FROM attention_subjects WHERE admitted=1")
          .get() as { n: number }
      ).n;
      const prior = db
        .prepare(
          "SELECT payload_json FROM attention_subjects WHERE scope_id=? AND kind=? AND subject_id=?"
        )
        .get(scope.scope_id, row.kind, row.id) as
        | { payload_json: string }
        | undefined;
      if (prior) {
        try {
          if (JSON.parse(prior.payload_json).reason === "owner_released")
            continue;
        } catch {
          /* Rebuild corrupt observation metadata from its source. */
        }
      }
      let source: Source | undefined;
      let sourceError = false;
      try {
        source =
          row.kind === "session" ? this.source(scope, row.id) : undefined;
      } catch {
        sourceError = true;
      }
      const bound = row.kind === "run" || source !== undefined;
      const admitted = bound && count < 100 ? 1 : 0;
      db.prepare(
        `INSERT INTO attention_subjects(scope_id,kind,subject_id,binding_hash,source_version,admitted,discovered_at,sampled_at,generation,payload_json) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(scope_id,kind,subject_id) DO UPDATE SET
        admitted=excluded.admitted,binding_hash=excluded.binding_hash,source_version=excluded.source_version,sampled_at=excluded.sampled_at,generation=excluded.generation,payload_json=excluded.payload_json`
      ).run(
        scope.scope_id,
        row.kind,
        row.id,
        source
          ? this.binding(source)
          : attentionDigest([scope.scope_id, row.kind, row.id]),
        source?.version ?? 0,
        admitted,
        now,
        now,
        this.owner.generation,
        JSON.stringify({
          state: source?.state ?? "unknown",
          awaiting_decision: source?.state === "awaiting_decision",
          reason: sourceError
            ? "source_error"
            : !bound
            ? "binding_unknown"
            : !admitted
            ? "capacity_exceeded"
            : "snapshot_only",
          unresolved_receipts: source ? this.receipts(source.session_id) : [],
        })
      );
    }
    const subjects = db
      .prepare(
        "SELECT * FROM attention_subjects WHERE scope_id=? AND admitted=1 ORDER BY kind,subject_id"
      )
      .all(scope.scope_id) as Subject[];
    for (const subject of subjects) {
      try {
        db.transaction(() => {
          if (subject.kind === "run") {
            const run = db
              .prepare(
                "SELECT phase,outcome FROM runs WHERE run_id=? AND task_id=? AND tenant_id IS NULL"
              )
              .get(subject.subject_id, scope.task_id);
            this.update(subject, now, {
              state: run ?? "source_missing",
              repo_binding: "unverified",
              process_liveness: "unknown",
              gap: "snapshot_only",
            });
            return;
          }
          if (subject.kind !== "session") return;
          const source = this.source(scope, subject.subject_id);
          if (!source) {
            this.store.markMissing(
              this.owner,
              scope.scope_id,
              subject.subject_id
            );
            this.update(subject, now, {
              state: "source_missing",
              reason: "source_missing",
            });
            return;
          }
          if (
            this.binding(source) !== subject.binding_hash ||
            source.version < subject.source_version
          ) {
            this.update(subject, now, {
              state: source.state,
              reason: "source_binding_conflict",
            });
            return;
          }
          const turns = db
            .prepare(
              "SELECT turn_id,ordinal,state,decision_json FROM session_turns WHERE session_id=? AND ordinal>? ORDER BY ordinal LIMIT 50"
            )
            .all(source.session_id, subject.ordinal_cursor) as Turn[];
          const latest = db
            .prepare(
              "SELECT turn_id,ordinal,state,decision_json FROM session_turns WHERE session_id=? ORDER BY ordinal DESC LIMIT 1"
            )
            .get(source.session_id) as Turn | undefined;
          let cursor = subject.ordinal_cursor;
          let gap =
            JSON.parse(subject.payload_json).gap === "history_gap" ||
            (latest?.ordinal ?? 0) < cursor;
          for (const turn of turns) {
            if (turn.ordinal !== cursor + 1) gap = true;
            try {
              this.project(scope, source, turn, now);
            } catch {
              gap = true;
            }
            cursor = turn.ordinal;
          }
          if (latest && latest.ordinal <= cursor) {
            try {
              this.project(scope, source, latest, now);
            } catch {
              gap = true;
            }
          }
          const backlogged = latest !== undefined && latest.ordinal > cursor;
          db.prepare(
            "UPDATE attention_subjects SET source_version=?,ordinal_cursor=? WHERE scope_id=? AND kind=? AND subject_id=?"
          ).run(
            source.version,
            cursor,
            scope.scope_id,
            subject.kind,
            subject.subject_id
          );
          const unresolved = this.receipts(source.session_id);
          if (["completed", "failed", "cancelled"].includes(source.state))
            db.prepare(
              "UPDATE attention_items SET state='source_closed',revision=revision+1 WHERE scope_id=? AND session_id=? AND state='open'"
            ).run(scope.scope_id, source.session_id);
          // Only an applied receipt referencing this exact origin turn establishes
          // external continuation. Authorization/risk obligations remain unresolved.
          const items = (
            db
              .prepare(
                "SELECT item_id FROM attention_items WHERE scope_id=? AND session_id=? AND state='open'"
              )
              .all(scope.scope_id, source.session_id) as { item_id: string }[]
          )
            .map((r) => this.store.getItem(scope.scope_id, r.item_id)!)
            .filter(
              (i) =>
                i.session_id === source.session_id &&
                i.state === "open" &&
                !["risk_approval", "task_authorization"].includes(
                  i.decision.continuation?.gate_kind ?? ""
                )
            );
          for (const item of items) {
            const applied = db
              .prepare(
                "SELECT message_id FROM session_messages WHERE session_id=? AND turn_id=? AND direction='inbound' AND state='applied' ORDER BY created_at,message_id LIMIT 1"
              )
              .get(source.session_id, item.turn_id) as
              | { message_id: string }
              | undefined;
            if (applied)
              db.prepare(
                "UPDATE attention_items SET state='continued_externally',external_message_id=?,revision=revision+1 WHERE item_id=?"
              ).run(applied.message_id, item.item_id);
          }
          this.update(subject, now, {
            state: source.state,
            awaiting_decision: source.state === "awaiting_decision",
            version: source.version,
            turn_id: latest?.turn_id ?? null,
            process_liveness: "unknown",
            gap: gap ? "history_gap" : "mutable_snapshot_no_complete_event_log",
            reason: backlogged ? "history_backlog" : null,
            unresolved_receipts: unresolved,
            wait: this.wait(source, latest?.turn_id ?? null, now),
          });
        })();
      } catch (error) {
        this.update(subject, now, {
          state: "unknown",
          reason: "invalid_source",
          detail:
            error instanceof Error
              ? error.message.slice(0, 120)
              : "invalid_source",
        });
      }
    }
    const complete = rows.length < 250;
    const undiscovered = db
      .prepare(
        `SELECT 1 FROM agent_sessions s JOIN runs r ON r.run_id=s.run_id AND r.task_id=s.task_id
      WHERE s.task_id=? AND r.tenant_id IS NULL AND NOT EXISTS(SELECT 1 FROM attention_subjects a WHERE a.scope_id=? AND a.kind='session' AND a.subject_id=s.session_id) LIMIT 1`
      )
      .get(scope.task_id, scope.scope_id);

    db.prepare(
      "UPDATE attention_scopes SET discovery_after=?,scan_complete=?,sampled_at=?,deadline=?,generation=?,error=NULL WHERE scope_id=?"
    ).run(
      complete ? "" : rows.at(-1)!.key,
      complete && !undiscovered ? 1 : 0,
      now,
      now + 65000,
      this.owner.generation,
      scope.scope_id
    );
  }
  private source(scope: AttentionScope, id: string): Source | undefined {
    const row = this.store.db
      .prepare(
        `SELECT s.* FROM agent_sessions s JOIN runs r ON r.run_id=s.run_id AND r.task_id=s.task_id JOIN tasks t ON t.task_id=s.task_id
      WHERE s.session_id=? AND s.task_id=? AND r.tenant_id IS NULL AND t.tenant_id IS NULL`
      )
      .get(id, scope.task_id) as Source | undefined;
    try {
      return row && realpathSync(row.repo_path) === scope.repo_path
        ? row
        : undefined;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }
  private binding(source: Source): string {
    return attentionDigest([
      source.session_id,
      source.run_id,
      source.request_sha256,
      source.agent_id,
      source.repo_path,
    ]);
  }
  private project(
    scope: AttentionScope,
    source: Source,
    turn: Turn,
    now: number
  ): void {
    if (turn.decision_json === null) return;
    if (turn.decision_json.length > 16384)
      throw new Error("oversized_decision");
    this.store.projectDecision(this.owner, {
      scopeId: scope.scope_id,
      sessionId: source.session_id,
      turnId: turn.turn_id,
      sourceVersion: source.version,
      decision: JSON.parse(turn.decision_json),
      now,
    });
  }
  private wait(source: Source, turnId: string | null, now: number) {
    const db = this.store.db;
    const input: WaitInput = {
      state: source.state,
      turnId,
      version: source.version,
      now,
    };
    const g = db
      .prepare(
        "SELECT grant_id,status,expected_turn_id,expected_version,body_json FROM session_continuation_grants WHERE session_id=? AND status='active'"
      )
      .get(source.session_id) as
      | {
          grant_id: string;
          status: string;
          expected_turn_id: string;
          expected_version: number;
          body_json: string;
        }
      | undefined;
    try {
      if (g)
        input.grant = {
          id: g.grant_id,
          status: g.status,
          turnId: g.expected_turn_id,
          version: g.expected_version,
          expires: Date.parse(JSON.parse(g.body_json).expires_at),
        };
    } catch {
      return { reason: "grant_unreadable", owner: "unknown", blocked: true };
    }
    const attempt = db
      .prepare(
        "SELECT a.* FROM session_continuation_attempts a JOIN session_continuation_grants g ON a.grant_id=g.grant_id WHERE g.session_id=? AND a.status IN ('checking','reserved') ORDER BY a.created_at LIMIT 1"
      )
      .get(source.session_id) as
      | {
          status: string;
          source_turn_id: string;
          source_version: number;
          reservation_version: number | null;
          message_id: string | null;
        }
      | undefined;
    if (attempt)
      input.attempt = {
        state: attempt.status,
        sourceTurn: attempt.source_turn_id,
        sourceVersion: attempt.source_version,
        ...(attempt.reservation_version === null
          ? {}
          : { reservationVersion: attempt.reservation_version }),
        ...(attempt.message_id === null
          ? {}
          : { messageId: attempt.message_id }),
      };
    const message = db
      .prepare(
        "SELECT message_id,state FROM session_messages WHERE session_id=? AND direction='inbound' AND state IN ('accepted','failed') AND message_id NOT IN (SELECT message_id FROM attention_receipt_resolutions) ORDER BY CASE state WHEN 'accepted' THEN 0 ELSE 1 END,created_at LIMIT 1"
      )
      .get(source.session_id) as
      | { message_id: string; state: string }
      | undefined;
    if (message)
      input.message = { id: message.message_id, state: message.state };
    return {
      ...classifyAttentionWait(input),
      grant_id: g?.grant_id ?? null,
      message_id: message?.message_id ?? null,
    };
  }
  private receipts(id: string): unknown[] {
    return this.store.db
      .prepare(
        "SELECT message_id,state FROM session_messages WHERE session_id=? AND direction='inbound' AND state IN ('accepted','failed') AND message_id NOT IN (SELECT message_id FROM attention_receipt_resolutions) ORDER BY created_at LIMIT 10"
      )
      .all(id);
  }
  private update(s: Subject, now: number, payload: unknown): void {
    let old: { gap?: string } = {};
    try {
      old = JSON.parse(s.payload_json) as { gap?: string };
    } catch {
      old = { gap: "history_gap" };
    }
    if (old.gap === "history_gap" && payload && typeof payload === "object")
      payload = { ...payload, gap: "history_gap" };
    this.store.db
      .prepare(
        "UPDATE attention_subjects SET sampled_at=?,generation=?,payload_json=? WHERE scope_id=? AND kind=? AND subject_id=?"
      )
      .run(
        now,
        this.owner.generation,
        JSON.stringify(payload),
        s.scope_id,
        s.kind,
        s.subject_id
      );
  }
  inventory(scopeId: string, now = Date.now(), after = "", limit = 100) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw new Error("invalid_limit");
    const scope = this.store.getScope(scopeId);
    if (!scope) throw new Error("not_found");
    const db = this.store.db;
    const counts = db
      .prepare(
        "SELECT COUNT(*) total,COALESCE(SUM(admitted),0) admitted FROM attention_subjects WHERE scope_id=?"
      )
      .get(scopeId) as { total: number; admitted: number };
    const rows = db
      .prepare(
        "SELECT * FROM attention_subjects WHERE scope_id=? AND kind||':'||subject_id>? ORDER BY kind,subject_id LIMIT ?"
      )
      .all(scopeId, after, limit + 1) as Subject[];
    const current = db
      .prepare("SELECT generation FROM daemon_owner WHERE singleton=1")
      .get() as { generation: number };
    const faulty = db
      .prepare(
        "SELECT 1 FROM attention_subjects WHERE scope_id=? AND (sampled_at<? OR generation<>? OR json_extract(payload_json,'$.reason') IS NOT NULL AND json_extract(payload_json,'$.reason')<>'snapshot_only' OR json_extract(payload_json,'$.gap')='history_gap') LIMIT 1"
      )
      .get(scopeId, now - 65000, current.generation);
    const coverage =
      now < scope.sampled_at
        ? "unknown"
        : scope.generation !== current.generation || now > scope.deadline
        ? "uncovered"
        : !scope.scan_complete ||
          scope.error ||
          counts.total > counts.admitted ||
          faulty
        ? "degraded"
        : "covered";
    return {
      scope,
      coverage,
      subject_total: counts.total,
      admitted: counts.admitted,
      returned: Math.min(limit, rows.length),
      truncated: rows.length > limit,
      next_after:
        rows.length > limit
          ? `${rows[limit - 1]!.kind}:${rows[limit - 1]!.subject_id}`
          : null,
      subjects: rows.slice(0, limit).map(({ payload_json, ...r }) => ({
        ...r,
        facts: JSON.parse(payload_json),
      })),
      limitations: [
        "No complete mutable-source history",
        "Process liveness unknown",
        "Coverage is observation, not execution ownership",
      ],
    };
  }
}


--- FILE packages/core/src/state/attention-observer.test.ts ---
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { openDb } from "./db.js";
import { AttentionStore } from "./attention-store.js";
import { AttentionObserver } from "./attention-observer.js";
const clean: Array<() => void> = [];
afterEach(() => clean.splice(0).forEach((fn) => fn()));
function setup(n = 1) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "observer-")));
  const path = join(root, "db");
  const db = openDb({ path });
  clean.push(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  db.exec(
    "INSERT INTO tasks(task_id,title,status,created_at,updated_at) VALUES('t','task','running',1,1); INSERT INTO runs(run_id,task_id,session_id,agent_id,capability_id,phase,started_at) VALUES('r','t','s','codex-cli','code','execute',1)"
  );
  for (let i = 0; i < n; i++) {
    const id = `s${i.toString().padStart(4, "0")}`;
    db.prepare(
      "INSERT INTO agent_sessions(session_id,task_id,run_id,agent_id,request_sha256,repo_path,state,resume_supported,version,updated_at) VALUES(?,'t','r','codex-cli','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',?,'awaiting_decision',1,1,1)"
    ).run(id, root);
    db.prepare(
      "INSERT INTO session_turns(turn_id,session_id,ordinal,state,decision_json,created_at,updated_at) VALUES(?,?,1,'awaiting_decision',?,1,1)"
    ).run(
      `turn${i}`,
      id,
      JSON.stringify({ decision_id: "d", question: "Choose?", choices: [] })
    );
  }
  const store = new AttentionStore(db, path);
  const owner = store.claimOwner("a");
  const scope = store.registerScope(owner, "t", root);
  const observer = new AttentionObserver(store, owner);
  return { db, store, owner, scope, observer };
}
it("discovers beyond 200 with bounded admission and never claims complete capacity", () => {
  const { observer, scope, db } = setup(220);
  observer.tick(1000);
  observer.tick(2000);
  const view = observer.inventory(scope.scope_id, 2000);
  expect(view.subject_total).toBe(220);
  expect(view.admitted).toBe(100);
  expect(view.coverage).toBe("degraded");
  expect(
    (
      db
        .prepare("SELECT COUNT(*) n FROM attention_subjects WHERE admitted=0")
        .get() as { n: number }
    ).n
  ).toBe(120);
});
it("projects historical turns atomically and discloses missing ordinal gaps", () => {
  const { observer, scope, db, store } = setup();
  observer.tick(1000);
  db.prepare(
    "INSERT INTO session_turns(turn_id,session_id,ordinal,state,decision_json,created_at,updated_at) VALUES('later','s0000',3,'awaiting_decision',?,1,1)"
  ).run(JSON.stringify({ decision_id: "d", question: "Next?", choices: [] }));
  observer.tick(2000);
  expect(store.listItems(scope.scope_id)).toHaveLength(2);
  expect(JSON.stringify(observer.inventory(scope.scope_id, 2000))).toContain(
    "history_gap"
  );
});
it("fences old generations, retains missing source, and expires coverage independently of business state", () => {
  const { observer, scope, db, store } = setup();
  observer.tick(1000);
  expect(observer.inventory(scope.scope_id, 100000).coverage).toBe("uncovered");
  db.exec("DELETE FROM session_turns; DELETE FROM agent_sessions");
  observer.tick(2000);
  expect(store.listItems(scope.scope_id)[0]?.state).toBe("source_missing");
  store.claimOwner("replacement");
  expect(() => observer.tick(3000)).toThrow("stale_owner");
});
it("isolates a poison decision to its subject instead of blinding a healthy session", () => {
  const { observer, scope, db, store } = setup(2);
  db.exec(
    "UPDATE session_turns SET decision_json='bad' WHERE session_id='s0000'"
  );
  observer.tick(1000);
  expect(store.listItems(scope.scope_id).map((i) => i.session_id)).toContain(
    "s0001"
  );
  expect(observer.inventory(scope.scope_id, 1000).coverage).toBe("degraded");
});
it("issues only observation handoff receipts and rejects gaps and stale foreground generations", async () => {
  const { AttentionExperience } = await import("./attention-experience.js");
  const { observer, scope, db, store, owner } = setup();
  observer.tick(1000);
  const ux = new AttentionExperience(store, owner);
  const fg = ux.foreground(
    scope.scope_id,
    [{ subject_id: "s0000", source_version: 1 }],
    1001
  );
  const receipt = ux.handoff(scope.scope_id, fg.client_id, fg.token, 1002);
  expect(receipt).toMatchObject({
    execution_takeover: false,
    process_liveness: "unknown",
    valid_until: 66000,
  });
  const fg2 = ux.foreground(
    scope.scope_id,
    [{ subject_id: "s0000", source_version: 1 }],
    1003
  );
  expect(
    ux.turnEnd(
      scope.scope_id,
      fg2.client_id,
      fg2.token,
      "foreground_owner",
      1004
    ).reminder
  ).not.toBeNull();
  expect(
    ux.turnEnd(
      scope.scope_id,
      fg2.client_id,
      fg2.token,
      "foreground_owner",
      1005
    ).reminder
  ).toBeNull();
  db.prepare(
    "UPDATE attention_subjects SET payload_json=json_set(payload_json,'$.gap','history_gap') WHERE kind='session'"
  ).run();
  expect(() =>
    ux.handoff(scope.scope_id, fg2.client_id, fg2.token, 1006)
  ).toThrow("coverage_not_ready");
  store.claimOwner("new");
  expect(() =>
    ux.turnEnd(
      scope.scope_id,
      fg2.client_id,
      fg2.token,
      "foreground_owner",
      1007
    )
  ).toThrow("stale_owner");
});
it("keeps gaps sticky across transient invalid observations and continues after corrupt turns", () => {
  const { observer, scope, db, store } = setup();
  observer.tick(1000);
  db.exec("UPDATE session_turns SET ordinal=3,decision_json='bad'");
  observer.tick(2000);
  db.prepare(
    "INSERT INTO session_turns(turn_id,session_id,ordinal,state,decision_json,created_at,updated_at) VALUES('healthy','s0000',4,'awaiting_decision',?,1,1)"
  ).run(
    JSON.stringify({
      decision_id: "new",
      question: "Healthy after poison",
      choices: [],
    })
  );
  observer.tick(3000);
  expect(
    store.listItems(scope.scope_id).some((i) => i.turn_id === "healthy")
  ).toBe(true);
  db.exec("UPDATE agent_sessions SET version=2");
  observer.tick(4000);
  expect(observer.inventory(scope.scope_id, 4000).coverage).toBe("degraded");
});
it("allows a once-only expired foreground reminder but never silently renews a handoff receipt", async () => {
  const { AttentionExperience } = await import("./attention-experience.js");
  const { observer, scope, store, owner } = setup();
  observer.tick(1000);
  const ux = new AttentionExperience(store, owner);
  const fg = ux.foreground(
    scope.scope_id,
    [{ subject_id: "s0000", source_version: 1 }],
    1001
  );
  const receipt = ux.handoff(scope.scope_id, fg.client_id, fg.token, 1002);
  observer.tick(5000);
  expect(
    ux.handoff(scope.scope_id, fg.client_id, fg.token, 6000)
  ).toMatchObject({ valid_until: receipt.valid_until });
  const other = ux.foreground(
    scope.scope_id,
    [{ subject_id: "s0000", source_version: 1 }],
    6001
  );
  expect(
    ux.turnEnd(
      scope.scope_id,
      other.client_id,
      other.token,
      "foreground_owner",
      200000
    )
  ).toMatchObject({ foreground_expired: true, continues: false });
});
it("isolates discovery filesystem errors and permits explicit slot release without silent eviction", () => {
  const { observer, scope, db, store, owner } = setup(2);
  db.prepare(
    "UPDATE agent_sessions SET repo_path=? WHERE session_id='s0000'"
  ).run(store.path + "/not-a-directory");
  observer.tick(1000);
  expect(
    store.listItems(scope.scope_id).some((i) => i.session_id === "s0001")
  ).toBe(true);
  expect(observer.inventory(scope.scope_id, 1000).coverage).toBe("degraded");
  store.release(owner, scope.scope_id, "session", "s0001", 1);
  observer.tick(2000);
  expect(
    (
      db
        .prepare(
          "SELECT admitted FROM attention_subjects WHERE subject_id='s0001'"
        )
        .get() as { admitted: number }
    ).admitted
  ).toBe(0);
});
it("rolls back a subject cursor when a late projection failure would otherwise erase a newly found gap", () => {
  const { observer, scope, db } = setup();
  observer.tick(1000);
  db.prepare(
    "INSERT INTO session_turns(turn_id,session_id,ordinal,state,decision_json,created_at,updated_at) VALUES('gap-turn','s0000',3,'awaiting_decision',?,1,1)"
  ).run(JSON.stringify({ decision_id: "next", question: "Next", choices: [] }));
  db.exec("UPDATE attention_items SET decision_json='bad'");
  observer.tick(2000);
  expect(
    (
      db
        .prepare(
          "SELECT ordinal_cursor FROM attention_subjects WHERE subject_id='s0000'"
        )
        .get() as { ordinal_cursor: number }
    ).ordinal_cursor
  ).toBe(1);
  db.prepare("UPDATE attention_items SET decision_json=?").run(
    JSON.stringify({ decision_id: "d", question: "Choose?", choices: [] })
  );
  observer.tick(3000);
  expect(observer.inventory(scope.scope_id, 3000).coverage).toBe("degraded");
});

it("reuses explicitly released capacity without silently evicting or readmitting its old owner", () => {
  const { observer, scope, store, owner, db } = setup(101);
  observer.tick(1000);
  store.release(owner, scope.scope_id, "session", "s0000", 1);
  observer.tick(2000);
  expect(
    db
      .prepare(
        "SELECT admitted FROM attention_subjects WHERE subject_id='s0100'"
      )
      .get()
  ).toEqual({ admitted: 1 });
  expect(
    db
      .prepare(
        "SELECT admitted FROM attention_subjects WHERE subject_id='s0000'"
      )
      .get()
  ).toEqual({ admitted: 0 });
  expect(observer.inventory(scope.scope_id, 2000).coverage).toBe("degraded");
  expect(
    store.listItems(scope.scope_id).some((item) => item.session_id === "s0000")
  ).toBe(true);
});


--- FILE packages/core/src/state/attention-store.ts ---
import { createHash, randomUUID } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import type Database from "better-sqlite3";
import { SessionDecision } from "@osstack/protocol";
import { withWrite } from "./db.js";

export function attentionDigest(value: unknown): string {
  const canonical = (v: unknown): string => {
    if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
    if (v !== null && typeof v === "object")
      return `{${Object.entries(v)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, x]) => `${JSON.stringify(k)}:${canonical(x)}`)
        .join(",")}}`;
    return JSON.stringify(v);
  };
  return createHash("sha256").update(canonical(value)).digest("hex");
}
export interface AttentionOwner {
  instance_id: string;
  generation: number;
  home_id: string;
}
export interface AttentionScope {
  scope_id: string;
  task_id: string;
  repo_path: string;
  discovery_after: string;
  scan_complete: number;
  sampled_at: number;
  deadline: number;
  generation: number;
  error: string | null;
}
export interface AttentionItem {
  item_id: string;
  scope_id: string;
  session_id: string;
  turn_id: string;
  decision_id: string;
  content_hash: string;
  decision: SessionDecision;
  source_version: number;
  revision: number;
  state: string;
  created_at: number;
  updated_at: number;
  external_message_id: string | null;
}
type ItemRow = Omit<AttentionItem, "decision"> & { decision_json: string };
function parseItem(row: ItemRow): AttentionItem {
  const { decision_json, ...rest } = row;
  return {
    ...rest,
    decision: SessionDecision.parse(JSON.parse(decision_json)),
  };
}
export class AttentionStore {
  constructor(readonly db: Database.Database, readonly path: string) {}
  /** Only called AFTER the daemon's process lock is acquired. Not an executor lease. */
  claimOwner(instanceId: string): AttentionOwner {
    return withWrite(this.db, this.path, () => {
      this.db
        .prepare(
          `INSERT INTO daemon_owner(singleton,home_id,instance_id,generation) VALUES(1,?,?,1)
        ON CONFLICT(singleton) DO UPDATE SET instance_id=excluded.instance_id,generation=generation+1`
        )
        .run(randomUUID(), instanceId);
      return this.db
        .prepare(
          "SELECT home_id,instance_id,generation FROM daemon_owner WHERE singleton=1"
        )
        .get() as AttentionOwner;
    });
  }
  assertOwner(owner: AttentionOwner): void {
    if (
      !this.db
        .prepare(
          "SELECT 1 FROM daemon_owner WHERE singleton=1 AND home_id=? AND instance_id=? AND generation=?"
        )
        .get(owner.home_id, owner.instance_id, owner.generation)
    )
      throw new Error("stale_owner");
  }
  write<T>(owner: AttentionOwner, fn: () => T): T {
    if (this.db.inTransaction) {
      this.assertOwner(owner);
      return fn();
    }
    return withWrite(this.db, this.path, () => {
      this.assertOwner(owner);
      return fn();
    });
  }
  registerScope(
    owner: AttentionOwner,
    taskId: string,
    repoPath: string
  ): AttentionScope {
    const canonicalRepo = realpathSync(repoPath);
    if (!statSync(canonicalRepo).isDirectory())
      throw new Error("repository_directory_required");
    return this.write(owner, () => {
      const task = this.db
        .prepare(
          "SELECT created_at FROM tasks WHERE task_id=? AND tenant_id IS NULL"
        )
        .get(taskId) as { created_at: number } | undefined;
      if (!task) throw new Error("not_found");
      if (
        (
          this.db.prepare("SELECT COUNT(*) n FROM attention_scopes").get() as {
            n: number;
          }
        ).n >= 100 &&
        !this.db
          .prepare(
            "SELECT 1 FROM attention_scopes WHERE task_id=? AND repo_path=?"
          )
          .get(taskId, canonicalRepo)
      )
        throw new Error("scope_capacity");
      const scopeId = attentionDigest([
        owner.home_id,
        taskId,
        canonicalRepo,
        task.created_at,
      ]);
      this.db
        .prepare(
          `INSERT INTO attention_scopes(scope_id,task_id,repo_path,generation) VALUES(?,?,?,?)
        ON CONFLICT(scope_id) DO NOTHING`
        )
        .run(scopeId, taskId, canonicalRepo, owner.generation);
      return this.getScope(scopeId)!;
    });
  }
  getScope(scopeId: string): AttentionScope | undefined {
    return this.db
      .prepare("SELECT * FROM attention_scopes WHERE scope_id=?")
      .get(scopeId) as AttentionScope | undefined;
  }
  listScopes(): AttentionScope[] {
    return this.db
      .prepare("SELECT * FROM attention_scopes ORDER BY scope_id")
      .all() as AttentionScope[];
  }
  getItem(scopeId: string, itemId: string): AttentionItem | undefined {
    const row = this.db
      .prepare("SELECT * FROM attention_items WHERE scope_id=? AND item_id=?")
      .get(scopeId, itemId) as ItemRow | undefined;
    return row ? parseItem(row) : undefined;
  }
  listItems(scopeId: string, after = "", limit = 100): AttentionItem[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw new Error("invalid_limit");
    return (
      this.db
        .prepare(
          "SELECT * FROM attention_items WHERE scope_id=? AND item_id>? ORDER BY item_id LIMIT ?"
        )
        .all(scopeId, after, limit) as ItemRow[]
    ).map(parseItem);
  }
  projectDecision(
    owner: AttentionOwner,
    input: {
      scopeId: string;
      sessionId: string;
      turnId: string;
      sourceVersion: number;
      decision: unknown;
      now: number;
    }
  ): AttentionItem {
    const decision = SessionDecision.parse(input.decision);
    const contentHash = attentionDigest(decision);
    const itemId = attentionDigest([
      input.scopeId,
      input.sessionId,
      input.turnId,
      decision.decision_id,
    ]);
    if (
      !Number.isSafeInteger(input.sourceVersion) ||
      input.sourceVersion < 1 ||
      !Number.isFinite(input.now)
    )
      throw new Error("invalid_source_version");
    return this.write(owner, () => {
      if (!this.getScope(input.scopeId)) throw new Error("not_found");
      const existing = this.getItem(input.scopeId, itemId);
      if (existing && existing.content_hash !== contentHash)
        throw new Error("decision_content_conflict");
      if (existing && existing.source_version > input.sourceVersion)
        throw new Error("stale_source");
      this.db
        .prepare(
          `INSERT INTO attention_items(item_id,scope_id,session_id,turn_id,decision_id,content_hash,decision_json,source_version,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(item_id) DO UPDATE SET
        revision=revision+CASE WHEN source_version<>excluded.source_version OR state='source_missing' THEN 1 ELSE 0 END,
        state=CASE WHEN state='source_missing' THEN 'open' ELSE state END,
        source_version=excluded.source_version,updated_at=excluded.updated_at`
        )
        .run(
          itemId,
          input.scopeId,
          input.sessionId,
          input.turnId,
          decision.decision_id,
          contentHash,
          JSON.stringify(decision),
          input.sourceVersion,
          input.now,
          input.now
        );
      return this.getItem(input.scopeId, itemId)!;
    });
  }
  release(
    owner: AttentionOwner,
    scopeId: string,
    kind: string,
    subjectId: string,
    expectedVersion: number
  ): void {
    if (!["session", "run", "loop"].includes(kind))
      throw new Error("invalid_subject_kind");
    this.write(owner, () => {
      const row = this.db
        .prepare(
          "SELECT payload_json,source_version FROM attention_subjects WHERE scope_id=? AND kind=? AND subject_id=?"
        )
        .get(scopeId, kind, subjectId) as
        | { payload_json: string; source_version: number }
        | undefined;
      if (!row || row.source_version !== expectedVersion)
        throw new Error("subject_version_conflict");
      this.db
        .prepare(
          "UPDATE attention_subjects SET admitted=0,payload_json=? WHERE scope_id=? AND kind=? AND subject_id=?"
        )
        .run(
          JSON.stringify({
            ...JSON.parse(row.payload_json),
            reason: "owner_released",
          }),
          scopeId,
          kind,
          subjectId
        );
    });
  }
  markMissing(owner: AttentionOwner, scopeId: string, sessionId: string): void {
    this.write(owner, () =>
      this.db
        .prepare(
          `UPDATE attention_items SET state='source_missing',revision=revision+1
      WHERE scope_id=? AND session_id=? AND state='open'`
        )
        .run(scopeId, sessionId)
    );
  }
}


--- FILE packages/core/src/state/attention-actions.ts ---
import { realpathSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { SessionDecision } from "@osstack/protocol";
import { withWrite } from "./db.js";
import { SessionRepository, type SessionMessageInput } from "./sessions.js";
import {
  AttentionStore,
  attentionDigest,
  type AttentionOwner,
} from "./attention-store.js";
/** Common human reservation, serialized with collaborator writes in the same DB. */
export function reserveSessionInstruction(
  db: Database.Database,
  path: string,
  message: SessionMessageInput,
  version: number,
  now: number,
  takeover = false,
  takeoverGrantId?: string
) {
  return withWrite(db, path, () => {
    const sessions = new SessionRepository(db, path);
    if (sessions.getMessage(message.message_id))
      return sessions.applyInbound(message, version, now);
    if (
      db
        .prepare(
          "SELECT 1 FROM session_messages WHERE session_id=? AND direction='inbound' AND state IN ('accepted','failed') AND message_id NOT IN (SELECT message_id FROM attention_receipt_resolutions) LIMIT 1"
        )
        .get(message.session_id)
    )
      throw new Error("delivery_uncertain");
    if (
      db
        .prepare(
          "SELECT 1 FROM session_continuation_attempts a JOIN session_continuation_grants g ON a.grant_id=g.grant_id WHERE g.session_id=? AND a.status IN ('checking','reserved') LIMIT 1"
        )
        .get(message.session_id)
    )
      throw new Error("continuation_in_flight");
    const grant = db
      .prepare(
        "SELECT grant_id FROM session_continuation_grants WHERE session_id=? AND status='active'"
      )
      .get(message.session_id) as { grant_id: string } | undefined;
    if (grant && takeover && takeoverGrantId !== grant.grant_id)
      throw new Error("takeover_grant_changed");
    if (grant && !takeover) throw new Error("grant_owned");
    const snapshot = sessions.latestSnapshot(message.session_id);
    const decision = SessionDecision.safeParse(snapshot.decision);
    const raw = snapshot.decision as Record<string, unknown> | null;
    const legacy =
      raw !== null &&
      typeof raw === "object" &&
      !Array.isArray(raw) &&
      Object.keys(raw).every((k) => ["question", "choices"].includes(k)) &&
      Array.isArray(raw["choices"]) &&
      raw["choices"].every((v) => typeof v === "string") &&
      (raw["question"] === undefined || typeof raw["question"] === "string");
    if (snapshot.decision !== null && !decision.success && !legacy)
      throw new Error("invalid_decision");

    if (
      decision.success &&
      ["risk_approval", "task_authorization"].includes(
        decision.data.continuation?.gate_kind ?? ""
      )
    )
      throw new Error("signed_approval_required");
    if (grant)
      db.prepare(
        "UPDATE session_continuation_grants SET status='blocked',reason='human_takeover',updated_at=? WHERE grant_id=?"
      ).run(now, grant.grant_id);
    return sessions.applyInbound(message, version, now);
  });
}
export interface AttentionAnswer {
  scope_id: string;
  item_id: string;
  action_id: string;
  revision: number;
  content_hash: string;
  text: string;
  takeover: boolean;
  takeover_grant_id?: string;
}
interface Action {
  action_id: string;
  scope_id: string;
  item_id: string;
  payload_hash: string;
  message_id: string;
  state: string;
  created_at: number;
  updated_at: number;
}
export class AttentionActions {
  constructor(readonly store: AttentionStore, readonly owner: AttentionOwner) {}
  reserve(input: AttentionAnswer, now = Date.now()) {
    if (
      !input.action_id ||
      input.action_id.length > 256 ||
      !input.text.trim() ||
      input.text.length > 16000
    )
      throw new Error("invalid_answer");
    return this.store.write(this.owner, () => {
      const db = this.store.db;
      const digest = attentionDigest(input);
      const prior = db
        .prepare("SELECT * FROM attention_actions WHERE action_id=?")
        .get(input.action_id) as Action | undefined;
      if (prior) {
        if (prior.payload_hash !== digest)
          throw new Error("action_id_conflict");
        return {
          ...this.reconcile(prior, now),
          replay: true,
          reservation_version: 0,
        };
      }
      const item = this.store.getItem(input.scope_id, input.item_id);
      const scope = this.store.getScope(input.scope_id);
      if (!item || !scope) throw new Error("not_found");
      if (
        item.state !== "open" ||
        item.revision !== input.revision ||
        item.content_hash !== input.content_hash
      )
        throw new Error("stale_item");
      if (
        db
          .prepare("SELECT 1 FROM attention_actions WHERE item_id=?")
          .get(item.item_id)
      )
        throw new Error("action_already_reserved");
      const repo = new SessionRepository(db, this.store.path);
      const source = repo.getSession(item.session_id);
      const latest = repo.latestSnapshot(item.session_id);
      if (source && source.state !== "awaiting_decision")
        throw new Error("session_not_awaiting_decision");
      if (
        !source ||
        source.task_id !== scope.task_id ||
        realpathSync(source.repo_path) !== scope.repo_path ||
        latest.turn_id !== item.turn_id ||
        source.version !== item.source_version ||
        attentionDigest(SessionDecision.parse(latest.decision)) !==
          item.content_hash
      )
        throw new Error("source_changed");
      if (
        !db
          .prepare(
            "SELECT 1 FROM tasks t JOIN runs r ON r.task_id=t.task_id WHERE t.task_id=? AND r.run_id=? AND t.tenant_id IS NULL AND r.tenant_id IS NULL"
          )
          .get(scope.task_id, source.run_id)
      )
        throw new Error("source_changed");
      const messageId = `attention-${randomUUID()}`;
      const reservation = reserveSessionInstruction(
        db,
        this.store.path,
        {
          message_id: messageId,
          session_id: item.session_id,
          turn_id: item.turn_id,
          direction: "inbound",
          kind: "instruction.send",
          payload: { text: input.text },
          state: "accepted",
          created_at: now / 1000,
        },
        source.version,
        now / 1000,
        input.takeover,
        input.takeover_grant_id
      );
      db.prepare(
        "INSERT INTO attention_actions VALUES(?,?,?,?,?,'reserved',?,?)"
      ).run(
        input.action_id,
        input.scope_id,
        input.item_id,
        digest,
        messageId,
        now,
        now
      );
      db.prepare(
        "UPDATE attention_items SET state='answer_reserved',revision=revision+1,updated_at=? WHERE item_id=?"
      ).run(now, item.item_id);
      return {
        action_id: input.action_id,
        scope_id: input.scope_id,
        item_id: input.item_id,
        payload_hash: digest,
        message_id: messageId,
        state: "reserved",
        created_at: now,
        updated_at: now,
        replay: false,
        reservation_version: reservation.session_version,
      };
    });
  }
  replay(input: AttentionAnswer, applyingMessageId?: string) {
    const prior = this.store.db
      .prepare("SELECT * FROM attention_actions WHERE action_id=?")
      .get(input.action_id) as Action | undefined;
    if (!prior) return undefined;
    if (prior.payload_hash !== attentionDigest(input))
      throw new Error("action_id_conflict");
    if (prior.message_id === applyingMessageId)
      return { ...prior, state: "in_flight", replay: true };
    return { ...this.reconcile(prior), replay: true };
  }
  abandon(
    input: {
      scope_id: string;
      session_id: string;
      message_id: string;
      expected_version: number;
      reason: string;
      evidence_sha256: string;
    },
    now = Date.now()
  ) {
    if (
      !input.reason ||
      input.reason.length > 1000 ||
      !/^[a-f0-9]{64}$/.test(input.evidence_sha256)
    )
      throw new Error("resolution_evidence_required");
    return this.store.write(this.owner, () => {
      const db = this.store.db;
      const session = new SessionRepository(db, this.store.path).getSession(
        input.session_id
      );
      if (!session || session.version !== input.expected_version)
        throw new Error("version_conflict");
      const scope = this.store.getScope(input.scope_id);
      if (
        !scope ||
        scope.task_id !== session.task_id ||
        scope.repo_path !== realpathSync(session.repo_path)
      )
        throw new Error("scope_mismatch");
      const message = db
        .prepare(
          "SELECT state FROM session_messages WHERE message_id=? AND session_id=? AND direction='inbound'"
        )
        .get(input.message_id, input.session_id) as
        | { state: string }
        | undefined;
      if (!message || !["accepted", "failed"].includes(message.state))
        throw new Error("receipt_not_uncertain");
      if (
        db
          .prepare(
            "SELECT 1 FROM session_continuation_attempts a JOIN session_continuation_grants g ON a.grant_id=g.grant_id WHERE g.session_id=? AND a.status IN ('checking','reserved')"
          )
          .get(input.session_id)
      )
        throw new Error("continuation_in_flight");
      const prior = db
        .prepare(
          "SELECT * FROM attention_receipt_resolutions WHERE message_id=?"
        )
        .get(input.message_id) as
        | { reason: string; evidence_sha256: string }
        | undefined;
      if (
        prior &&
        (prior.reason !== input.reason ||
          prior.evidence_sha256 !== input.evidence_sha256)
      )
        throw new Error("resolution_conflict");
      db.prepare(
        "INSERT OR IGNORE INTO attention_receipt_resolutions VALUES(?,?,?,'abandoned_unknown',?,?,?)"
      ).run(
        input.message_id,
        input.session_id,
        input.expected_version,
        input.reason,
        input.evidence_sha256,
        now
      );
      db.prepare(
        "UPDATE attention_actions SET state='abandoned_unknown',updated_at=? WHERE message_id=?"
      ).run(now, input.message_id);
      db.prepare(
        "UPDATE attention_items SET state='answer_abandoned',revision=revision+1,updated_at=? WHERE item_id IN (SELECT item_id FROM attention_actions WHERE message_id=?) AND state<>'answer_abandoned'"
      ).run(now, input.message_id);
      return {
        disposition: "abandoned_unknown",
        message_id: input.message_id,
        replayed: false,
        execution_outcome: "unknown",
        next_action:
          "New manual instruction only; original message is never resent",
      };
    });
  }
  recover(): void {
    const rows = this.store.db
      .prepare(
        "SELECT * FROM attention_actions WHERE state IN ('reserved','uncertain')"
      )
      .all() as Action[];
    for (const row of rows) this.reconcile(row);
  }
  reconcile(action: Action, now = Date.now()): Action {
    return this.store.write(this.owner, () => {
      if (
        this.store.db
          .prepare(
            "SELECT 1 FROM attention_receipt_resolutions WHERE message_id=?"
          )
          .get(action.message_id)
      )
        return { ...action, state: "abandoned_unknown" };
      const receipt = this.store.db
        .prepare("SELECT state FROM session_messages WHERE message_id=?")
        .get(action.message_id) as { state: string } | undefined;
      const state =
        receipt?.state === "applied"
          ? "applied"
          : receipt?.state === "failed"
          ? "uncertain"
          : "uncertain";
      this.store.db
        .prepare(
          "UPDATE attention_actions SET state=?,updated_at=? WHERE action_id=?"
        )
        .run(state, now, action.action_id);
      this.store.db
        .prepare(
          "UPDATE attention_items SET state=?,revision=revision+1,updated_at=? WHERE item_id=? AND state<>?"
        )
        .run(
          state === "applied" ? "answer_applied" : "answer_uncertain",
          now,
          action.item_id,
          state === "applied" ? "answer_applied" : "answer_uncertain"
        );
      return { ...action, state, updated_at: now };
    });
  }
}


--- FILE packages/core/src/state/attention-actions.test.ts ---
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { openDb } from "./db.js";
import { AttentionStore } from "./attention-store.js";
import {
  AttentionActions,
  reserveSessionInstruction,
} from "./attention-actions.js";
const cleanup: Array<() => void> = [];
afterEach(() => cleanup.splice(0).forEach((f) => f()));
function setup() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "actions-")));
  const path = join(root, "db");
  const db = openDb({ path });
  cleanup.push(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  db.exec(
    `INSERT INTO tasks(task_id,title,status,created_at,updated_at) VALUES('t','t','running',1,1); INSERT INTO runs(run_id,task_id,session_id,agent_id,capability_id,phase,started_at) VALUES('r','t','s','codex-cli','code','execute',1)`
  );
  db.prepare(
    `INSERT INTO agent_sessions(session_id,task_id,run_id,agent_id,request_sha256,repo_path,state,resume_supported,version,updated_at,native_session_id) VALUES('s','t','r','codex-cli',?,?,'awaiting_decision',1,1,1,'native')`
  ).run("a".repeat(64), root);
  const decision = { decision_id: "d", question: "Choose?", choices: [] };
  db.prepare(
    "INSERT INTO session_turns(turn_id,session_id,ordinal,state,decision_json,created_at,updated_at) VALUES('turn','s',1,'awaiting_decision',?,1,1)"
  ).run(JSON.stringify(decision));
  const store = new AttentionStore(db, path);
  const owner = store.claimOwner("a");
  const scope = store.registerScope(owner, "t", root);
  const item = store.projectDecision(owner, {
    scopeId: scope.scope_id,
    sessionId: "s",
    turnId: "turn",
    sourceVersion: 1,
    decision,
    now: 1,
  });
  const input = {
    scope_id: scope.scope_id,
    item_id: item.item_id,
    action_id: "a",
    revision: item.revision,
    content_hash: item.content_hash,
    text: "A",
    takeover: false,
  };
  return { db, path, input, actions: new AttentionActions(store, owner) };
}
it("reserves once, returns uncertainty on retry, and prevents replacement IDs after ambiguous delivery", () => {
  const { actions, input, db } = setup();
  const first = actions.reserve(input);
  const second = actions.reserve(input);
  expect(second.message_id).toBe(first.message_id);
  expect(second.state).toBe("uncertain");
  expect(() => actions.reserve({ ...input, action_id: "b" })).toThrow();
  expect(() => actions.reserve({ ...input, text: "B" })).toThrow(
    "action_id_conflict"
  );
  expect(
    (
      db.prepare("SELECT COUNT(*) n FROM session_messages").get() as {
        n: number;
      }
    ).n
  ).toBe(1);
});
it("reconciles an applied exact receipt without claiming task completion", () => {
  const { actions, input, db } = setup();
  const a = actions.reserve(input);
  db.prepare(
    "UPDATE session_messages SET state='applied' WHERE message_id=?"
  ).run(a.message_id);
  expect(actions.reserve(input).state).toBe("applied");
  expect(
    (
      db.prepare("SELECT status FROM tasks WHERE task_id='t'").get() as {
        status: string;
      }
    ).status
  ).toBe("running");
});
it("serializes a direct send against an inbox reservation", () => {
  const { actions, input, db, path } = setup();
  actions.reserve(input);
  expect(() =>
    reserveSessionInstruction(
      db,
      path,
      {
        message_id: "other",
        session_id: "s",
        turn_id: "turn",
        direction: "inbound",
        kind: "instruction.send",
        payload: { text: "B" },
        state: "accepted",
        created_at: 2,
      },
      2,
      2
    )
  ).toThrow("delivery_uncertain");
});
it("requires a signed approval route for risk gates", () => {
  const { actions, input, db } = setup();
  db.exec(
    `UPDATE session_turns SET decision_json='{"decision_id":"d","question":"Choose?","choices":[],"continuation":{"version":1,"gate_kind":"risk_approval","phase":"deploy","next_action":"deploy","evidence_refs":[]}}'`
  );
  expect(() => actions.reserve(input)).toThrow("source_changed");
  expect(db.prepare("SELECT 1 FROM attention_actions").get()).toBeUndefined();
});
it("refuses terminal session revival and recovers crash-window reservations", () => {
  const { actions, input, db } = setup();
  db.exec("UPDATE agent_sessions SET state='cancelled'");
  expect(() => actions.reserve(input)).toThrow("session_not_awaiting_decision");
  db.exec("UPDATE agent_sessions SET state='awaiting_decision'");
  actions.reserve(input);
  actions.recover();
  expect(
    (db.prepare("SELECT state FROM attention_items").get() as { state: string })
      .state
  ).toBe("answer_uncertain");
});
it("requires risk approval even when source digest is unchanged, and provides explicit abandonment without replay", () => {
  const { actions, input, db, path } = setup();
  db.prepare("UPDATE session_turns SET decision_json=?").run(
    JSON.stringify({
      decision_id: "d",
      question: "Deploy?",
      choices: [],
      continuation: {
        version: 1,
        gate_kind: "risk_approval",
        phase: "deploy",
        next_action: "deploy",
        evidence_refs: [],
      },
    })
  );
  expect(() =>
    reserveSessionInstruction(
      db,
      path,
      {
        message_id: "risk",
        session_id: "s",
        turn_id: "turn",
        direction: "inbound",
        kind: "instruction.send",
        payload: { text: "yes" },
        state: "accepted",
        created_at: 1,
      },
      1,
      1
    )
  ).toThrow("signed_approval_required");
  db.prepare("UPDATE session_turns SET decision_json=?").run(
    JSON.stringify({ decision_id: "d", question: "Choose?", choices: [] })
  );
  const reserved = actions.reserve(input);
  actions.recover();
  expect(
    actions.abandon({
      scope_id: input.scope_id,
      session_id: "s",
      message_id: reserved.message_id,
      expected_version: 2,
      reason:
        "Owner inspected uncertain effects; discard original instruction without replay",
      evidence_sha256: "a".repeat(64),
    })
  ).toMatchObject({ disposition: "abandoned_unknown", replayed: false });
  expect(actions.reserve(input).state).toBe("abandoned_unknown");
  expect(
    reserveSessionInstruction(
      db,
      path,
      {
        message_id: "new-manual",
        session_id: "s",
        turn_id: "turn",
        direction: "inbound",
        kind: "instruction.send",
        payload: { text: "Inspect current state only" },
        state: "accepted",
        created_at: 3,
      },
      2,
      3
    ).session_version
  ).toBe(3);
});
it("rejects malformed structured risk decisions on the direct manual path", () => {
  const { db, path } = setup();
  db.prepare("UPDATE session_turns SET decision_json=?").run(
    JSON.stringify({
      decision_id: "risk",
      choices: [],
      continuation: { gate_kind: "risk_approval" },
    })
  );
  expect(() =>
    reserveSessionInstruction(
      db,
      path,
      {
        message_id: "m",
        session_id: "s",
        turn_id: "turn",
        direction: "inbound",
        kind: "instruction.send",
        payload: { text: "yes" },
        state: "accepted",
        created_at: 1,
      },
      1,
      1
    )
  ).toThrow("invalid_decision");
  expect(db.prepare("SELECT 1 FROM session_messages").get()).toBeUndefined();
});


--- FILE packages/core/src/state/attention-experience.ts ---
import { AttentionObserver } from "./attention-observer.js";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import {
  AttentionStore,
  attentionDigest,
  type AttentionOwner,
} from "./attention-store.js";
interface Delivery {
  delivery_id: string;
  scope_id: string;
  item_id: string;
  revision: number;
  state: string;
  attempts: number;
  next_at: number;
  error: string | null;
}
export type AttentionSender = (
  message: {
    delivery_id: string;
    scope_id: string;
    item_id: string;
    question: string;
    state: string;
  },
  signal: AbortSignal
) => Promise<void>;
/** Local owner UX state; posture never changes any execution authority. */
export class AttentionExperience {
  constructor(readonly store: AttentionStore, readonly owner: AttentionOwner) {}
  posture(
    scope: string,
    actor: string,
    posture: "attended" | "quiet" | "away"
  ): void {
    this.actor(actor);
    if (!["attended", "quiet", "away"].includes(posture))
      throw new Error("invalid_posture");
    this.store.write(this.owner, () => {
      this.scope(scope);
      this.store.db
        .prepare(
          "INSERT INTO attention_postures VALUES(?,?,?) ON CONFLICT(scope_id,actor) DO UPDATE SET posture=excluded.posture"
        )
        .run(scope, actor, posture);
    });
  }
  brief(scope: string, actor: string) {
    this.actor(actor);
    this.scope(scope);
    const db = this.store.db;
    const items = db
      .prepare(
        `SELECT i.item_id,i.revision,i.state,i.decision_json,i.created_at FROM attention_items i LEFT JOIN attention_seen s ON s.scope_id=i.scope_id AND s.item_id=i.item_id AND s.actor=?
   WHERE i.scope_id=? AND COALESCE(s.revision,0)<i.revision ORDER BY CASE WHEN i.state LIKE '%uncertain%' THEN 0 WHEN json_extract(i.decision_json,'$.continuation.gate_kind') IN ('risk_approval','task_authorization') THEN 1 WHEN i.state='open' THEN 2 ELSE 3 END,i.created_at,i.item_id LIMIT 3`
      )
      .all(actor, scope) as {
      item_id: string;
      revision: number;
      state: string;
      decision_json: string;
      created_at: number;
    }[];
    const total = (
      db
        .prepare(
          `SELECT COUNT(*) n FROM attention_items i LEFT JOIN attention_seen s ON s.scope_id=i.scope_id AND s.item_id=i.item_id AND s.actor=? WHERE i.scope_id=? AND COALESCE(s.revision,0)<i.revision`
        )
        .get(actor, scope) as { n: number }
    ).n;
    const dead = (
      db
        .prepare(
          "SELECT COUNT(*) n FROM attention_deliveries WHERE scope_id=? AND state='dead_letter'"
        )
        .get(scope) as { n: number }
    ).n;
    return {
      scope_id: scope,
      actor,
      total,
      dead_letters: dead,
      items: items.map(({ decision_json, ...r }) => ({
        ...r,
        question: JSON.parse(decision_json).question,
      })),
      read_is_not_seen: true,
    };
  }
  seen(
    scope: string,
    actor: string,
    revisions: { item_id: string; revision: number }[]
  ): void {
    this.actor(actor);
    if (revisions.length > 100) throw new Error("too_many_items");
    this.store.write(this.owner, () => {
      this.scope(scope);
      for (const r of revisions) {
        const item = this.store.getItem(scope, r.item_id);
        if (!item || item.revision !== r.revision)
          throw new Error("stale_item");
        this.store.db
          .prepare(
            "INSERT INTO attention_seen VALUES(?,?,?,?) ON CONFLICT(scope_id,actor,item_id) DO UPDATE SET revision=MAX(revision,excluded.revision)"
          )
          .run(scope, actor, r.item_id, r.revision);
      }
    });
  }
  enqueue(scope: string): void {
    this.store.write(this.owner, () => {
      this.scope(scope);
      this.store.db
        .prepare(
          `INSERT OR IGNORE INTO attention_deliveries(delivery_id,scope_id,item_id,revision)
    SELECT item_id||':'||revision,scope_id,item_id,revision FROM attention_items WHERE scope_id=? AND state IN ('open','answer_uncertain','source_missing')`
        )
        .run(scope);
    });
  }
  recoverDeliveries(): void {
    this.store.write(this.owner, () =>
      this.store.db
        .prepare(
          "UPDATE attention_deliveries SET state=CASE WHEN attempts>=5 THEN 'dead_letter' ELSE 'pending' END,error='interrupted_delivery' WHERE state='sending'"
        )
        .run()
    );
  }
  async drain(
    sender: AttentionSender,
    now = Date.now(),
    timeoutMs = 5000
  ): Promise<void> {
    const db = this.store.db;
    const row = this.store.write(this.owner, () => {
      const d = db
        .prepare(
          `SELECT d.* FROM attention_deliveries d WHERE d.state='pending' AND d.next_at<=? AND NOT EXISTS(SELECT 1 FROM attention_postures p WHERE p.scope_id=d.scope_id AND p.posture='quiet') ORDER BY d.next_at,d.delivery_id LIMIT 1`
        )
        .get(now) as Delivery | undefined;
      if (d) {
        const item = this.store.getItem(d.scope_id, d.item_id);
        if (
          !item ||
          item.revision !== d.revision ||
          !["open", "answer_uncertain", "source_missing"].includes(item.state)
        ) {
          db.prepare(
            "UPDATE attention_deliveries SET state='superseded' WHERE delivery_id=?"
          ).run(d.delivery_id);
          return undefined;
        }
      }
      if (d)
        db.prepare(
          "UPDATE attention_deliveries SET state='sending',attempts=attempts+1 WHERE delivery_id=? AND state='pending'"
        ).run(d.delivery_id);
      return d;
    });
    if (!row) return;
    const item = this.store.getItem(row.scope_id, row.item_id);
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let error: string | null = null;
    try {
      if (!item) throw new Error("source_missing");
      await Promise.race([
        Promise.resolve().then(() =>
          sender(
            {
              delivery_id: row.delivery_id,
              scope_id: row.scope_id,
              item_id: row.item_id,
              question: item.decision.question,
              state: item.state,
            },
            controller.signal
          )
        ),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new Error("delivery_timeout"));
          }, timeoutMs);
        }),
      ]);
    } catch (e) {
      error =
        e instanceof Error && e.message === "delivery_timeout"
          ? "delivery_timeout"
          : "delivery_failed";
    } finally {
      if (timer) clearTimeout(timer);
    }
    this.store.write(this.owner, () =>
      db
        .prepare(
          "UPDATE attention_deliveries SET state=?,next_at=?,error=? WHERE delivery_id=? AND attempts=? AND state='sending'"
        )
        .run(
          error
            ? row.attempts + 1 >= 5
              ? "dead_letter"
              : "pending"
            : "delivered",
          now + Math.min(300000, 1000 * 2 ** row.attempts),
          error,
          row.delivery_id,
          row.attempts + 1
        )
    );
  }
  foreground(
    scope: string,
    subjects: { subject_id: string; source_version: number }[],
    now = Date.now()
  ) {
    if (
      !Array.isArray(subjects) ||
      subjects.length < 1 ||
      subjects.length > 100 ||
      new Set(subjects.map((s) => s.subject_id)).size !== subjects.length
    )
      throw new Error("invalid_subject_set");
    const token = randomBytes(32).toString("hex");
    const clientId = randomUUID();
    this.store.write(this.owner, () => {
      this.scope(scope);
      this.validateSubjects(scope, subjects);
      this.store.db
        .prepare(
          "INSERT INTO attention_foregrounds(client_id,token_hash,scope_id,generation,expires_at,subjects_json) VALUES(?,?,?,?,?,?)"
        )
        .run(
          clientId,
          attentionDigest(token),
          scope,
          this.owner.generation,
          now + 120000,
          JSON.stringify(subjects)
        );
    });
    return {
      client_id: clientId,
      token,
      expires_at: now + 120000,
      role: "foreground_owner",
    };
  }
  handoff(scope: string, client: string, token: string, now = Date.now()) {
    return this.store.write(this.owner, () => {
      const row = this.authenticate(scope, client, token, now);
      const prior = this.store.db
        .prepare("SELECT * FROM attention_handoffs WHERE client_id=?")
        .get(client);
      if (prior) {
        let currentlyValid =
          new AttentionObserver(this.store, this.owner).inventory(scope, now)
            .coverage === "covered";
        try {
          this.validateSubjects(scope, JSON.parse(row.subjects_json));
        } catch {
          currentlyValid = false;
        }
        return {
          ...prior,
          execution_takeover: false,
          process_liveness: "unknown",
          valid_until: (prior as { valid_until: number }).valid_until,
          expired: now > (prior as { valid_until: number }).valid_until,
          currently_valid:
            currentlyValid &&
            now <= (prior as { valid_until: number }).valid_until,
        };
      }
      const s = this.scope(scope);
      if (
        new AttentionObserver(this.store, this.owner).inventory(scope, now)
          .coverage !== "covered"
      )
        throw new Error("coverage_not_ready");
      if (
        !s.scan_complete ||
        s.generation !== this.owner.generation ||
        s.deadline < now ||
        s.sampled_at > now ||
        s.error ||
        this.store.db
          .prepare(
            "SELECT 1 FROM attention_subjects WHERE scope_id=? AND (admitted=0 OR sampled_at<?) LIMIT 1"
          )
          .get(scope, now - 65000)
      )
        throw new Error("coverage_not_ready");
      const subjects = JSON.parse(row.subjects_json) as {
        subject_id: string;
        source_version: number;
      }[];
      this.validateSubjects(scope, subjects);
      const receipt = {
        receipt_id: randomUUID(),
        client_id: client,
        scope_id: scope,
        generation: this.owner.generation,
        subjects_json: row.subjects_json,
        created_at: now,
        valid_until: s.deadline,
      };
      this.store.db
        .prepare("INSERT INTO attention_handoffs VALUES(?,?,?,?,?,?,?)")
        .run(
          receipt.receipt_id,
          client,
          scope,
          this.owner.generation,
          row.subjects_json,
          now,
          s.deadline
        );
      this.store.db
        .prepare(
          "UPDATE attention_foregrounds SET handed_off=1 WHERE client_id=?"
        )
        .run(client);
      return {
        ...receipt,
        execution_takeover: false,
        process_liveness: "unknown",
        valid_until: s.deadline,
      };
    });
  }
  turnEnd(
    scope: string,
    client: string,
    token: string,
    role: string,
    now = Date.now()
  ) {
    return this.store.write(this.owner, () => {
      if (role !== "foreground_owner") throw new Error("wrong_role");
      const row = this.authenticate(scope, client, token, now, true);
      if (row.reminder_sent || row.handed_off) return { reminder: null };
      this.store.db
        .prepare(
          "UPDATE attention_foregrounds SET reminder_sent=1 WHERE client_id=?"
        )
        .run(client);
      return {
        reminder:
          "Foreground ended. Check attention coverage and explicitly hand off unresolved work.",
        continues: false,
        offline_detection: false,
        foreground_expired: row.expires_at < now,
      };
    });
  }
  private authenticate(
    scope: string,
    client: string,
    token: string,
    now: number,
    allowExpired = false
  ) {
    const row = this.store.db
      .prepare(
        "SELECT * FROM attention_foregrounds WHERE client_id=? AND scope_id=?"
      )
      .get(client, scope) as
      | {
          token_hash: string;
          generation: number;
          expires_at: number;
          subjects_json: string;
          handed_off: number;
          reminder_sent: number;
        }
      | undefined;
    if (
      typeof token !== "string" ||
      token.length !== 64 ||
      !row ||
      !timingSafeEqual(
        Buffer.from(row.token_hash),
        Buffer.from(attentionDigest(token))
      ) ||
      row.generation !== this.owner.generation ||
      (!allowExpired && row.expires_at < now)
    )
      throw new Error("invalid_foreground");
    return row;
  }
  private validateSubjects(
    scope: string,
    subjects: { subject_id: string; source_version: number }[]
  ): void {
    for (const s of subjects) {
      const row = this.store.db
        .prepare(
          "SELECT source_version,admitted,payload_json FROM attention_subjects WHERE scope_id=? AND kind='session' AND subject_id=?"
        )
        .get(scope, s.subject_id) as
        | { source_version: number; admitted: number; payload_json: string }
        | undefined;
      const live = this.store.db
        .prepare("SELECT version FROM agent_sessions WHERE session_id=?")
        .get(s.subject_id) as { version: number } | undefined;
      if (
        !row ||
        row.admitted !== 1 ||
        row.source_version !== s.source_version ||
        live?.version !== s.source_version ||
        JSON.parse(row.payload_json).reason ||
        JSON.parse(row.payload_json).gap === "history_gap" ||
        (JSON.parse(row.payload_json).unresolved_receipts ?? []).length > 0
      )
        throw new Error("subject_not_covered");
    }
  }
  private scope(scope: string) {
    const s = this.store.getScope(scope);
    if (!s) throw new Error("not_found");
    return s;
  }
  private actor(actor: string): void {
    if (typeof actor !== "string" || actor.length < 1 || actor.length > 256)
      throw new Error("invalid_actor");
  }
}


--- FILE packages/cli/src/supervision-service.ts ---
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
            "SELECT binding_hash FROM attention_subjects WHERE scope_id=? AND kind='loop' AND subject_id=?"
          )
          .get(scopeId, id) as { binding_hash: string } | undefined;
        if (old && old.binding_hash !== binding)
          throw new Error("loop_binding_conflict");
        const count = (
          this.store.db
            .prepare(
              "SELECT COUNT(*) n FROM attention_subjects WHERE admitted=1"
            )
            .get() as { n: number }
        ).n;
        this.store.db
          .prepare(
            `INSERT INTO attention_subjects(scope_id,kind,subject_id,binding_hash,source_version,admitted,discovered_at,sampled_at,generation,payload_json) VALUES(?,'loop',?,?,0,?,?,?,?,?) ON CONFLICT(scope_id,kind,subject_id) DO UPDATE SET payload_json=excluded.payload_json,sampled_at=excluded.sampled_at,generation=excluded.generation`
          )
          .run(
            scopeId,
            id,
            binding,
            count < 100 ? 1 : 0,
            Date.now(),
            Date.now(),
            this.observer.owner.generation,
            JSON.stringify({
              ...facts,
              state_path: path,
              reason:
                facts.state === "source_missing"
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


--- FILE packages/cli/src/attention-command.ts ---
import { readAttentionStatus } from "./attention-read-model.js";

const HELP = `Usage: osstack attention status --db /absolute/state.db --task ID --repo /absolute/repo --default-tenant [--json] [--cursor TOKEN]
Read-only snapshot. No daemon is started and no database is migrated.
Live process state is unknown; this command does not establish background supervision.
Opt-in daemon: OSSTACK_ATTENTION=1 osstack serve
  attention watch --task ID --repo PATH --default-tenant
  attention inbox|inventory|deliveries --scope ID [--after ID] [--json]
  attention get --scope ID --item ID
  attention answer --scope ID --item ID --action ID --revision N --content-hash HASH --text TEXT [--takeover]
  attention brief|cockpit --scope ID --actor NAME
  attention posture --scope ID --actor NAME --posture attended|quiet|away
  attention seen --scope ID --actor NAME --revisions JSON
  attention foreground --scope ID --subjects JSON
  attention handoff --scope ID --client ID --token TOKEN
  attention turn-end --scope ID --client ID --token TOKEN --role foreground_owner
No daemon is automatically started. Hooks are explicit calls; no offline watchdog is installed.`;
export async function handleAttentionCommand(
  args: string[],
  io: {
    stdout?: (s: string) => void;
    stderr?: (s: string) => void;
    rpc?: (
      method: string,
      params?: unknown,
      timeoutMs?: number
    ) => Promise<unknown>;
  } = {}
): Promise<number> {
  const out = io.stdout ?? console.log;
  const err = io.stderr ?? console.error;
  if (args.includes("--help") || args[0] === "help") {
    out(HELP);
    return 0;
  }
  try {
    if (args[0] === "claude-hook") {
      if (!io.rpc) throw new Error("daemon_connection_required");
      const { handleClaudeAttentionHook } = await import("./attention-hook.js");
      return await handleClaudeAttentionHook(args, io.rpc, out);
    }
    if (
      ["contract", "routing-eval", "triage", "context", "lesson"].includes(
        args[0] ?? ""
      )
    ) {
      const { handleAttentionPlanning } = await import(
        "./attention-planning-command.js"
      );
      return await handleAttentionPlanning(args, out);
    }
    if (args[0] !== "status") return await handleLive(args, io);
    const values = new Map<string, string>();
    const flags = new Set<string>();
    for (let i = 1; i < args.length; i++) {
      const key = args[i]!;
      if (values.has(key) || flags.has(key))
        throw new Error(`duplicate_flag:${key}`);
      if (["--json", "--default-tenant"].includes(key)) {
        flags.add(key);
        continue;
      }
      if (
        ![
          "--db",
          "--task",
          "--repo",
          "--after-run",
          "--after-session",
          "--cursor",
        ].includes(key)
      )
        throw new Error(`unknown_flag:${key}`);
      const value = args[++i];
      if (!value || value.startsWith("--") || value.includes("\0"))
        throw new Error(`missing_value:${key}`);
      values.set(key, value);
    }
    const required = (key: string) => {
      const value = values.get(key);
      if (!value) throw new Error(`required:${key}`);
      return value;
    };
    if (!flags.has("--default-tenant"))
      throw new Error("explicit_default_tenant_required");
    const result = readAttentionStatus({
      dbPath: required("--db"),
      repoPath: required("--repo"),
      taskId: required("--task"),
      defaultTenant: true,
      ...(values.has("--cursor") ? { cursor: values.get("--cursor")! } : {}),
      ...(values.has("--after-run")
        ? { afterRun: values.get("--after-run")! }
        : {}),
      ...(values.has("--after-session")
        ? { afterSession: values.get("--after-session")! }
        : {}),
    });
    out(
      flags.has("--json")
        ? JSON.stringify(result, null, 2)
        : [
            "单次状态快照 · 未后台接管",
            `Task: ${JSON.stringify(result.scope.task_id)}`,
            ...result.sessions.map(
              (s) =>
                `${JSON.stringify(s.session_id)}: ${JSON.stringify(
                  s.state
                )} · ${JSON.stringify(s.wait.reason)}${
                  s.decision ? ` · ${JSON.stringify(s.decision.question)}` : ""
                }`
            ),
            `Runs: ${result.runs.length}; omitted: ${result.completeness.omitted_binding_unknown}; truncated: ${result.completeness.truncated}`,
            `Limitations: ${JSON.stringify(result.limitations)}`,
          ].join("\n")
    );
    return 0;
  } catch (error) {
    err(
      `osstack attention: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return 1;
  }
}

async function handleLive(
  args: string[],
  io: {
    stdout?: (s: string) => void;
    rpc?: (
      method: string,
      params?: unknown,
      timeoutMs?: number
    ) => Promise<unknown>;
  }
): Promise<number> {
  const command = args[0]!;
  const allowed = [
    "watch",
    "inventory",
    "inbox",
    "get",
    "answer",
    "brief",
    "posture",
    "seen",
    "foreground",
    "handoff",
    "turn-end",
    "deliveries",
    "cockpit",
    "abandon-receipt",
    "release",
    "loop",
    "ci",
  ];
  if (!allowed.includes(command)) throw new Error("unknown_attention_command");
  if (!io.rpc) throw new Error("daemon_connection_required");
  const params: Record<string, unknown> = {};
  let json = false;
  const keys = new Set([
    "task",
    "repo",
    "scope",
    "after",
    "item",
    "action",
    "revision",
    "content-hash",
    "text",
    "actor",
    "posture",
    "revisions",
    "subjects",
    "client",
    "token",
    "role",
    "state-path",
    "loop-id",
    "github-repo",
    "pr",
    "head",
    "required",
    "session",
    "kind",
    "subject",
    "message",
    "expected-version",
    "reason",
    "evidence-sha256",
    "grant",
  ]);
  for (let i = 1; i < args.length; i++) {
    const flag = args[i]!;
    if (flag === "--json") {
      json = true;
      continue;
    }
    if (flag === "--default-tenant") {
      params["default_tenant"] = true;
      continue;
    }
    if (flag === "--acknowledge-unknown-effects") {
      params["acknowledge_unknown_effects"] = true;
      continue;
    }
    if (flag === "--takeover") {
      params["takeover"] = true;
      continue;
    }
    const key = flag.slice(2);
    if (!flag.startsWith("--") || !keys.has(key))
      throw new Error("unknown_flag:" + flag);
    const value = args[++i];
    if (!value || value.startsWith("--"))
      throw new Error("missing_value:" + flag);
    const mapped: Record<string, string> = {
      task: "task_id",
      session: "session_id",
      subject: "subject_id",
      message: "message_id",
      "expected-version": "expected_version",
      "evidence-sha256": "evidence_sha256",
      repo: "repo_path",
      scope: "scope_id",
      item: "item_id",
      action: "action_id",
      client: "client_id",
      "content-hash": "content_hash",
      "state-path": "state_path",
      "loop-id": "loop_id",
      "github-repo": "github_repo",
      grant: "takeover_grant_id",
    };
    const name = mapped[key] ?? key;
    if (params[name] !== undefined) throw new Error("duplicate_flag:" + flag);
    params[name] = ["revision", "pr", "expected-version"].includes(key)
      ? Number(value)
      : ["revisions", "subjects", "required"].includes(key)
      ? JSON.parse(value)
      : value;
  }
  if (command === "answer") params["takeover"] ??= false;
  const call = async (method: string) => {
    const response = (await io.rpc!(method, params, 120000)) as {
      ok: boolean;
      result?: unknown;
      error?: { code?: string; message?: string };
    };
    if (!response.ok)
      throw new Error(
        response.error?.code ?? response.error?.message ?? "attention_failed"
      );
    return response.result;
  };
  const result =
    command === "cockpit"
      ? {
          inventory: await call("attention.inventory"),
          inbox: await call("attention.inbox"),
          brief: await call("attention.brief"),
          deliveries: await call("attention.deliveries"),
        }
      : await call("attention." + command);
  (io.stdout ?? console.log)(
    json
      ? JSON.stringify(result, null, 2)
      : `Attention · ${command}\n${JSON.stringify(
          result,
          null,
          2
        )}\nDelivered means transport receipt; applied means instruction receipt; neither means task completed.`
  );
  return 0;
}


--- FILE docs/guides/attention.md ---
# Attention：任务状态、决策收件箱与显式交接

Attention 将 Firstmate 的关注列表、结束提醒和交接体验接到 OSStack 已有的任务、会话和回执上。观察者不调用模型、不回答问题、不执行任务。执行仍走原来的会话适配器及审批边界。

## 启用范围

`attention status` 是独立只读入口，不启动 daemon、不运行迁移，支持已核对的数据库 schema 24、25、26。后台功能默认关闭；仅在显式启用 `OSSTACK_ATTENTION=1` 的 daemon 中运行。开发验证必须指定隔离 home：

```sh
OSSTACK_HOME=/absolute/isolated-home OSSTACK_ATTENTION=1 osstack serve
```

使用安装后的发行版本接入真实 home；不要从开发 checkout 指向默认或保留的控制面。迁移 25 新增观察、决策和体验表，迁移 26 新增人工回执处置和冻结的交接有效期。

## 单次快照

```sh
osstack attention status --db /absolute/isolated-home/state.db \
  --task TASK --repo /absolute/repository --default-tenant --json
```

任务和 run 均须属于默认 tenant；session 还必须匹配持久化的 canonical repo。run 的仓库绑定仍标明 unverified。只返回最新 turn，不能据此声称历史问题已经全部处理。进程活性为 unknown，coverage 为 not_monitored。

每类最多 100 条。跟随 `completeness.next_cursor`，使用 `--cursor TOKEN`；游标绑定本次 scope，并记录两类集合是否耗尽。每页都是新快照，不是跨请求的固定数据库快照。旧的 `--after-run/--after-session` 仅适合单集合调试。

## 持续观察与收件箱

```sh
osstack attention watch --task TASK --repo /absolute/repository --default-tenant --json
osstack attention inventory --scope SCOPE --json
osstack attention inbox --scope SCOPE --json
osstack attention get --scope SCOPE --item ITEM --json
```

`watch` 返回 scope ID。观察按 keyset 发现对象，按 ordinal 补读历史 turn，重读当前 turn。decision 的身份是 scope、session、origin turn、decision ID；CAS 版本与身份分开。坏 turn 标记历史缺口并继续读取后续 turn；缺口不会因为一次成功重读而消失。

daemon 全局最多准入 100 个 subject，优先 session；已有 session 的 run 不重复占容量。最多登记 100 个 scope。超额对象仍被发现并列出原因，不会为了新对象静默驱逐旧对象。`total/returned/truncated/next_after` 必须一起看。覆盖依赖完成扫描、当前 generation 和有效期，不能用心跳证明覆盖。

`covered` 只表示已准入来源的新鲜观测，不表示后台正在推进任务。未知进程、缺失来源、历史缺口、未决回执会分别显示。历史决策没有精确回答证据时保留，不通过文本猜测自动关闭。普通问题若有同 origin turn 的 applied 入站回执，可标 continued_externally；审批义务不会因此被消除。

全局最多准入 100 个 subject，不自动驱逐旧来源。容量不足时，可显式释放观察席位：

```sh
osstack attention release --scope SCOPE --kind session --subject SESSION \
  --expected-version VERSION --json
```

版本来自 inventory。释放保留历史决策和回执，不结束会话、不发送消息；该来源保持 `owner_released`，后续扫描不会自动重新准入。范围仍显示覆盖不完整，腾出的席位可供其他来源使用。

## 回答与不确定回执

```sh
osstack attention answer --scope SCOPE --item ITEM --action UNIQUE_ID \
  --revision REVISION --content-hash HASH --text '明确回答' --json
```

同一 action ID 和完全相同参数可重复查询，只有一个 message ID。不同内容重用 ID 会冲突。提交时重新验证来源、当前 turn、版本、决策内容和等待状态；终态会话不能被此入口复活。直接 `session.send` 与 Attention 共用预留门禁，collaborator 的检查/预留也在同一个数据库串行验证。

活动 grant 默认阻止人工抢答。显式接管须加 `--takeover --grant EXPECTED_GRANT_ID`，且没有在途检查或消息；grant 改变即拒绝。agent 报告的 risk_approval/task_authorization 只导向既有签名审批，不通过普通回答代批。agent 标签本身不构成执行授权；缺少标签也不是动作安全证明。

`applied` 只证明指令回执被应用，不证明任务完成。adapter 失败或完成回执不明时保留 uncertain，不能靠换 message/action ID 重发。重启会对账 reserved actions，不自动重新执行。

若人工检查后决定放弃原始指令，可显式记录一次处置：

```sh
osstack attention abandon-receipt --scope SCOPE --session SESSION \
  --message MESSAGE --expected-version VERSION \
  --reason '已人工核对现场，放弃原指令，不重放；执行结果仍未知' \
  --evidence-sha256 SHA256 --acknowledge-unknown-effects --json
```

这只记录 `abandoned_unknown`，不会将原消息标为成功、不会重放、不会授予 collaborator 继续执行的权限。在途消息不能被处置。SHA256 是操作者声明的审计引用，不是 OSStack 自动认证的外部执行证明。随后若需继续，必须另发明确的新人工指令。旧 action 重试仍返回已放弃，不能再次发送。

## 简报、通知和 Cockpit

```sh
osstack attention brief --scope SCOPE --actor owner --json
osstack attention cockpit --scope SCOPE --actor owner
osstack attention posture --scope SCOPE --actor owner --posture quiet
osstack attention seen --scope SCOPE --actor owner --revisions '[{"item_id":"ITEM","revision":1}]'
osstack attention deliveries --scope SCOPE --json
```

简报按不确定性、审批需求、普通问题排序，显示前三条和完整数量。读取不是已读，已读按 actor、scope、item revision 显式记录。Cockpit 聚合库存、收件箱、简报和投递结果。

posture 为 attended、quiet、away，只改变体验，不改变权限。当前为本地 owner 模型；任一 actor 的 quiet 会保守地静默整个 scope，恢复通知须将该 actor 改回 attended/away。

若启动时另设 `OSSTACK_ATTENTION_NOTIFY=local`，通知写到 home 下 `attention-notifications/`。每个 delivery ID 原子发布一个本地文件，重复尝试不会生成第二份。其他 transport 通过受限 sender 端口注入；协议为至少一次，接收方须按 delivery ID 去重。失败最多 5 次，随后 dead_letter；旧 revision 在发送前判为 superseded。没有配置 transport 时不外发消息。

- delivered：transport 收到，不代表用户已读。
- answer_reserved / answer_uncertain：指令已预留，结果尚未证实。
- answer_applied：存在对应应用回执，不代表业务完成。
- completed：原业务来源的完成状态。

## 前台登记、交接与 Claude Code 提醒

```sh
osstack attention foreground --scope SCOPE \
  --subjects '[{"subject_id":"SESSION","source_version":VERSION}]' --json
osstack attention handoff --scope SCOPE --client CLIENT --token TOKEN --json
```

登记返回随机 token，绑定精确 subject set、来源版本和 daemon generation。交接要求完整、未降级的扫描及无未决回执；回执冻结 `valid_until`，重复查询不延长它。`execution_takeover:false` 与进程 unknown 明确保留。前台到期后仍可收到一次结束提醒，不能据此续期交接权限。

已在 Claude Code **2.1.291** 上实测正常 Stop → 已构建 CLI → Unix RPC，并确认第二次提醒为 null。使用单独的权限为 0600 的 binding JSON：

```json
{
  "harness_version": "2.1.291",
  "session_id": "CLAUDE_SESSION_ID",
  "scope_id": "SCOPE",
  "client_id": "CLIENT",
  "token": "64_HEX_TOKEN",
  "role": "foreground_owner"
}
```

在该次 Claude 会话的独立 settings 中配置 Stop command：

```sh
osstack attention claude-hook --binding-file /absolute/private-binding.json
```

该命令读取 hook stdin，只接受匹配 session 的 root Stop，拒绝 worker、stop_hook_active、未知版本和错误身份。只返回一次 systemMessage，永不返回 block、永不自动续轮。用户全局 Claude 配置不会被自动修改。

实测 SIGINT 在本版本只发 SessionEnd，不发 Stop；取消、强退和进程丢失没有结束提醒保证。未安装独立 watchdog，不能声称离线检测或无人值守继续。事件格式参考 [Claude Code 官方 Hooks](https://code.claude.com/docs/en/hooks)。

## Loop、CI 与离线辅助工具

```sh
osstack attention loop --scope SCOPE --state-path /absolute/repository/LOOP-STATE.json --loop-id LOOP --json
osstack attention ci --scope SCOPE --github-repo OWNER/REPO --pr 123 \
  --head EXACT_40_HEX_SHA --required '["test"]' --json
osstack attention contract --input contract.json --json
osstack attention contract --input scout.json --head NEW_HEAD --json
osstack attention contract --input contract.json --evidence evidence.json --json
osstack attention routing-eval --input routing-results.json --json
osstack attention triage --input model-result.json --json
osstack attention context --input evidence-entries.json --budget 8000 --json
osstack attention lesson --input lesson-draft-input.json --repo /absolute/repository --json
```

Loop 只读有界文件、绑定 workspace 和 loop ID；运行中快照显示 recovery_required，缺失/冲突降级，不能自动接管未知 worker。注册后后台补读，始终披露 best-effort snapshot gap。

CI 使用已有 GitHub 命令执行器，独立并发上限 2、缓存上限 100、失败退避；需要完整 required check 名单及精确 head，缺 check/凭证、head 改变、网络错误均不能变成通过。仓库/PR 是操作者显式选择的外部来源，结果仅供观察，不替代 merge/deploy 的既有资格验证。

交付契约工具从同一冻结对象派生 digest、brief、effective options；scout→implement 产生新 ID。校验 mode、head、必选验证、review 与完成层级。它检查输入自洽，不是外部执行证明，也不会自动调用 deliver 或复用审批授权。

分诊只接收三种分类和有限解释，拒绝 action/tool 字段，失败回确定性视图；当前没有自动模型调用。routing-eval 评估提供的候选路由结果与 golden labels，记录准确率、漏 review 和 usage；未证明收益前不改变默认路由。context 按层级、时间与 UTF-8 字节预算筛选，披露被省略的必选信息；lesson 只新建带随机 ID 的既有格式 draft，不覆盖用户记忆，不修改 AGENTS，不自动 promote。

## 恢复行为变更

daemon 在 socket 清理、业务 DB 打开、恢复前取得独立 SQLite 文件的内核排他锁。锁文件固定 inode，崩溃时内核释放；PID 文件仅用于诊断。限已验证的本地文件系统，不能删除锁文件强行抢占。

旧 running/stopping Loop 和 daily 快照恢复为 stopped/recovery_required。启动和 Loop cycle 都不再强制删除未知 orphan worktree。保留成果后由操作者核对并明确开启新工作。未知外部 worker 不会被本功能终止或自动重启。
