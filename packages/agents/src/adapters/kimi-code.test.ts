import { mkdtempSync } from "node:fs";
import { chmod, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { HermesEventSchema, type HermesEvent } from "@osstack/hermes-adapter";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentTask } from "../base.js";
import { KimiCodeAdapter } from "./kimi-code.js";

const reviewAgentFile = join(
  dirname(fileURLToPath(import.meta.url)),
  "kimi-review-agent.md",
);

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "osstack-kimi-code-"));
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
  delete process.env["OSSTACK_FAKE_APPROVAL_SECRET"];
  delete process.env["TELEGRAM_BOT_TOKEN"];
});

describe("KimiCodeAdapter", () => {
  it("uses an explicit child environment for readiness and structured review", async () => {
    const log = join(tmp, "env.log");
    const result = reviewResult("approved");
    const bin = await fakeCommand("kimi-env", `
printf '%s|%s\\n' "$OSSTACK_HOME" "$OSSTACK_AUTOAPPROVE" >> '${log}'
if [ "\${1:-}" = "--version" ]; then printf '0.29.1\\n'; exit 0; fi
if [ "\${1:-}" = "provider" ]; then printf 'managed:kimi-code type=kimi models=4 source=oauth\\nDefault model: k3-256k\\n'; exit 0; fi
printf '%s\\n' ${shellQuote(streamEvent(result))}
`);
    const adapter = new KimiCodeAdapter({ bin, reviewAgentFile, model: "k3-256k",
      env: { PATH: process.env["PATH"], HOME: process.env["HOME"], OSSTACK_HOME: join(tmp, "control"), OSSTACK_AUTOAPPROVE: "0" } });
    expect((await adapter.isAvailable()).available).toBe(true);
    expect(doneStatus(await drain(adapter.invoke(task(), new AbortController().signal)))).toBe("completed");
    expect((await readFile(log, "utf8")).trim().split("\n")).toEqual(Array(3).fill(`${join(tmp, "control")}|0`));
  });

  it("advertises only read-only review and release verification", () => {
    const adapter = new KimiCodeAdapter({ bin: "missing-kimi" });

    expect(adapter.capabilities().map((capability) => capability.kind).sort()).toEqual([
      "code.review",
      "release.verify",
    ]);
  });

  it("probes the installed CLI version without invoking a model", async () => {
    const bin = await fakeCommand("kimi-version", `
if [ "\${1:-}" = "--version" ]; then
  printf 'Kimi Code CLI 0.29.1\\n'
  exit 0
fi
if [ "\${1:-}" = "provider" ] && [ "\${2:-}" = "list" ]; then
  printf 'managed:kimi-code  type=kimi  models=4  source=oauth\\n\\nDefault model: kimi-code/k3\\n'
  exit 0
fi
exit 91
`);
    const adapter = adapterFor(bin);

    await expect(adapter.readiness()).resolves.toMatchObject({
      state: "kimi_available",
      version: "0.29.1",
    });
    await expect(adapter.isAvailable()).resolves.toMatchObject({
      available: true,
    });
    await expect(adapter.runtimeIdentity()).resolves.toMatchObject({
      adapter_id: "kimi-code",
      adapter_version: "0.29.1",
      auth_mode: "subprocess/login-reuse",
      provider_id: "kimi",
      model_id: "k3-256k",
      agent_profile: "osstack-reviewer",
      evidence_source: "configured",
    });
    const reportedAdapter = new KimiCodeAdapter({
      bin,
      reviewAgentFile,
      timeoutMs: 5_000,
    });
    await reportedAdapter.readiness();
    await expect(reportedAdapter.runtimeIdentity()).resolves.toMatchObject({
      provider_id: "kimi",
      model_id: "kimi-code/k3",
      evidence_source: "reported",
    });
  });

  it("reports unavailable when the CLI binary is missing", async () => {
    const adapter = adapterFor(join(tmp, "missing-kimi"));

    const availability = await adapter.isAvailable();

    expect(availability.available).toBe(false);
    expect(availability.reason).toContain("not installed");
  });

  it("distinguishes installed but unauthenticated from a missing binary", async () => {
    const bin = await fakeCommand("kimi-unauthenticated", `
if [ "\${1:-}" = "--version" ]; then printf '0.29.1\\n'; exit 0; fi
if [ "\${1:-}" = "provider" ] && [ "\${2:-}" = "list" ]; then
  printf 'login required\\n' >&2
  exit 17
fi
exit 91
`);
    const adapter = adapterFor(bin);

    await expect(adapter.readiness()).resolves.toMatchObject({
      state: "kimi_not_authenticated",
      version: "0.29.1",
      reason: expect.stringContaining("not authenticated"),
    });
    await expect(adapter.isAvailable()).resolves.toMatchObject({
      available: false,
      reason: expect.stringContaining("not authenticated"),
    });
  });

  it("emits a schema-valid approved structured review", async () => {
    const argsLog = join(tmp, "args.log");
    const cwdLog = join(tmp, "cwd.log");
    process.env["OSSTACK_FAKE_APPROVAL_SECRET"] = "must-not-cross";
    process.env["TELEGRAM_BOT_TOKEN"] = "must-not-cross-either";
    const bin = await fakeCommand("kimi-approved", `
if [ "\${1:-}" = "--version" ]; then printf '0.29.1\\n'; exit 0; fi
if [ -n "\${OSSTACK_FAKE_APPROVAL_SECRET:-}" ] || [ -n "\${TELEGRAM_BOT_TOKEN:-}" ]; then
  printf 'secret leaked\\n' >&2
  exit 90
fi
printf '%s\\n' "$*" > ${JSON.stringify(argsLog)}
printf '%s\\n' "$PWD" > ${JSON.stringify(cwdLog)}
printf '%s\\n' ${shellQuote(streamEvent(reviewResult("approved")))}
`);
    const events = await drain(adapterFor(bin).invoke(
      task("UNTRUSTED_RAW_PROMPT_SHOULD_NOT_CROSS"),
      new AbortController().signal,
    ));

    for (const event of events) HermesEventSchema.parse(event);
    expect(doneStatus(events), JSON.stringify(events, null, 2)).toBe("completed");
    expect(doneReview(events)).toMatchObject({
      schema_version: 1,
      verdict: "approved",
      risk: "read_only",
      judgments: [{
        id: "correctness",
        pass: true,
        severity: "error",
      }],
      runtime_identity: {
        adapter_id: "kimi-code",
        adapter_version: "0.29.1",
      },
    });
    await expect(readFile(argsLog, "utf8")).resolves.toContain("--agent-file");
    await expect(readFile(argsLog, "utf8")).resolves.toContain("--skills-dir");
    await expect(readFile(argsLog, "utf8")).resolves.toContain("diff --git");
    await expect(readFile(argsLog, "utf8")).resolves.not.toContain(
      "UNTRUSTED_RAW_PROMPT_SHOULD_NOT_CROSS",
    );
    await expect(readFile(cwdLog, "utf8")).resolves.not.toContain(tmp);
  });

  it("maps a zero-exit changes_requested verdict to failed", async () => {
    const bin = await resultCommand("kimi-changes", reviewResult("changes_requested"));
    const events = await drain(adapterFor(bin).invoke(
      task(),
      new AbortController().signal,
    ));

    expect(doneStatus(events)).toBe("failed");
    expect(doneReview(events), JSON.stringify(events, null, 2)).toMatchObject({
      verdict: "changes_requested",
    });
  });

  it("defaults to the model alias observed on the execution node", async () => {
    const bin = await resultCommand(
      "kimi-default-model",
      reviewResult("approved", "kimi-code/k3"),
    );
    const events = await drain(new KimiCodeAdapter({
      bin,
      reviewAgentFile,
      timeoutMs: 5_000,
    }).invoke(task(), new AbortController().signal));

    expect(doneStatus(events), JSON.stringify(events, null, 2)).toBe("completed");
    expect(doneReview(events)).toMatchObject({
      runtime_identity: { model_id: "kimi-code/k3" },
    });
  });

  it("rejects model identity that does not match the invocation", async () => {
    const bin = await resultCommand(
      "kimi-model-mismatch",
      reviewResult("approved", "different-model"),
    );
    const events = await drain(adapterFor(bin).invoke(
      task(),
      new AbortController().signal,
    ));

    expect(errorCode(events)).toBe("kimi_review_invalid");
    expect(doneStatus(events)).toBe("failed");
    expect(doneReview(events)).toBeUndefined();
  });

  it("fails closed on non-zero exit", async () => {
    const bin = await fakeCommand("kimi-failed", `
if [ "\${1:-}" = "--version" ]; then printf '0.29.1\\n'; exit 0; fi
printf 'provider unavailable\\n' >&2
exit 17
`);
    const events = await drain(adapterFor(bin).invoke(
      task(),
      new AbortController().signal,
    ));

    expect(errorCode(events)).toBe("kimi_process_failed");
    expect(doneStatus(events)).toBe("failed");
    expect(doneReview(events)).toBeUndefined();
  });

  it("fails closed on timeout", async () => {
    const bin = await fakeCommand("kimi-timeout", `
if [ "\${1:-}" = "--version" ]; then printf '0.29.1\\n'; exit 0; fi
sleep 2
`);
    const events = await drain(new KimiCodeAdapter({
      bin,
      model: "k3-256k",
      reviewAgentFile,
      timeoutMs: 20,
    }).invoke(task(), new AbortController().signal));

    expect(errorCode(events)).toBe("kimi_timeout");
    expect(doneStatus(events)).toBe("failed");
  });

  it("cancels the subprocess through AbortSignal", async () => {
    const bin = await fakeCommand("kimi-cancel", `
if [ "\${1:-}" = "--version" ]; then printf '0.29.1\\n'; exit 0; fi
sleep 2
`);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);

    const events = await drain(adapterFor(bin).invoke(task(), controller.signal));

    expect(doneStatus(events)).toBe("cancelled");
  });

  it.each([
    ["malformed stream", '{"role":"assistant","content":', "kimi_review_invalid"],
    ["missing result sentinel", '{"role":"assistant","content":"review only"}', "kimi_review_invalid"],
    [
      "duplicate result sentinel",
      `${streamEvent(reviewResult("approved"))}\n${streamEvent(reviewResult("approved"))}`,
      "kimi_review_invalid",
    ],
  ])("fails closed on %s", async (_label, output, expectedCode) => {
    const bin = await fakeCommand("kimi-invalid", `
if [ "\${1:-}" = "--version" ]; then printf '0.29.1\\n'; exit 0; fi
printf '%s\\n' ${shellQuote(output)}
`);
    const events = await drain(adapterFor(bin).invoke(
      task(),
      new AbortController().signal,
    ));

    expect(errorCode(events)).toBe(expectedCode);
    expect(doneStatus(events)).toBe("failed");
  });

  it("fails closed when the output byte limit is exceeded", async () => {
    const bin = await fakeCommand("kimi-output-limit", `
if [ "\${1:-}" = "--version" ]; then printf '0.29.1\\n'; exit 0; fi
printf '{"role":"assistant","content":"%0200d"}\\n' 1
`);
    const events = await drain(new KimiCodeAdapter({
      bin,
      model: "k3-256k",
      reviewAgentFile,
      outputLimit: 64,
    }).invoke(task(), new AbortController().signal));

    expect(errorCode(events)).toBe("kimi_output_limit");
    expect(doneStatus(events)).toBe("failed");
  });

  it("rejects review input that has not crossed the deterministic boundary", async () => {
    const bin = await resultCommand("kimi-unused", reviewResult("approved"));
    const unboundedTask: AgentTask = {
      ...task(),
      context: { repo_path: tmp },
    };

    const events = await drain(adapterFor(bin).invoke(
      unboundedTask,
      new AbortController().signal,
    ));

    expect(errorCode(events)).toBe("kimi_review_boundary_invalid");
    expect(doneStatus(events)).toBe("failed");
  });

  it("ships an agent policy with no tools or subagents", async () => {
    const policy = await readFile(reviewAgentFile, "utf8");

    expect(policy).toMatch(/\ntools: \[\]\n/);
    expect(policy).toMatch(/\nsubagents: \[\]\n/);
  });
});

