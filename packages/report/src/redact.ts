// Secret redaction for proof packs. Best-effort defense-in-depth: a proof pack
// is meant to be shared, so we scrub common credential shapes before zipping.
// Conservative — it redacts the secret value, not the whole line, to keep
// evidence readable.

interface RedactPattern {
  id: string;
  re: RegExp;
  replace: (m: string, ...groups: string[]) => string;
}

const REDACTED = "«REDACTED»";

const PATTERNS: RedactPattern[] = [
  // key = "value" / key: value  (api_key, token, secret, password, access_key…)
  {
    id: "kv-secret",
    re: /\b([A-Za-z0-9_.-]*(?:api[_-]?key|secret|token|password|passwd|access[_-]?key|client[_-]?secret|auth)[A-Za-z0-9_.-]*)\b(\s*[:=]\s*)(['"]?)([^\s'"]{6,})(\3)/gi,
    replace: (_m, key, sep, q) => `${key}${sep}${q}${REDACTED}${q}`,
  },
  // Bearer tokens
  { id: "bearer", re: /\b(Bearer\s+)[A-Za-z0-9._\-]{12,}/gi, replace: (_m, p) => `${p}${REDACTED}` },
  // Known token prefixes (OpenAI/Anthropic/GitHub/AWS/Slack)
  { id: "openai", re: /\bsk-[A-Za-z0-9_-]{16,}/g, replace: () => REDACTED },
  { id: "anthropic", re: /\bsk-ant-[A-Za-z0-9_-]{16,}/g, replace: () => REDACTED },
  { id: "github", re: /\bgh[pousr]_[A-Za-z0-9]{20,}/g, replace: () => REDACTED },
  { id: "aws", re: /\bAKIA[0-9A-Z]{16}\b/g, replace: () => REDACTED },
  { id: "slack", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g, replace: () => REDACTED },
  // DB connection strings with embedded password: scheme://user:pass@host
  {
    id: "db-url",
    re: /\b([a-z][a-z0-9+.-]*:\/\/[^:\s/@]+:)([^@\s/]{1,})(@)/gi,
    replace: (_m, pre, _pw, at) => `${pre}${REDACTED}${at}`,
  },
  // PEM private key blocks
  {
    id: "pem",
    re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    replace: () => `-----BEGIN PRIVATE KEY-----\n${REDACTED}\n-----END PRIVATE KEY-----`,
  },
];

export interface RedactResult {
  text: string;
  count: number;
  rules: string[];
}

/** Redact common secret shapes from a string. Never throws. */
export function redactSecrets(input: string): RedactResult {
  let text = input;
  let count = 0;
  const rules = new Set<string>();
  for (const p of PATTERNS) {
    text = text.replace(p.re, (...args: string[]) => {
      count++;
      rules.add(p.id);
      // args = [match, ...groups, offset, fullString]
      const groups = args.slice(1, -2);
      return p.replace(args[0]!, ...groups);
    });
  }
  return { text, count, rules: Array.from(rules) };
}

/** Redact a buffer if it looks like text; binary buffers pass through untouched. */
export function redactBuffer(buf: Buffer): { data: Buffer; count: number } {
  // Heuristic: treat as text if no NUL byte in the first 8KB.
  const slice = buf.subarray(0, 8192);
  if (slice.includes(0)) return { data: buf, count: 0 };
  const { text, count } = redactSecrets(buf.toString("utf8"));
  return { data: count > 0 ? Buffer.from(text, "utf8") : buf, count };
}
