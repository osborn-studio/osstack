// GBrain adapter — writes one page per osstack run to the user's gbrain.
//
// gbrain (https://github.com/garrytan/gbrain) is the self-wiring knowledge
// graph osstack delegates KG duties to (per plan v0.6 D20). It already
// extracts entity references and creates typed links with no LLM calls;
// our job is just to feed it well-formed markdown pages and let it wire.
//
// Like HermesBridge, this is best-effort shell-out — never blocks the
// underlying task. Disabled by default; enable by setting OSSTACK_GBRAIN=1
// or passing { enabled: true }.

import { spawn } from "node:child_process";

export interface GBrainAdapterOptions {
  bin?: string;
  enabled?: boolean;
}

export interface GBrainResult {
  ok: boolean;
  page_slug?: string;
  stdout?: string;
  stderr?: string;
  reason?: string;
  exit_code?: number;
}

export interface RunPageInput {
  /** osstack run_id, also used as the gbrain page slug. */
  run_id: string;
  task_title: string;
  agent_id: string;
  capability_id: string;
  outcome: "completed" | "failed" | "cancelled" | "expired";
  duration_ms: number;
  tokens_in: number;
  tokens_out: number;
  started_at: number;
  /** Optional final summary or last assistant message snippet. */
  result_summary?: string;
}

function fmtTime(unix: number): string {
  return new Date(unix * 1000).toISOString();
}

/** Build the markdown body for a run page. */
export function renderRunPage(input: RunPageInput): string {
  const slug = `osstack-run-${input.run_id}`;
  const front = [
    "---",
    `type: osstack-run`,
    `agent: ${input.agent_id}`,
    `capability: ${input.capability_id}`,
    `outcome: ${input.outcome}`,
    `started_at: ${fmtTime(input.started_at)}`,
    `duration_ms: ${input.duration_ms.toFixed(0)}`,
    `tokens_in: ${input.tokens_in}`,
    `tokens_out: ${input.tokens_out}`,
    `tags: [osstack, ${input.agent_id}]`,
    "---",
  ].join("\n");

  const body = [
    `# ${input.task_title}`,
    "",
    `Executed by **${input.agent_id}** via osstack run \`${input.run_id}\`.`,
    "",
    `- **Outcome:** ${input.outcome}`,
    `- **Capability:** \`${input.capability_id}\``,
    `- **Duration:** ${(input.duration_ms / 1000).toFixed(1)}s`,
    `- **Tokens:** ${input.tokens_in} in / ${input.tokens_out} out`,
    "",
    input.result_summary
      ? "## Result\n\n" + input.result_summary
      : "_No final result summary was emitted by the adapter._",
  ].join("\n");

  return `${front}\n\n<!-- slug:${slug} -->\n\n${body}\n`;
}

export class GBrainAdapter {
  readonly bin: string;
  readonly enabled: boolean;

  constructor(opts: GBrainAdapterOptions = {}) {
    this.bin = opts.bin ?? process.env["OSSTACK_GBRAIN_BIN"] ?? "gbrain";
    this.enabled = opts.enabled ?? process.env["OSSTACK_GBRAIN"] === "1";
  }

  async writeRunPage(input: RunPageInput): Promise<GBrainResult> {
    if (!this.enabled) return { ok: true, reason: "gbrain_disabled" };
    const slug = `osstack-run-${input.run_id}`;
    const body = renderRunPage(input);
    return await new Promise<GBrainResult>((resolve) => {
      const p = spawn(this.bin, ["put", slug], { stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      const t = setTimeout(() => {
        p.kill("SIGTERM");
        resolve({ ok: false, reason: "timeout" });
      }, 15_000);
      p.stdout.on("data", (c) => { stdout += String(c); });
      p.stderr.on("data", (c) => { stderr += String(c); });
      p.on("error", (err) => {
        clearTimeout(t);
        resolve({ ok: false, reason: `spawn_failed: ${err.message}` });
      });
      p.on("exit", (code) => {
        clearTimeout(t);
        resolve({
          ok: code === 0,
          page_slug: slug,
          stdout: stdout.trim(),
          stderr: stderr.trim(),
          exit_code: code ?? -1,
          ...(code !== 0 ? { reason: `non_zero_exit_${code}` } : {}),
        });
      });
      p.stdin.write(body);
      p.stdin.end();
    });
  }
}
