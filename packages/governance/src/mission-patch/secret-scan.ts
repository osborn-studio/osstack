export type MissionSecretRule =
  | "secret.aws-access-key-id"
  | "secret.github-token"
  | "secret.private-key"
  | "secret.sk-api-key"
  | "secret.slack-token"
  | "secret.slack-webhook";

/** Every executor output the host captures; each is an exfiltration channel. */
export type MissionOutputChannel = "patch" | "final_message" | "stdout" | "stderr";

/** A secret hit; carries the rule and location only, never the matched value. */
export interface MissionSecretMatch {
  channel: MissionOutputChannel;
  /** 1-based line of the text where the match starts. */
  line: number;
  rule: MissionSecretRule;
}

export const MISSION_SECRET_REDACTION = "[REDACTED:secret]";

// The private-key rule spans to the END line (or the end of text) so redaction
// removes the key body, not just its header.
const SECRET_RULES: ReadonlyArray<{ rule: MissionSecretRule; source: string }> = [
  {
    rule: "secret.private-key",
    source: String.raw`-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----(?:[\s\S]*?-----END (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----|[\s\S]*)`,
  },
  {
    rule: "secret.github-token",
    source: String.raw`\b(?:gh[opsur]_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9]{22}_[A-Za-z0-9]{59})(?![A-Za-z0-9_])`,
  },
  { rule: "secret.aws-access-key-id", source: String.raw`\b(?:AKIA|ASIA|ABIA|ACCA)[A-Z0-9]{16}\b` },
  { rule: "secret.sk-api-key", source: String.raw`(?<![A-Za-z0-9_-])sk-(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{32,}` },
  { rule: "secret.slack-token", source: String.raw`\b(?:xox[abposr]|xapp)-[A-Za-z0-9-]{10,}` },
  {
    rule: "secret.slack-webhook",
    source: String.raw`https://hooks\.slack\.com/services/T[A-Za-z0-9]+/B[A-Za-z0-9]+/[A-Za-z0-9]+`,
  },
];

interface Span {
  start: number;
  end: number;
  rule: MissionSecretRule;
}

function secretSpans(text: string): Span[] {
  const spans: Span[] = [];
  for (const { rule, source } of SECRET_RULES) {
    for (const match of text.matchAll(new RegExp(source, "g"))) {
      spans.push({ start: match.index!, end: match.index! + match[0].length, rule });
    }
  }
  return spans.sort((left, right) => left.start - right.start || right.end - left.end);
}

/** Scans one captured output for high-signal credentials. Sorted by line, then rule. */
export function scanForSecrets(text: string, options: { channel: MissionOutputChannel }): MissionSecretMatch[] {
  const lineStarts = [0];
  for (let index = text.indexOf("\n"); index >= 0; index = text.indexOf("\n", index + 1)) {
    lineStarts.push(index + 1);
  }
  const lineOf = (offset: number) => {
    let low = 0;
    let high = lineStarts.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (lineStarts[mid]! <= offset) low = mid;
      else high = mid - 1;
    }
    return low + 1;
  };
  const matches = new Map<string, MissionSecretMatch>();
  for (const span of secretSpans(text)) {
    const line = lineOf(span.start);
    matches.set(`${line}\u0000${span.rule}`, { channel: options.channel, line, rule: span.rule });
  }
  return [...matches.values()].sort((left, right) =>
    left.line - right.line || (left.rule < right.rule ? -1 : left.rule > right.rule ? 1 : 0));
}

/** Replaces every matched span with {@link MISSION_SECRET_REDACTION}; overlapping spans merge. */
export function redactSecrets(text: string): string {
  let result = "";
  let cursor = 0;
  for (const span of secretSpans(text)) {
    if (span.end <= cursor) continue;
    if (span.start >= cursor) {
      result += text.slice(cursor, span.start) + MISSION_SECRET_REDACTION;
    }
    cursor = span.end;
  }
  return result + text.slice(cursor);
}
