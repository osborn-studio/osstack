import { randomBytes } from "node:crypto";
import type Database from "better-sqlite3";

export const PROBE_COLOURS = ["red", "green", "blue"] as const;
export const PROBE_SUMMARY = "osstack test card: pick a colour. No work depends on it.";

export interface DecisionProbe {
  probe_id: string;
  state: "pending" | "answered" | "continued";
  revision: number;
  created_at: number;
  expires_at: number;
  created_by: string;
  answer: string | null;
  answer_id: string | null;
  answer_digest: string | null;
  answered_by: string | null;
  answered_at: number | null;
  continued_at: number | null;
}

export class DecisionProbes {
  constructor(private readonly db: Database.Database) {}

  create({ now, created_by }: { now: number; created_by: string }) {
    return this.db.transaction(() => {
      const pending = this.db.prepare<[number], DecisionProbe>(
        "SELECT * FROM decision_probes WHERE state='pending' AND expires_at>? LIMIT 1"
      ).get(now);
      if (pending) return { probe: pending, created: false };
      const probe = this.db.prepare<[string, number, number, string], DecisionProbe>(`
        INSERT INTO decision_probes(probe_id,state,revision,created_at,expires_at,created_by)
        VALUES(?,'pending',1,?,?,?) RETURNING *`).get(randomBytes(16).toString("hex"), now, now + 3600000, created_by)!;
      return { probe, created: true };
    }).immediate();
  }

  status(probe_id: string, now: number) {
    const row = this.db.prepare<[string], DecisionProbe>("SELECT * FROM decision_probes WHERE probe_id=?").get(probe_id);
    return row && { ...row, expired: row.state === "pending" && now >= row.expires_at };
  }

  answer(input: { probe_id: string; answer: string; answer_id: string; digest: string; actor: string;
    expected_revision: number; now: number; hasParams?: boolean }) {
    return this.db.transaction(() => {
      const receipt = this.db.prepare<[string], Pick<DecisionProbe, "answer_digest">>(
        "SELECT answer_digest FROM decision_probes WHERE answer_id=?"
      ).get(input.answer_id);
      if (receipt) return { code: receipt.answer_digest === input.digest && !input.hasParams ? "replay" : "answer_id_conflict" } as const;
      const probe = this.status(input.probe_id, input.now);
      if (!probe) return { code: "not_found" } as const;
      if (probe.state !== "pending" || probe.expired) return { code: "already_resolved" } as const;
      if (input.expected_revision !== probe.revision) return { code: "stale_revision" } as const;
      if (input.hasParams || !PROBE_COLOURS.some(colour => colour === input.answer)) return { code: "invalid_answer" } as const;
      this.db.prepare(`UPDATE decision_probes SET state='answered', revision=revision+1,
        answer=?,answer_id=?,answer_digest=?,answered_by=?,answered_at=? WHERE probe_id=?`)
        .run(input.answer, input.answer_id, input.digest, input.actor, input.now, input.probe_id);
      return { code: "applied" } as const;
    }).immediate();
  }

  continue(probe_id: string, now: number) {
    return this.db.transaction(() => {
      const row = this.status(probe_id, now);
      if (!row) return { code: "not_found" } as const;
      if (row.state === "pending") return { code: row.expired ? "expired" : "pending" } as const;
      if (row.state === "continued") return { code: "continued", probe: row } as const;
      this.db.prepare("UPDATE decision_probes SET state='continued',revision=revision+1,continued_at=? WHERE probe_id=? AND state='answered'")
        .run(now, probe_id);
      return { code: "continued", probe: this.status(probe_id, now)! } as const;
    }).immediate();
  }
}
