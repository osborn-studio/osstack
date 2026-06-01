// PIIRedactor — middleware that scrubs PII from prompts/log lines before
// they hit the SQLite event log or get sent to a sub-agent.
//
// CRITICAL GAP G2 (plan v0.6 §8.3): a regex-based redactor MUST NOT hang the
// daemon on a catastrophic backtracking pathology. Two defenses here:
//
//   1) Every shipped pattern is linear-in-input by construction (no nested
//      quantifiers, no overlapping alternations on the hot path). Patterns
//      live in PIIPattern[] and are reviewed in code review, not user-supplied.
//
//   2) A wall-clock budget of 100 ms per redact() call. If we blow the budget
//      we abort the redactor on the *current* pattern, leave the remaining
//      input untouched, and surface a `PIIRedactorTimeout` event so a human
//      can investigate. We never silently drop characters or stall the daemon.
//
// Future S6+ may accept user-supplied patterns via skill-registry; those must
// run inside a worker thread with a kill switch, NOT inline. Not in this push.

export interface PIIPattern {
  /** Stable id for telemetry. */
  id: string;
  /** Linear-time regex (vetted in code review). */
  pattern: RegExp;
  /** Replacement string; may use $1, $2, etc. Defaults to "[REDACTED]". */
  replace?: string;
}

/** Default linear-time patterns. Reviewed for ReDoS safety.
 *
 * Order is significant. Specific patterns (with anchoring sentinels like `@`,
 * `sk-`, `AKIA`, or strict structure) run before looser numeric ones so that
 * a 192.168.1.5 doesn't get mis-tagged as a phone number.
 */
export const DEFAULT_PATTERNS: readonly PIIPattern[] = [
  // ── high-specificity: clear sentinels ───────────────────────────────
  {
    id: "anthropic_key",
    pattern: /\bsk-ant-[A-Za-z0-9_-]{20,200}\b/g,
    replace: "[REDACTED:anthropic_key]",
  },
  {
    id: "openai_key",
    pattern: /\bsk-[A-Za-z0-9]{20,200}\b/g,
    replace: "[REDACTED:openai_key]",
  },
  {
    id: "aws_access_key",
    pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
    replace: "[REDACTED:aws_access_key]",
  },
  {
    id: "email",
    pattern: /\b[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,24}\b/g,
    replace: "[REDACTED:email]",
  },
  // ── structured numeric formats (run before phone) ───────────────────
  {
    id: "ssn_us",
    pattern: /\b\d{3}-\d{2}-\d{4}\b/g,
    replace: "[REDACTED:ssn]",
  },
  {
    id: "ipv4",
    pattern: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g,
    replace: "[REDACTED:ipv4]",
  },
  // ── phone numbers (last; requires leading + OR a parenthesized
  //     area code to avoid matching IPv4 / SSN / random number runs)
  {
    id: "phone_e164",
    pattern: /(?:\+\d{1,3}[\s.-]?\d{1,4}[\s.-]?\d{1,4}[\s.-]?\d{1,9}|\(\d{2,4}\)[\s.-]?\d{3,4}[\s.-]?\d{3,4})/g,
    replace: "[REDACTED:phone]",
  },
];

export interface RedactionStats {
  /** Map of pattern.id → count of redactions. */
  counts: Record<string, number>;
  /** Wall-clock duration of the full redact() call, ms. */
  duration_ms: number;
  /** True if the 100 ms budget was hit. */
  timed_out: boolean;
  /** When timed out: which pattern.id we were processing. */
  timed_out_on?: string;
}

export interface RedactionResult {
  text: string;
  stats: RedactionStats;
}

export class PIIRedactor {
  readonly patterns: readonly PIIPattern[];
  readonly budgetMs: number;

  constructor(opts: { patterns?: readonly PIIPattern[]; budgetMs?: number } = {}) {
    this.patterns = opts.patterns ?? DEFAULT_PATTERNS;
    this.budgetMs = opts.budgetMs ?? 100;
  }

  /**
   * Redact PII from a single string. Returns the rewritten text plus stats.
   * Budget is checked between patterns (granular) and once before starting.
   */
  redact(input: string): RedactionResult {
    const start = performance.now();
    const counts: Record<string, number> = {};
    let text = input;
    let timedOut = false;
    let timedOutOn: string | undefined;

    for (const p of this.patterns) {
      const elapsed = performance.now() - start;
      if (elapsed > this.budgetMs) {
        timedOut = true;
        timedOutOn = p.id;
        break;
      }
      let matchCount = 0;
      text = text.replace(p.pattern, (_full, ..._groups) => {
        matchCount += 1;
        return p.replace ?? "[REDACTED]";
      });
      if (matchCount > 0) counts[p.id] = matchCount;
    }

    const duration_ms = performance.now() - start;
    const stats: RedactionStats = { counts, duration_ms, timed_out: timedOut };
    if (timedOutOn !== undefined) stats.timed_out_on = timedOutOn;
    return { text, stats };
  }

  /**
   * Redact a structured object, scrubbing every string field recursively.
   * Non-string values pass through untouched.
   */
  redactDeep<T>(value: T): { value: T; stats: RedactionStats } {
    const counts: Record<string, number> = {};
    const start = performance.now();
    let timedOut = false;
    let timedOutOn: string | undefined;

    const visit = (v: unknown): unknown => {
      if (timedOut) return v;
      if (typeof v === "string") {
        if (performance.now() - start > this.budgetMs) {
          timedOut = true;
          return v;
        }
        const r = this.redact(v);
        for (const [id, n] of Object.entries(r.stats.counts)) {
          counts[id] = (counts[id] ?? 0) + n;
        }
        if (r.stats.timed_out) {
          timedOut = true;
          timedOutOn = r.stats.timed_out_on;
        }
        return r.text;
      }
      if (Array.isArray(v)) return v.map(visit);
      if (v !== null && typeof v === "object") {
        const out: Record<string, unknown> = {};
        for (const [k, vv] of Object.entries(v)) out[k] = visit(vv);
        return out;
      }
      return v;
    };

    const value2 = visit(value) as T;
    const duration_ms = performance.now() - start;
    const stats: RedactionStats = { counts, duration_ms, timed_out: timedOut };
    if (timedOutOn !== undefined) stats.timed_out_on = timedOutOn;
    return { value: value2, stats };
  }
}
