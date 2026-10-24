import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { z } from "zod";

const label = z.enum(["human_decision", "system_wait", "source_uncertain"]);
const model = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/);
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
export const PairedRoutingInputSchema = z.object({
  schema_version: z.literal(1), dataset_id: z.string().min(1).max(128), split: z.literal("holdout"),
  training_prompt_sha256: z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(4096),
  cases: z.array(z.object({ id: z.string().min(1).max(128), excerpt: z.string().min(1).max(6000), expected: label }).strict()).min(2).max(128),
  models: z.tuple([z.object({ id: model, input_usd_per_million: z.number().finite().nonnegative().max(1000), output_usd_per_million: z.number().finite().nonnegative().max(1000), cache_creation_usd_per_million: z.number().finite().nonnegative().max(1000), cache_read_usd_per_million: z.number().finite().nonnegative().max(1000) }).strict(),
    z.object({ id: model, input_usd_per_million: z.number().finite().nonnegative().max(1000), output_usd_per_million: z.number().finite().nonnegative().max(1000), cache_creation_usd_per_million: z.number().finite().nonnegative().max(1000), cache_read_usd_per_million: z.number().finite().nonnegative().max(1000) }).strict()]),
  pricing_source: z.string().min(1).max(512), seed: z.string().min(1).max(128), repetitions: z.number().int().min(1).max(5),
  per_call_budget_usd: z.number().finite().positive().max(0.25), total_budget_usd: z.number().finite().positive().max(5),
  timeout_ms: z.number().int().min(10).max(30000),
}).strict();
export type PairedRoutingInput = z.infer<typeof PairedRoutingInputSchema>;
const answer = z.object({ category: label, explanation: z.string().max(500) }).strict();
const receipt = z.object({ text: z.string().min(1).max(2048), requested_model: model, reported_model: model, api_reported_model: model, policy_fingerprint: z.string().regex(/^[a-f0-9]{64}$/), process_exit_confirmed: z.literal(true),
  usage: z.object({ input_tokens: z.number().int().nonnegative().max(1000000), output_tokens: z.number().int().nonnegative().max(1000000), cache_creation_input_tokens: z.number().int().nonnegative().max(1000000), cache_read_input_tokens: z.number().int().nonnegative().max(1000000) }).strict(),
}).strict();
export interface PairedRoutingProvider { invoke(prompt: string, signal: AbortSignal): Promise<unknown> }
export interface PairedRoutingResult {
  case_id: string; repetition: number; model_id: string; prompt_sha256: string;
  status: "completed" | "incomplete"; correct: boolean | null; category: z.infer<typeof label> | null;
  requested_model: string; reported_model: string | null; input_tokens: number | null; output_tokens: number | null;
  api_reported_model: string | null; policy_fingerprint: string | null; process_exit_confirmed: boolean; cache_creation_input_tokens: number | null; cache_read_input_tokens: number | null; estimated_cost_usd: number | null; duration_ms: number; error: string | null;
}

/** Shadow comparison only. Labels and training digests never enter provider prompts.
 * Caller must explicitly supply two models and their price source; no default is changed. */
