import { readFile } from "node:fs/promises";
import type { GovernanceFinding, GovernanceScanResult } from "./types.js";

interface ScanTextOptions {
  file?: string;
}

interface Rule {
  id: string;
  category: GovernanceFinding["category"];
  severity: GovernanceFinding["severity"];
  message: string;
  pattern: RegExp;
}

const RULES: Rule[] = [
  {
    id: "secret.api_key",
    category: "secret",
    severity: "error",
    message: "Possible API key or token assignment.",
    pattern: /\b(api[_-]?key|token|password)\b\s*[:=]\s*["'][^"']{8,}["']/i,
  },
  {
    id: "secret.private_key",
    category: "secret",
    severity: "error",
    message: "Possible private key material.",
    pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  },
  {
    id: "shell.rm_rf_root",
    category: "dangerous_shell",
    severity: "error",
    message: "Dangerous recursive removal of root path.",
    pattern: /\brm\s+-rf\s+\/(?:\s|["'`]|$)/,
  },
  {
    id: "shell.curl_pipe_shell",
    category: "dangerous_shell",
    severity: "error",
    message: "Curl piped directly into a shell.",
    pattern: /\bcurl\b[^\n|]*\|\s*(?:sh|bash|zsh)\b/,
  },
  {
    id: "frontend.lorem_ipsum",
    category: "frontend_quality",
    severity: "warning",
    message: "Placeholder Lorem ipsum text.",
    pattern: /lorem ipsum/i,
  },
  {
    id: "frontend.emoji_icon",
    category: "frontend_quality",
    severity: "warning",
    message: "Emoji used as a likely fake icon.",
    pattern: /[\u{1F300}-\u{1FAFF}]/u,
  },
  {
    id: "frontend.template_purple",
    category: "frontend_quality",
    severity: "info",
    message: "Hardcoded purple template color.",
    pattern: /#(?:8b5cf6|a855f7|9333ea|7c3aed)\b/i,
  },
  {
    id: "ts.no_explicit_any",
    category: "typescript_quality",
    severity: "warning",
    message: "Explicit any weakens type guarantees.",
    pattern: /:\s*any\b/,
  },
  {
    id: "ts.ts_ignore",
    category: "typescript_quality",
    severity: "warning",
    message: "@ts-ignore suppresses type safety without audit trail.",
    pattern: /@ts-ignore/,
  },
  {
    id: "ts.console_spam",
    category: "typescript_quality",
    severity: "info",
    message: "Console logging should not become persistent noise.",
    pattern: /\bconsole\.(?:log|debug)\s*\(/,
  },
  {
    id: "backend.sql_interpolation",
    category: "backend_safety",
    severity: "error",
    message: "Possible SQL string interpolation.",
    pattern: /(?:SELECT|INSERT|UPDATE|DELETE)[^`]*\$\{/i,
  },
  {
    id: "backend.ssr_dirty_fetch",
    category: "backend_safety",
    severity: "warning",
    message: "Fetch appears to use an unvalidated dynamic URL.",
    pattern: /\bfetch\s*\(\s*(?:url|uri|userInput|req\.query|request\.url)\b/,
  },
  {
    id: "backend.unsafe_eval",
    category: "backend_safety",
    severity: "error",
    message: "Unsafe eval or Function constructor.",
    pattern: /\b(?:eval\s*\(|new\s+Function\s*\()/,
  },
];

export function scanText(text: string, options: ScanTextOptions = {}): GovernanceScanResult {
  const findings: GovernanceFinding[] = [];
  const lines = text.split(/\r?\n/);

  for (const [index, line] of lines.entries()) {
    for (const rule of RULES) {
      if (!rule.pattern.test(line)) continue;
      findings.push({
        rule_id: rule.id,
        category: rule.category,
        severity: rule.severity,
        message: rule.message,
        ...(options.file !== undefined ? { file: options.file } : {}),
        line: index + 1,
        excerpt: line.trim(),
      });
    }
  }

  return {
    ok: findings.length === 0,
    findings,
  };
}

export async function scanFiles(paths: string[]): Promise<GovernanceScanResult> {
  const findings: GovernanceFinding[] = [];
  for (const path of paths) {
    const content = await readFile(path, "utf-8");
    findings.push(...scanText(content, { file: path }).findings);
  }
  return {
    ok: findings.length === 0,
    findings,
  };
}
