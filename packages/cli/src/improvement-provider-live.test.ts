// Explicit paid-provider diagnostic. Only newly generated fixture content reaches models.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { HermesEvent } from "@osstack/hermes-adapter";
import type { AgentAdapter } from "@osstack/agents";
import { defaultConfig } from "@osstack/config";
import { ImprovementExecutionRepository, ImprovementPrDeliveryRepository, improvementProposalDigest, openDb, upsertImprovementProposal } from "@osstack/core";
import { expect, it } from "vitest";
import { executeImprovementCandidate, prepareImprovementCandidate } from "./improvement-candidate.js";
import { createImprovementExecutionAdapters } from "./improvement-execution-adapters.js";
import { deliverImprovementPr, prepareImprovementPrTarget } from "./improvement-pr-delivery.js";
import { simulatedImprovementGithub } from "./improvement-pr-test-fixture.js";
import { resolveLoopProfileRouting } from "./loop-profile-routing.js";

it.skipIf(process.env["OSSTACK_PROVIDER_LIVE_SMOKE"] !== "1")("runs one real Builder and Evaluator through a synthetic candidate-to-PR pipeline", async () => {
  if (process.env["OSSTACK_CODEX_BIN"] || process.env["OSSTACK_KIMI_BIN"]) throw new Error("Live pilot refuses binary overrides; use the installed codex/kimi commands");
  const root = await mkdtemp(join(tmpdir(), "osstack-provider-live-"));
  const home = join(root, "home");
  const repo = join(root, "repo");
  const evidence = join(root, "evidence");
  console.log(`Live provider pilot artifacts: ${root}`);
  await mkdir(home); await mkdir(join(repo, "docs"), { recursive: true });
  await writeFile(join(repo, "docs/guide.md"), "# Fixture guide\n\nUsage instructions are missing.\n");
  const exec = promisify(execFile);
  const git = async (args: string[]) => (await exec("git", ["-c", "core.hooksPath=/dev/null", "-c", "user.name=Pilot", "-c", "user.email=pilot@example.invalid", ...args], { cwd: repo })).stdout.trim();
  await git(["init", "-b", "main"]); await git(["add", "."]); await git(["commit", "-m", "synthetic pilot baseline"]);
  const base = await git(["rev-parse", "HEAD"]);
  const previousHome = process.env["OSSTACK_HOME"];
  process.env["OSSTACK_HOME"] = home;
  const dbPath = join(home, "state.db");
  const db = openDb({ path: dbPath });
  const counts: Record<string, number> = {};
  const observations: Record<string, HermesEvent[]> = {};
  const receipt: Record<string, unknown> = { schema_version: 1, started_at: Date.now() / 1000,
    providers: "live", github: "simulated-local-only", github_pr_created: false, fixture_base: base,
    limits: { builder_invocations: 1, evaluator_invocations: 1, stage_timeout_ms: 120_000, automatic_retries: 0, cost_usd: null },
    invocations: counts, observations, provider_response_ids: { "codex-cli": null, "kimi-code": null }, kimi_usage: null, actual_provider_models: { "codex-cli": null, "kimi-code": null }, outcome: "started" };
  const save = async () => writeFile(join(root, "pilot.json"), JSON.stringify(receipt, null, 2), { mode: 0o600 });
  await save();
  try {
    const routing = await resolveLoopProfileRouting(["--profile", "macbook-pro"], "codex-cli", ["kimi-code"], {
      loadConfig: defaultConfig, adapters: () => createImprovementExecutionAdapters(),
    });
    if (routing === undefined || routing instanceof Error) throw routing ?? new Error("Missing real provider routing");
    receipt.profile = routing.summary; await save();
    const gate = `node -e "const s=require('fs').readFileSync('docs/guide.md','utf8'); if(s!=='# Fixture guide\\n\\nRun the verification command before submitting changes.\\n') process.exit(1)"`;
    const proposal = upsertImprovementProposal(db, dbPath, {
      proposal_id: "provider-pilot", repo_id: "synthetic-fixture", source_asset_ids: ["synthetic-pilot"], target: "docs", risk: "low",
      title: "Document the fixture verification step", rationale: "Set docs/guide.md to exactly the heading # Fixture guide, a blank line, then Run the verification command before submitting changes., ending with one newline. No other content or files.",
      proposed_changes: [{ path: "docs/guide.md", action: "modify", summary: "Replace the missing-instructions placeholder with the required verification sentence." }], required_gates: [gate],
    });
    const github = await simulatedImprovementGithub(root, repo);
    let transportCalls = 0;
    const transport = { run: async (...args: Parameters<typeof github.transport.run>) => { transportCalls++; return github.transport.run(...args); } };
    const target = await prepareImprovementPrTarget({ repoPath: repo, baseSha: base, executionId: "pilot-once", title: proposal.title }, transport);
    const prepared = await prepareImprovementCandidate({ executionId: "pilot-once", expectedDigest: improvementProposalDigest(proposal), proposal,
      repoPath: repo, registryGates: [gate], routing, timeoutMs: 120_000, evidenceRoot: evidence, prDelivery: target });
    const executions = new ImprovementExecutionRepository(db, dbPath);
    const deliveries = new ImprovementPrDeliveryRepository(db, dbPath);
    const adapters = (workspacePath: string, homePath: string): AgentAdapter[] => createImprovementExecutionAdapters({ workspacePath, homePath,
      builderAgentId: routing.agentId, evaluatorAgentId: routing.verifierAgentIds[0]!,
    }).map((adapter) => ({
      id: adapter.id, display_name: adapter.display_name, cost_tier: adapter.cost_tier,
      capabilities: () => adapter.capabilities(), isAvailable: () => adapter.isAvailable(),
      async *invoke(task, signal) {
        counts[adapter.id] = (counts[adapter.id] ?? 0) + 1;
        await save();
        if (counts[adapter.id]! > 1) throw new Error("Pilot invocation budget exceeded");
        observations[adapter.id] = [];
        for await (const event of adapter.invoke(task, signal)) {
          // Keep transport evidence without copying reasoning/tool contents into the pilot report.
          if (event.type === "done" || event.type === "usage.final" || event.type === "error"
            || (event.type === "progress" && "phase" in event.payload && event.payload.phase === "codex.thread.started")) {
            observations[adapter.id]!.push(event); await save();
          }
          if (adapter.id === "kimi-code" && (event.type === "tool.started" || event.type === "tool.done")) throw new Error("Tool-free reviewer emitted tool activity");
          yield event;
        }
      },
    }));
    const result = await executeImprovementCandidate(prepared, executions, adapters);
    receipt.execution = result.execution; await save();
    expect(result.execution.state, `See ${root}/pilot.json`).toBe("candidate_verified");
    await deliverImprovementPr(result.execution, deliveries, transport);
    const delivery = deliveries.get("pilot-once");
    receipt.delivery = { state: delivery?.state, transport: "simulated-local-only" }; receipt.simulated_writes = github.writes; await save();
    expect(delivery?.state).toBe("delivered");
    expect(counts).toEqual({ "codex-cli": 1, "kimi-code": 1 });
    expect(github.writes).toEqual(["push", "pr"]);
    const builderEvidence = observations["codex-cli"] ?? [];
    expect(builderEvidence.some((e) => e.type === "progress" && "detail" in e.payload && /^thread_id=[a-zA-Z0-9-]+$/.test(String(e.payload.detail)))).toBe(true);
    expect(builderEvidence.some((e) => e.type === "usage.final" && "tokens_out" in e.payload && Number(e.payload.tokens_out) > 0)).toBe(true);
    const evaluatorDone = observations["kimi-code"]?.find((e) => e.type === "done");
    expect(evaluatorDone?.payload).toMatchObject({ status: "completed", review: { verdict: "approved", runtime_identity: { adapter_id: "kimi-code" } } });
    const callsBeforeReplay = transportCalls;
    const replay = await executeImprovementCandidate(prepared, executions, adapters);
    expect(replay.replay).toBe(true);
    await deliverImprovementPr(replay.execution, deliveries, transport);
    expect(counts).toEqual({ "codex-cli": 1, "kimi-code": 1 });
    expect(github.writes).toEqual(["push", "pr"]);
    expect(transportCalls).toBe(callsBeforeReplay);
    expect(await git(["rev-parse", "HEAD"])).toBe(base);
    expect(await git(["status", "--porcelain"])).toBe("");
    const patch = await readFile(join(evidence, createHash("sha256").update("pilot-once").digest("hex"), "candidate.patch"));
    receipt.patch_sha256 = createHash("sha256").update(patch).digest("hex");
    receipt.transport_calls = transportCalls;
    receipt.replay_verified = true; receipt.outcome = "passed";
  } catch (error) {
    receipt.outcome = "failed";
    receipt.error = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    receipt.finished_at = Date.now() / 1000;
    await save(); db.close();
    if (previousHome === undefined) delete process.env["OSSTACK_HOME"]; else process.env["OSSTACK_HOME"] = previousHome;
  }
}, 360_000);