export async function evaluatePairedRouting(raw: unknown, createProvider: (model: string, perCallBudget: number) => PairedRoutingProvider,
  externalSignal?: AbortSignal) {
  const input = PairedRoutingInputSchema.parse(raw);
  if (input.models[0].id === input.models[1].id) throw Error("distinct_models_required");
  if (new Set(input.cases.map(row => row.id)).size !== input.cases.length) throw Error("duplicate_case");
  if (new Set(input.cases.map(row => hash(row.excerpt))).size !== input.cases.length) throw Error("duplicate_prompt");
  const train = new Set(input.training_prompt_sha256);
  if (input.cases.some(row => train.has(hash(row.excerpt)) || train.has(hash(JSON.stringify({ excerpt: row.excerpt }))))) throw Error("holdout_overlap");
  if (input.cases.some(row => Buffer.byteLength(JSON.stringify({ excerpt: row.excerpt })) > 6500)) throw Error("prompt_too_large");
  const maxCalls = input.cases.length * input.repetitions * 2;
  if (maxCalls > 256 || maxCalls * input.per_call_budget_usd > input.total_budget_usd + 1e-12) throw Error("evaluation_budget_insufficient");
  const providers = input.models.map(row => createProvider(row.id, input.per_call_budget_usd));
  const results: PairedRoutingResult[] = []; const errors: string[] = []; let stop = false;
  let reserved = 0; const overallStarted = performance.now();
  for (const [caseIndex, item] of input.cases.entries()) {
    for (let repetition = 0; repetition < input.repetitions && !stop; repetition++) {
      const order = (parseInt(hash(input.seed).slice(0, 2), 16) + caseIndex * input.repetitions + repetition) % 2 === 0 ? [0, 1] : [1, 0];
      for (const index of order) {
        if (performance.now() - overallStarted > 600000) { stop = true; errors.push("aggregate_deadline_exceeded"); break; }
        if (externalSignal?.aborted) { stop = true; errors.push("cancelled"); break; }
        const chosen = input.models[index]!; const provider = providers[index]!;
        // Neither case id nor answer is sent; pair order is stable, counterbalanced and recorded.
        const prompt = JSON.stringify({ excerpt: item.excerpt }); const controller = new AbortController();
        const cancel = () => controller.abort(); externalSignal?.addEventListener("abort", cancel, { once: true });
        const started = performance.now(); let timer: ReturnType<typeof setTimeout> | undefined;
        let timedOut = false; let abortListener: (() => void) | undefined;
        const result: PairedRoutingResult = { case_id: item.id, repetition, model_id: chosen.id, prompt_sha256: hash(prompt),
          status: "incomplete", correct: null, category: null, requested_model: chosen.id, reported_model: null,
          input_tokens: null, output_tokens: null, api_reported_model: null, policy_fingerprint: null, process_exit_confirmed: false, cache_creation_input_tokens: null, cache_read_input_tokens: null, estimated_cost_usd: null, duration_ms: 0, error: null };
        reserved += input.per_call_budget_usd;
        let invocationSettled = false;
        const invocation = Promise.resolve().then(() => provider.invoke(prompt, controller.signal));
        invocation.then(() => { invocationSettled = true; }, () => { invocationSettled = true; });
        try {
          const value = await Promise.race([invocation,
            new Promise<never>((_resolve, reject) => {
              abortListener = () => reject(Error(timedOut ? "deadline_exceeded" : "cancelled"));
              controller.signal.addEventListener("abort", abortListener, { once: true });
              timer = setTimeout(() => { timedOut = true; controller.abort(); }, input.timeout_ms);
              if (controller.signal.aborted) abortListener();
            })]);
          if (value === null || typeof value !== "object" || !("process_exit_confirmed" in value) || value.process_exit_confirmed !== true)
            throw Error("provider_stop_unconfirmed");
          const observed = receipt.parse(value);
          result.reported_model = observed.reported_model;
          result.api_reported_model = observed.api_reported_model; result.policy_fingerprint = observed.policy_fingerprint; result.process_exit_confirmed = observed.process_exit_confirmed;
          result.cache_creation_input_tokens = observed.usage.cache_creation_input_tokens; result.cache_read_input_tokens = observed.usage.cache_read_input_tokens;
          result.input_tokens = observed.usage.input_tokens; result.output_tokens = observed.usage.output_tokens;
          result.estimated_cost_usd = (observed.usage.input_tokens * chosen.input_usd_per_million + observed.usage.output_tokens * chosen.output_usd_per_million + observed.usage.cache_creation_input_tokens * chosen.cache_creation_usd_per_million + observed.usage.cache_read_input_tokens * chosen.cache_read_usd_per_million) / 1000000;
          if (observed.requested_model !== chosen.id || observed.reported_model !== chosen.id || observed.api_reported_model !== chosen.id) throw Error("model_identity_mismatch");
          if (result.estimated_cost_usd > input.per_call_budget_usd + 1e-12) { stop = true; throw Error("estimated_call_budget_exceeded"); }
          const parsed = answer.parse(JSON.parse(observed.text));
          result.category = parsed.category; result.correct = parsed.category === item.expected; result.status = "completed";
        } catch (error) {
          const known = ["model_identity_mismatch", "estimated_call_budget_exceeded", "deadline_exceeded", "cancelled", "not_authenticated", "unsupported_auth_routing", "provider_stop_unconfirmed", "runtime_spawn_unverified", "runtime_sdk_version_mismatch", "runtime_policy_mismatch", "runtime_policy_changed", "runtime_init_unverified", "runtime_spawn_mismatch", "unexpected_runtime_activity", "non_text_activity"];
          result.error = error instanceof Error && known.includes(error.message) ? error.message : "provider_or_output_invalid";
          // Any provider failure ends this qualification attempt. Never spend more
          // against an unverified runtime or compare an easier surviving subset.
          stop = true; errors.push(timedOut ? "evaluation_stopped_after_timeout" : result.error);
        } finally {
          if (timer) clearTimeout(timer); if (abortListener) controller.signal.removeEventListener("abort", abortListener);
          externalSignal?.removeEventListener("abort", cancel); controller.abort();
          // cli-entry exits explicitly after main returns. Give the controlled
          // runtime's 250ms SIGKILL escalation and 1s exit observation time to run.
          if (!invocationSettled) {
            let drainTimer: ReturnType<typeof setTimeout> | undefined;
            await Promise.race([invocation.catch(() => undefined), new Promise<void>(resolve => { drainTimer = setTimeout(resolve, 1500); })]);
            if (drainTimer) clearTimeout(drainTimer);
          }
          result.duration_ms = performance.now() - started;
        }
        results.push(result); if (stop) break;
      }
    }
    if (stop) break;
  }
  const differences: number[] = [];
  for (const item of input.cases) {
    const rows = results.filter(row => row.case_id === item.id);
    if (rows.length !== input.repetitions * 2 || rows.some(row => row.status !== "completed")) continue;
    const scores = input.models.map(m => rows.filter(r => r.model_id === m.id && r.correct).length / input.repetitions);
    differences.push(scores[0]! - scores[1]!);
  }
  const allCompleted = results.length === maxCalls && results.every(row => row.status === "completed");
  const average = allCompleted && differences.length ? differences.reduce((a, b) => a + b, 0) / differences.length : null;
  const radius = allCompleted && differences.length ? Math.sqrt(2 * Math.log(40) / differences.length) : null;
  return {
    schema_version: 1 as const, mode: "paired_holdout" as const, dataset_id: input.dataset_id, dataset_sha256: hash(JSON.stringify(input)), seed: input.seed,
    status: (allCompleted ? "completed" : "incomplete") as "completed" | "incomplete",
    qualification: "observed_no_tools_classification_only" as const, default_route_changed: false as const,
    model_identity_evidence: "requested_and_runtime_reported_not_weights_attestation" as const,
    holdout_evidence: "operator_declared_training_hashes_checked_no_independent_label_review" as const,
    planned_calls: maxCalls, attempted_calls: results.length, reserved_budget_usd: reserved, pricing_source: input.pricing_source,
    cost_basis: "usage_times_operator_supplied_prices_not_invoice" as const,
    paired_cases: differences.length, comparison_available: allCompleted, paired_accuracy_difference: average,
    paired_difference_interval_95: average === null || radius === null ? null : [Math.max(-1, average - radius), Math.min(1, average + radius)],
    interval_method: "Hoeffding_bounded_paired_case_means_assumes_independent_cases_repeats_grouped" as const,
    models: input.models.map(m => {
      const rows = results.filter(row => row.model_id === m.id); const complete = rows.filter(row => row.status === "completed");
      return { model_id: m.id, reserved_cost_usd: rows.length * input.per_call_budget_usd, unknown_usage_calls: rows.filter(row => row.input_tokens === null).length, completed: complete.length, incomplete: rows.length - complete.length,
        accuracy: complete.length === input.cases.length * input.repetitions ? complete.filter(row => row.correct).length / complete.length : null,
        estimated_cost_usd: rows.some(row => row.estimated_cost_usd === null) ? null : rows.reduce((sum, row) => sum + row.estimated_cost_usd!, 0),
        observed_input_tokens: rows.reduce((sum, row) => sum + (row.input_tokens ?? 0), 0), observed_output_tokens: rows.reduce((sum, row) => sum + (row.output_tokens ?? 0), 0) };
    }), results, errors,
  };
}

