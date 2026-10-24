import { createHash } from "node:crypto";
import { z } from "zod";
import type { Capability, CapabilityKind, RoutableAdapter } from "@osstack/core";

const id = z.string().trim().min(1).max(256);
const text = z.string().min(1).max(1000);
// Production --role parsing splits on '='; reject IDs that cannot round-trip.
const roleOverrideId = id.refine(value => !value.includes("="), "role_override_id_cannot_contain_equals");
const capabilityOutcome = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("selected"), adapter_id: id, capability_id: id, reason: text }).strict(),
  z.object({ kind: z.literal("rejected"), code: z.enum(["agent_not_found", "agent_unavailable", "agent_capability_mismatch"]) }).strict(),
  z.object({ kind: z.literal("none") }).strict(),
]);
const profileOutcome = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("profile_selected"), builder: id, evaluator: id, independent: z.literal(true), overrides: z.record(id, id) }).strict(),
  z.object({ kind: z.literal("profile_rejected"), message: text }).strict(),
]);
const role = z.object({ primary: id, fallback: z.array(id).max(32) }).strict();
const roles = z.object({ coding: role, "test-verify": role, design: role }).strict();

// Capability kinds come from the real runtime schema without eagerly importing
// the core control-plane barrel into every supervisor consumer.
function schemas(kinds: typeof import("@osstack/core").CapabilityKind) {
  const adapter = z.object({
    id, cost_tier: z.enum(["low", "mid", "high"]),
    availability: z.enum(["available", "unavailable", "error"]),
    capabilities: z.array(z.object({ id, kind: kinds }).strict()).max(64),
    identity: z.object({ provider_id: id, model_id: id }).strict().optional(),
  }).strict().superRefine((a, ctx) => {
    if (new Set(a.capabilities.map(c => c.id)).size !== a.capabilities.length)
      ctx.addIssue({ code: "custom", message: "duplicate_capability_id" });
  });
  const common = { id, rationale: text, adapters: z.array(adapter).max(32) };
  const capability = z.object({ ...common, entrypoint: z.literal("capability"),
    request: z.object({ capability_id: id.optional(), kind: kinds.optional(), agent_id: id.optional() }).strict()
      .refine(r => Object.keys(r).length > 0, "routing_request_required"),
    expected: capabilityOutcome,
  }).strict();
  const profile = z.object({ ...common, entrypoint: z.literal("profile"), roles,
    explicit_builder: id.optional(), explicit_evaluators: z.array(id).max(1),
    role_overrides: z.object({ coding: roleOverrideId.optional(), "test-verify": roleOverrideId.optional(), design: roleOverrideId.optional() }).strict(),
    expected: profileOutcome,
  }).strict();
  return z.object({ version: z.literal(1), dataset_id: id,
    cases: z.array(z.discriminatedUnion("entrypoint", [capability, profile])).min(1).max(256),
  }).strict().superRefine((data, ctx) => {
    if (new Set(data.cases.map(c => c.id)).size !== data.cases.length)
      ctx.addIssue({ code: "custom", path: ["cases"], message: "duplicate_case_id" });
    for (const [index, item] of data.cases.entries()) {
      const capabilityIds = item.adapters.flatMap(a => a.capabilities.map(c => c.id));
      if (new Set(capabilityIds).size !== capabilityIds.length)
        ctx.addIssue({ code: "custom", path: ["cases", index, "adapters"], message: "duplicate_capability_id_across_adapters" });
      if (new Set(item.adapters.map(a => a.id)).size !== item.adapters.length)
        ctx.addIssue({ code: "custom", path: ["cases", index, "adapters"], message: "duplicate_adapter_id" });
    }
  });
}
export type RoutingGoldenDataset = z.infer<ReturnType<typeof schemas>>;
export type RoutingGoldenCase = RoutingGoldenDataset["cases"][number];
export type ProfileRoutingGoldenCase = Extract<RoutingGoldenCase, { entrypoint: "profile" }>;
export type ProfileRoutingGoldenOutcome = z.infer<typeof profileOutcome>;
type Outcome = z.infer<typeof capabilityOutcome> | ProfileRoutingGoldenOutcome;

/** Fixture adapters provide facts only. No credentials, provider clients, or
 * subprocess probes are created. Any future execution attempt fails visibly. */
