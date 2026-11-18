import { buildInstructionSegment, type ProtectedInstructionConfig } from "./instruction-boundary.js";

const validated = Symbol("validated repair input");
interface RepairFields {
  readonly check_id: string;
  readonly failure_code: string;
  readonly locations: readonly string[];
}
export interface LocalFailureRepairInput extends RepairFields {
  readonly [validated]: true;
}
interface HostRepairFields extends Omit<RepairFields, "locations"> {
  locations?: readonly string[];
  check_ids: readonly string[];
  allowed_codes: readonly string[];
  allowed_paths: readonly string[];
}
const issued = new WeakSet<LocalFailureRepairInput>();

export function createLocalFailureRepairInput(
  host: HostRepairFields,
  withinAllowed: (path: string, globs: readonly string[]) => boolean,
): LocalFailureRepairInput {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: Reject controls in host-supplied file locations.
  const unsafePath = /[\\\u0000-\u001f\u007f]/;
  const fields = ["check_id", "failure_code", "locations", "allowed_paths", "check_ids", "allowed_codes"];
  if (
    !host ||
    typeof host !== "object" ||
    typeof host.check_id !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(host.check_id) ||
    typeof host.failure_code !== "string" ||
    !/^[a-z][a-z0-9_-]{0,127}$/.test(host.failure_code) ||
    Object.keys(host).some((key) => !fields.includes(key)) ||
    !Array.isArray(host.check_ids) ||
    !Array.isArray(host.allowed_codes) ||
    !Array.isArray(host.allowed_paths) ||
    !host.check_ids.includes(host.check_id) ||
    !host.allowed_codes.includes(host.failure_code)
  )
    throw Error("verify_grant_invalid");
  const locations = host.locations === undefined ? host.allowed_paths : host.locations;
  if (
    !Array.isArray(locations) ||
    !locations.length ||
    ![...locations].every(
      (p) =>
        typeof p === "string" &&
        !unsafePath.test(p) &&
        !/^[A-Za-z]:/.test(p) &&
        p.split("/").every((s) => s && s !== "." && s !== "..") &&
        (host.locations === undefined || (!/[*?]/.test(p) && withinAllowed(p, host.allowed_paths))),
    )
  )
    throw Error("verify_protected_path");
  const result = Object.freeze({
    [validated]: true as const,
    check_id: host.check_id,
    failure_code: host.failure_code,
    locations: Object.freeze([...locations]),
  });
  issued.add(result);
  return result;
}

export function buildRepairGoal(config: ProtectedInstructionConfig, input: LocalFailureRepairInput): string {
  if (!issued.has(input)) throw Error("validated_repair_input_required");
  return [
    buildInstructionSegment(config).text,
    "Repair the registered failure within the listed paths.",
    JSON.stringify(input),
  ].join("\n");
}