/** Production entrypoint: existing controlled runtime enforces no tools, one turn,
 * exact requested/runtime model, isolated settings, a spend cap and physical stop. */
export async function runControlledPairedRouting(raw: unknown) {
  const { createScratchDir } = await import("@osstack/core");
  const { createControlledTriageProvider } = await import("@osstack/agents");
  const { join } = await import("node:path");
  const { rm } = await import("node:fs/promises");
  let directory: string | undefined;
  const runtimeRoot = () => directory === undefined
    ? createScratchDir("runtime", "paired-routing").then(path => { directory = path; return path; })
    : Promise.resolve(directory);
  const controller = new AbortController(); const cancel = () => controller.abort();
  // Repeated termination requests must not remove the handler during physical drain.
  process.on("SIGINT", cancel); process.on("SIGTERM", cancel);
  let report: Awaited<ReturnType<typeof evaluatePairedRouting>>;
  try { report = await evaluatePairedRouting(raw, (modelId, budget) => {
    let provider: ReturnType<typeof createControlledTriageProvider> | undefined;
    return { async invoke(prompt, signal) {
      const root = await runtimeRoot();
      provider ??= createControlledTriageProvider({ state_directory: join(root, hash(modelId)), model_id: modelId, max_cost_usd: budget, detailed_receipt: true });
      return provider.invoke(prompt, signal);
    } };
  }, controller.signal); }
  finally { process.removeListener("SIGINT", cancel); process.removeListener("SIGTERM", cancel); }
  // Deadline is logical, not proof that the child exited; retain only those scratch
  // runtimes. Never remove a potentially live process's private directory.
  if (directory !== undefined && report.results.every(row => row.process_exit_confirmed))
    await rm(directory, { recursive: true, force: true });
  return report;
}
