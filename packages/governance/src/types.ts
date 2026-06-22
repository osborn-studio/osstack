export type GovernanceSeverity = "error" | "warning" | "info";

export interface GovernanceFinding {
  rule_id: string;
  severity: GovernanceSeverity;
  category: "secret" | "dangerous_shell" | "frontend_quality" | "typescript_quality" | "backend_safety";
  message: string;
  file?: string;
  line: number;
  excerpt: string;
}

export interface GovernanceScanResult {
  ok: boolean;
  findings: GovernanceFinding[];
}
