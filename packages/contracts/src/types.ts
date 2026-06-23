export type ContractHttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface ContractEndpoint {
  id: string;
  method: ContractHttpMethod;
  path: string;
  owner?: string;
}

export interface ContractManifest {
  schema_version: 1;
  kind: "osstack.contract_manifest";
  service: string;
  endpoints: ContractEndpoint[];
}

export type ContractFindingSeverity = "error" | "warning";

export type ContractFindingKind =
  | "invalid_manifest"
  | "missing_backend"
  | "unused_endpoint";

export interface ContractFinding {
  rule_id: string;
  severity: ContractFindingSeverity;
  kind: ContractFindingKind;
  message: string;
  endpoint_id?: string;
  method?: ContractHttpMethod;
  path?: string;
  file?: string;
  line?: number;
  evidence?: string;
}

export interface ContractSourceUsage {
  method: ContractHttpMethod;
  path: string;
  file: string;
  line: number;
  evidence: string;
}

export interface ContractValidationReport {
  schema_version: 1;
  kind: "osstack.contract_validation";
  status: "pass" | "fail";
  service: string;
  manifest_path: string;
  workspace_path: string;
  checked_at: string;
  endpoints: number;
  frontend_calls: ContractSourceUsage[];
  backend_routes: ContractSourceUsage[];
  findings: ContractFinding[];
}
