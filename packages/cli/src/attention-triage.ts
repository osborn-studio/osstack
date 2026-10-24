import { attentionDigest, type AttentionTriageLedger, type AttentionTriageSnapshot } from "@osstack/core";
import { z } from "zod";
const Config = z.object({ enabled: z.boolean(), model_id: z.string().regex(/^[a-zA-Z0-9._:-]{1,128}$/),
  calls_per_hour: z.number().int().min(1).max(5), timeout_ms: z.number().int().min(1).max(20000) }).strict();
const Result = z.object({ category: z.enum(["human_decision", "system_wait", "source_uncertain"]), explanation: z.string().max(500) }).strict();
const Receipt = z.object({ text: z.string().max(2048), requested_model: z.string().max(128), reported_model: z.string().max(128),
  usage: z.object({ input_tokens: z.number().int().min(0).max(1000000), output_tokens: z.number().int().min(0).max(1000000) }).strict() }).strict();
export interface AttentionTriageProvider {
  policy(): Promise<{ profile: "claude-triage-no-tools-v1"; model_id: string; fingerprint: string }>;
  invoke(prompt: string, signal: AbortSignal): Promise<z.infer<typeof Receipt>>;
}
export type AttentionTriageConfig = z.infer<typeof Config>;
export interface AttentionTriageOutcome {
  state: "advisory" | "fallback"; applied: false; reason?: string; attempt_id?: string; cached?: boolean;
  deterministic_category: "human_decision" | "source_uncertain"; advisory?: z.infer<typeof Result>;
  input_digest?: string; policy_fingerprint?: string; recorded_at?: number; requested_model?: string; reported_model?: string;
}
interface Active { cancel(reason: string): void }
function fallback(reason: string, input?: AttentionTriageSnapshot, attemptId?: string): AttentionTriageOutcome {
  return { state: "fallback", applied: false, reason, deterministic_category: input?.deterministic_category ?? "source_uncertain", ...(attemptId ? { attempt_id: attemptId } : {}) };
}
function preflight<T>(promise: Promise<T>, timeout: number, signals: AbortSignal[]): Promise<T> {
  return new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); for (const signal of signals) signal.removeEventListener("abort", abort); };
    const abort = () => { cleanup(); reject(Error("cancelled")); };
    const timer = setTimeout(() => { cleanup(); reject(Error("provider_preflight_timeout")); }, timeout);
    for (const signal of signals) { signal.addEventListener("abort", abort, { once: true }); if (signal.aborted) { abort(); break; } }
    promise.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
  });
}
/** Host-owned explicit queue: never called from observer ticks or inbox reads. */
export class AttentionTriageService {
  private readonly config: AttentionTriageConfig;
  private provider: Promise<AttentionTriageProvider> | undefined;
  private preparing = false;
  private readonly active = new Map<string, Active>();
  private stopped = false;
  private readonly stopping = new AbortController();
  constructor(private readonly deps: { ledger: AttentionTriageLedger; config: AttentionTriageConfig; providerFactory: () => Promise<AttentionTriageProvider> }) {
    this.config = Config.parse(deps.config);
    if (this.config.enabled) deps.ledger.recover();
  }
  async run(request: { scope_id: string; item_id: string; model_id: string }, signal?: AbortSignal): Promise<AttentionTriageOutcome> {
    if (!this.config.enabled) return fallback("triage_disabled");
    if (this.stopped || signal?.aborted) return fallback("cancelled");
    if (request.model_id !== this.config.model_id) return fallback("model_not_configured");
    if (this.preparing) return fallback("triage_preparing");
    const startedAt = performance.now();
    let provider: AttentionTriageProvider; let policy: Awaited<ReturnType<AttentionTriageProvider["policy"]>>;
    try {
      this.provider ??= this.deps.providerFactory().catch(error => { this.provider = undefined; throw error; });
      this.preparing = true;
      const preparation = this.provider.then(async value => ({ provider: value, policy: await value.policy() }));
      void preparation.then(() => { this.preparing = false; }, () => { this.preparing = false; });
      const prepared = await preflight(preparation, this.config.timeout_ms, [this.stopping.signal, ...(signal ? [signal] : [])]);
      provider = prepared.provider; policy = prepared.policy;
      if (policy.profile !== "claude-triage-no-tools-v1" || policy.model_id !== request.model_id || !/^[a-f0-9]{64}$/.test(policy.fingerprint)) return fallback("provider_policy_unverified");
    } catch (error) { return fallback(error instanceof Error && ["cancelled", "provider_preflight_timeout"].includes(error.message) ? error.message : "provider_unavailable"); }
    if (this.stopped || signal?.aborted) return fallback("cancelled");
    const remainingMs = Math.floor(this.config.timeout_ms - (performance.now() - startedAt));
    if (remainingMs < 1) return fallback("timeout_before_reservation");
    let admission: ReturnType<AttentionTriageLedger["reserve"]>;
    try { admission = this.deps.ledger.reserve({ ...request, policy_fingerprint: policy.fingerprint, calls_per_hour: this.config.calls_per_hour, timeout_ms: remainingMs }); }
    catch { return fallback("budget_unavailable"); }
    if (admission.state === "fallback") return fallback(admission.reason);
    if (admission.state === "cached") return { state: "advisory", applied: false, attempt_id: admission.attempt_id, cached: true,
      deterministic_category: admission.input.deterministic_category, advisory: admission.result, input_digest: admission.input.input_digest,
      requested_model: request.model_id, reported_model: request.model_id, policy_fingerprint: policy.fingerprint, recorded_at: admission.recorded_at };
    const { attempt_id: attemptId, input } = admission;
    try { this.deps.ledger.start(attemptId); } catch {
      try { this.deps.ledger.finish(attemptId, { status: "failed", reason: "not_started" }); } catch { /* active reservation remains diagnosable */ }
      return fallback("budget_unavailable", input, attemptId);
    }
    const invocationMs = Math.floor(this.config.timeout_ms - (performance.now() - startedAt));
    if (invocationMs < 1) {
      try { this.deps.ledger.finish(attemptId, { status: "failed", reason: "not_started_timeout" }); } catch { /* no provider invocation occurred */ }
      return fallback("timeout_before_invocation", input, attemptId);
    }
    const controller = new AbortController();
    return new Promise<AttentionTriageOutcome>(resolve => {
      let done = false;
      const finishLogical = (outcome: AttentionTriageOutcome) => { if (done) return; done = true; clearTimeout(timer); signal?.removeEventListener("abort", abort); resolve(outcome); };
      const cancel = (reason: string) => {
        if (done) return;
        try { this.deps.ledger.finish(attemptId, { status: "unknown", reason }); } catch { /* persisted active slot remains fail-closed */ }
        controller.abort(); finishLogical(fallback(reason, input, attemptId));
      };
      const abort = () => cancel("cancelled"); const timer = setTimeout(() => cancel("timeout"), invocationMs);
      this.active.set(attemptId, { cancel }); signal?.addEventListener("abort", abort, { once: true });
      // Always observe settlement. Late/aborted responses can release the old slot only;
      // they cannot become successful cached advice or touch a closed daemon DB.
      void Promise.resolve().then(() => { if (controller.signal.aborted) throw Error("cancelled"); return provider.invoke(JSON.stringify(input), controller.signal); }).then(raw => {
        if (this.stopped) return;
        if (done) { try { this.deps.ledger.finish(attemptId, { status: "failed", reason: "late_provider_terminated" }); } catch { /* stale owner or closed DB */ } return; }
        if (performance.now() - startedAt > this.config.timeout_ms) {
          try { this.deps.ledger.finish(attemptId, { status: "failed", reason: "late_result_expired" }); } catch { /* retain unresolved reservation */ }
          finishLogical(fallback("outcome_unconfirmed", input, attemptId)); return;
        }
        let verifiedReceipt: z.infer<typeof Receipt> | undefined;
        try {
          const receipt = Receipt.parse(raw);
          if (receipt.requested_model !== request.model_id || receipt.reported_model !== request.model_id || Buffer.byteLength(receipt.text) > 2048) throw Error("provider_receipt_unverified");
          verifiedReceipt = receipt;
          const result = Result.parse(JSON.parse(receipt.text));
          const completed = this.deps.ledger.finish(attemptId, { status: "succeeded", result, usage: receipt.usage, reported_model: receipt.reported_model });
          finishLogical(completed.status === "succeeded" ? { state: "advisory", applied: false, attempt_id: attemptId, cached: false,
            deterministic_category: input.deterministic_category, advisory: result, input_digest: input.input_digest,
            requested_model: request.model_id, reported_model: receipt.reported_model, policy_fingerprint: policy.fingerprint, recorded_at: admission.recorded_at } : fallback(completed.status === "stale" ? "source_changed" : "outcome_unconfirmed", input, attemptId));
        } catch {
          try { this.deps.ledger.finish(attemptId, { status: "failed", reason: "invalid_provider_receipt", ...(verifiedReceipt ? { usage: verifiedReceipt.usage, reported_model: verifiedReceipt.reported_model } : {}) }); } catch { /* keep active reservation if persistence is uncertain */ }
          finishLogical(fallback("invalid_provider_receipt", input, attemptId));
        }
      }, error => {
        if (this.stopped) return;
        const reason = error instanceof Error && ["not_authenticated", "unsupported_auth_routing", "runtime_policy_mismatch", "provider_stop_unconfirmed", "cancelled"].includes(error.message) ? error.message : "provider_error";
        try { this.deps.ledger.finish(attemptId, { status: reason === "provider_stop_unconfirmed" ? "unknown" : "failed", reason }); } catch { /* retain quarantined budget */ }
        finishLogical(fallback(reason, input, attemptId));
      }).finally(() => { this.active.delete(attemptId); });
    });
  }
  diagnostics(scopeId: string): { state: string; enabled?: boolean; quarantine?: { attempt_id: string; reason: string | null; reserved_at: number } } {
    if (this.preparing) return { state: "provider_initialization_pending" };
    this.deps.ledger.store.assertOwner(this.deps.ledger.owner);
    const scope = this.deps.ledger.store.getScope(scopeId);
    const task = scope ? this.deps.ledger.store.db.prepare("SELECT created_at FROM tasks WHERE task_id=? AND tenant_id IS NULL").get(scope.task_id) as { created_at: number } | undefined : undefined;
    if (!scope || !task || attentionDigest([this.deps.ledger.owner.home_id, scope.task_id, scope.repo_path, task.created_at]) !== scopeId) return { state: "source_unknown" };
    const quarantined = this.deps.ledger.activeAttempt();
    if (!quarantined) return { state: this.config.enabled ? "no_quarantine" : "disabled" };
    const row = this.deps.ledger.store.db.prepare("SELECT scope_id FROM attention_triage_attempts WHERE attempt_id=?").get(quarantined.attempt_id) as { scope_id: string };
    return row.scope_id === scopeId ? { state: quarantined.status === "unknown" ? "quarantined" : "busy", quarantine: quarantined, enabled: this.config.enabled } : { state: "busy_elsewhere" };
  }
  async stop(): Promise<void> {
    if (this.stopped) return;
    for (const active of this.active.values()) active.cancel("daemon_stopped");
    this.stopped = true; this.stopping.abort();
  }
}
export function createAttentionTriageService(deps: ConstructorParameters<typeof AttentionTriageService>[0]) { return new AttentionTriageService(deps); }
export async function handleAttentionTriageCommand(args: string[], io: { rpc: (method: string, params?: unknown, timeoutMs?: number) => Promise<unknown>; stdout?: (line: string) => void }): Promise<number> {
  const flags = new Map<string, string>(); let status = false; let json = false;
  for (let index = 1; index < args.length; index++) {
    if (args[index] === "--json" && !json) { json = true; continue; }
    if (args[index] === "--status" && !status) { status = true; continue; }
    const key = args[index]!; const value = args[++index];
    if (!["--scope", "--item", "--model"].includes(key) || flags.has(key) || !value || value.startsWith("--")) throw Error("invalid_triage_arguments");
    flags.set(key, value);
  }
  if (status) {
    if (flags.size !== 1 || !flags.has("--scope")) throw Error("explicit_status_scope_required");
    const response = z.object({ ok: z.literal(true), result: z.object({ state: z.string().max(64) }).passthrough() }).passthrough().parse(await io.rpc("attention.triage-status", { scope_id: flags.get("--scope")! }, 1000));
    (io.stdout ?? console.log)(serializeTriage(response.result)); return 0;
  }
  if (flags.size !== 3) throw Error("explicit_scope_item_model_required");
  const response = z.object({ ok: z.literal(true), result: z.object({ state: z.enum(["advisory", "fallback"]), applied: z.literal(false) }).passthrough() }).passthrough().parse(
    await io.rpc("attention.triage", { scope_id: flags.get("--scope")!, item_id: flags.get("--item")!, model_id: flags.get("--model")! }, 25000));
  (io.stdout ?? console.log)(serializeTriage(response.result)); return response.result.state === "advisory" ? 0 : 1;
}

function serializeTriage(value: unknown): string {
  return JSON.stringify(value, null, 2).replace(/[\u007f-\u009f]/g, character => "\\u" + character.charCodeAt(0).toString(16).padStart(4, "0"));
}