function adapterFor(bin: string): KimiCodeAdapter {
  return new KimiCodeAdapter({
    bin,
    model: "k3-256k",
    reviewAgentFile,
    timeoutMs: 5_000,
    outputLimit: 64_000,
  });
}

function task(prompt = "review bounded change"): AgentTask {
  return {
    run_id: "run_1_verify_kimi-code",
    task_id: "task-1",
    session_id: "session-1",
    capability_id: "kimi-code.code.review",
    prompt,
    context: {
      repo_path: tmp,
      kimi_review_input: {
        schema_version: 1,
        task: "Review the supplied bounded change.",
        evaluation_criteria: [{
          id: "correctness",
          requirement: "The change is correct and safe.",
        }],
        changed_paths: ["src/app.ts"],
        diff: "diff --git a/src/app.ts b/src/app.ts\n+export const ok = true;\n",
        deterministic_results: [{
          command: "pnpm test",
          exit_code: 0,
          summary: "Tests passed.",
        }],
        evidence_refs: ["proof/tests.json"],
      },
    },
  };
}

function reviewResult(
  verdict: "approved" | "changes_requested",
  model = "k3-256k",
): Record<string, unknown> {
  return {
    schema_version: 1,
    review_id: "review_1",
    subject_run_id: "run_1_verify_kimi-code",
    reviewer: {
      adapter: "kimi-code",
      provider: "kimi",
      model,
    },
    verdict,
    risk: "read_only",
    markdown: "# Review\n\nReview complete.",
    evaluation_judgments: [{
      id: "correctness",
      pass: verdict === "approved",
      severity: "error",
      summary: verdict === "approved" ? "No blocking defect." : "A change is required.",
    }],
    findings: [],
    recommended_actions: verdict === "approved" ? [] : ["Address the failed criterion."],
  };
}

