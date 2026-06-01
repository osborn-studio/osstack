// OpenTelemetry tracing for osstack (D14: middle-tier observability).
//
// Default: disabled. Enable by setting OTEL_EXPORTER_OTLP_ENDPOINT (the
// standard OTel env var). When enabled we register an OTLP/HTTP trace
// exporter via BatchSpanProcessor (5s flush, 512 max-queue) and expose a
// tracer module + helpers. When disabled, the helpers no-op so callers
// can always `await traceSpan(...)` without conditional code paths.
//
// Why HTTP rather than gRPC: easier to traverse local dev environments,
// smaller dependency surface, and good enough for our throughput.

import { trace, context, SpanStatusCode, type Tracer, type Span } from "@opentelemetry/api";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION,
} from "@opentelemetry/semantic-conventions";

export const OSSTACK_SERVICE_NAME = "osstack";
export const OSSTACK_TRACER_NAME = "osstack-daemon";

let sdk: NodeSDK | null = null;
let started = false;

export interface OtelInitOptions {
  /** Service version (default "0.0.0"). */
  serviceVersion?: string;
  /** Override OTLP endpoint. Default: OTEL_EXPORTER_OTLP_ENDPOINT env. */
  endpoint?: string;
  /** Force-enable or force-disable; default reads env. */
  enabled?: boolean;
}

/** Returns true iff OTel tracing is currently active. */
export function otelEnabled(): boolean { return started; }

/**
 * Initialize the OTel SDK if an endpoint is configured. Idempotent.
 * Call once at daemon startup; the corresponding shutdownOtel() can be
 * called from the daemon's shutdown handler.
 */
export function initOtel(opts: OtelInitOptions = {}): void {
  if (started) return;
  const endpoint = opts.endpoint ?? process.env["OTEL_EXPORTER_OTLP_ENDPOINT"];
  const enabled = opts.enabled ?? Boolean(endpoint);
  if (!enabled || !endpoint) return;

  const exporterUrl = endpoint.endsWith("/v1/traces") ? endpoint : `${endpoint.replace(/\/$/, "")}/v1/traces`;
  const exporter = new OTLPTraceExporter({ url: exporterUrl });

  sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: OSSTACK_SERVICE_NAME,
      [ATTR_SERVICE_VERSION]: opts.serviceVersion ?? "0.0.0",
    }),
    traceExporter: exporter,
  });
  try {
    sdk.start();
    started = true;
  } catch (err) {
    // Never fail the daemon over telemetry init. Log and move on.
    process.stderr.write(
      `osstack: OTel init failed (${err instanceof Error ? err.message : String(err)}); continuing without tracing.\n`,
    );
    sdk = null;
  }
}

export async function shutdownOtel(): Promise<void> {
  if (!sdk) return;
  try { await sdk.shutdown(); } catch { /* best-effort */ }
  sdk = null;
  started = false;
}

export function tracer(): Tracer {
  return trace.getTracer(OSSTACK_TRACER_NAME);
}

/**
 * Run `fn` inside a span. If OTel is disabled, just invokes `fn` directly.
 * Errors are caught, recorded on the span, and rethrown.
 */
export async function traceSpan<T>(
  name: string,
  attributes: Record<string, string | number | boolean>,
  fn: (span: Span | null) => Promise<T>,
): Promise<T> {
  if (!started) return await fn(null);
  return await tracer().startActiveSpan(name, { attributes }, async (span) => {
    try {
      const result = await fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (err) {
      span.recordException(err as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message });
      throw err;
    } finally {
      span.end();
    }
  });
}

/** Get the active span (for adding ad-hoc attributes mid-operation). */
export function activeSpan(): Span | null {
  if (!started) return null;
  const span = trace.getActiveSpan();
  return span ?? null;
}

// Re-export the runtime APIs callers most often need.
export { context as otelContext };