export interface RoutingEvaluationAdapter extends RoutableAdapter {
  readonly display_name: string;
  isAvailable(): Promise<{ available: boolean; last_checked_at: number }>;
  runtimeIdentity(): Promise<{
    adapter_id: string; adapter_version: string; auth_mode: string; provider_id: string;
    model_id: string; evidence_source: "configured";
  }>;
  invoke(): never;
}
export type ProfileRoutingGoldenRunner = (
  item: ProfileRoutingGoldenCase, adapters: RoutingEvaluationAdapter[],
) => Promise<unknown>;
export interface RoutingGoldenCaseResult {
  id: string; entrypoint: "capability" | "profile";
  status: "passed" | "failed" | "incomplete";
  expected: Outcome; actual: Outcome | null;
  differences: string[]; error?: string;
}
export interface RoutingGoldenReport {
  mode: "router_golden"; dataset_hash: string | null; dataset_id: string | null;
  qualification: "deterministic_regression_only";
  status: "passed" | "failed" | "incomplete";
  total: number; evaluated: number; passed: number; failed: number; incomplete: number;
  provider_invocations: number; provider_invocation_scope: "fixture_invoke_attempts"; default_enabled: false;
  results: RoutingGoldenCaseResult[]; errors: string[];
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
function differences(expected: Outcome, actual: Outcome): string[] {
  const a = expected as Record<string, unknown>, b = actual as Record<string, unknown>;
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()
    .filter(key => canonical(a[key]) !== canonical(b[key]));
}

/** Execute one fixed entrypoint per case, never choose between predictions.
 * Profile wiring is supplied by CLI to avoid a supervisor -> CLI dependency. */
export async function evaluateRoutingGolden(raw: unknown, profileRunner?: ProfileRoutingGoldenRunner): Promise<RoutingGoldenReport> {
  let digest: string | null = null;
  try { digest = createHash("sha256").update(canonical(raw)).digest("hex"); } catch { /* Invalid cyclic input is incomplete. */ }
  const rawCases = raw && typeof raw === "object" && "cases" in raw ? raw.cases : undefined;
  const total = Array.isArray(rawCases) ? rawCases.length : 0;
  const report: RoutingGoldenReport = {
    mode: "router_golden", dataset_hash: digest, dataset_id: null,
    qualification: "deterministic_regression_only", status: "incomplete",
    total, evaluated: 0, passed: 0, failed: 0, incomplete: total,
    provider_invocations: 0, provider_invocation_scope: "fixture_invoke_attempts", default_enabled: false, results: [], errors: [],
  };
  const { CapabilityKind: kinds, routeCapability, AgentOverrideError } = await import("@osstack/core");
  const parsed = schemas(kinds).safeParse(raw);
  if (!parsed.success || digest === null) {
    report.errors = parsed.success ? ["unhashable_dataset"] : parsed.error.issues.slice(0, 30).map(i => `${i.path.join(".")}: ${i.message}`);
    return report;
  }
  report.dataset_id = parsed.data.dataset_id;
  report.incomplete = 0;
  for (const item of parsed.data.cases) {
    const adapters: RoutingEvaluationAdapter[] = item.adapters.map(a => ({
      id: a.id, display_name: a.id, cost_tier: a.cost_tier,
      capabilities: (): Capability[] => a.capabilities.map(c => ({ ...c, kind: c.kind as CapabilityKind,
        agent_id: a.id, description: `Golden fixture ${a.id}`, cost_tier: a.cost_tier, hints: {}, version: "1" })),
      isAvailable: async () => {
        if (a.availability === "error") throw Error("fixture_probe_failed");
        return { available: a.availability === "available", last_checked_at: 1 };
      },
      runtimeIdentity: async () => ({ adapter_id: a.id, adapter_version: "fixture-v1", auth_mode: "fixture",
        provider_id: a.identity?.provider_id ?? `fixture:${a.id}`, model_id: a.identity?.model_id ?? "fixture-model",
        evidence_source: "configured" }),
      invoke: () => { report.provider_invocations++; throw Error("provider_invocation_forbidden"); },
    }));
    const result: RoutingGoldenCaseResult = { id: item.id, entrypoint: item.entrypoint,
      status: "incomplete", expected: structuredClone(item.expected), actual: null, differences: [] };
    const invokesBefore = report.provider_invocations;
    try {
      let actual: Outcome;
      if (item.entrypoint === "capability") {
        try {
          const picked = await routeCapability({
            ...(item.request.agent_id === undefined ? {} : { agent_id: item.request.agent_id }),
            ...(item.request.capability_id === undefined ? {} : { capability_id: item.request.capability_id }),
            ...(item.request.kind === undefined ? {} : { kind: item.request.kind }),
          }, adapters);
          if (picked === undefined) throw Error("capability_result_missing_or_invalid");
          const value = picked === null ? { kind: "none" } : {
            kind: "selected", adapter_id: picked.adapter.id, capability_id: picked.capability.id, reason: picked.reason,
          };
          const checked = capabilityOutcome.safeParse(value);
          if (!checked.success) throw Error("capability_result_missing_or_invalid");
          actual = checked.data;
        } catch (error) {
          if (!(error instanceof AgentOverrideError)) throw error;
          actual = { kind: "rejected", code: error.code };
        }
      } else {
        if (!profileRunner) throw Error("profile_runner_unavailable");
        const value = await profileRunner(item, adapters);
        const checked = profileOutcome.safeParse(value);
        if (!checked.success) throw Error("profile_result_missing_or_invalid");
        actual = checked.data;
      }
      if (report.provider_invocations !== invokesBefore) throw Error("provider_invocation_forbidden");
      result.actual = actual;
      result.differences = differences(result.expected, actual);
      result.status = result.differences.length ? "failed" : "passed";
      report.evaluated++;
      report[result.status]++;
    } catch (error) {
      result.error = error instanceof Error ? error.message : "routing_evaluation_failed";
      report.incomplete++;
    }
    report.results.push(result);
  }
  report.status = report.incomplete || report.provider_invocations ? "incomplete" : report.failed ? "failed" : "passed";
  // A trusted bridge retaining fixture adapters must not mutate an emitted report.
  return structuredClone(report);
}