function streamEvent(result: Record<string, unknown>): string {
  return JSON.stringify({
    role: "assistant",
    content: `Review complete.\nOSSTACK_REVIEW_RESULT=${JSON.stringify(result)}`,
  });
}

async function resultCommand(
  name: string,
  result: Record<string, unknown>,
): Promise<string> {
  return fakeCommand(name, `
if [ "\${1:-}" = "--version" ]; then printf '0.29.1\\n'; exit 0; fi
printf '%s\\n' ${shellQuote(streamEvent(result))}
`);
}

async function fakeCommand(name: string, body: string): Promise<string> {
  const bin = join(tmp, name);
  await writeFile(
    bin,
    `#!/usr/bin/env bash\nset -euo pipefail\n${body}\n`,
    "utf8",
  );
  await chmod(bin, 0o755);
  return bin;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

async function drain(iterable: AsyncIterable<HermesEvent>): Promise<HermesEvent[]> {
  const events: HermesEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

function doneStatus(events: HermesEvent[]): string | undefined {
  const done = [...events].reverse().find((event) => event.type === "done");
  return done === undefined
    ? undefined
    : String((done.payload as { status?: unknown }).status);
}

function doneReview(events: HermesEvent[]): unknown {
  const done = [...events].reverse().find((event) => event.type === "done");
  return (done?.payload as { review?: unknown } | undefined)?.review;
}

function errorCode(events: HermesEvent[]): string | undefined {
  const error = events.find((event) => event.type === "error");
  return error === undefined
    ? undefined
    : String((error.payload as { code?: unknown }).code);
}
