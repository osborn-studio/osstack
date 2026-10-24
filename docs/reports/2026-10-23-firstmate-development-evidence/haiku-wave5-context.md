这是 Haiku wave4 的最后两项缺失源码补证，只核查这两项，不扩大范围、不调用工具。此前结论 C1-C4 已排除且无确认P1；剩余 gate_kind 枚举和 Loop 路径约束如下。请验证 risk_approval/task_authorization 是否覆盖授权门（其余 decision/phase_continue/scope_expand/budget_reconsider 不自行授予权限，scope_expand/budget_reconsider 仍需人类明确输入且collaborator策略另有边界），以及 readAttentionLoop 是否限制 canonical repo（允许范围内绝对路径，拒绝越界与symlink外跳，missing仅输出unknown不读取内容）。同UID可改home/DB不在对抗范围。请1000字以内中文给两项结论及有无已确认阻断，不要因为没附整个仓库而泛泛要求更多文件。

--- packages/protocol/src/session-continuation.ts ---
import { z } from "zod";

const Id = z.string().trim().min(1).max(256);

export const SessionGateKind = z.enum([
  "phase_continue",
  "task_authorization",
  "risk_approval",
  "external_input",
]);
export type SessionGateKind = z.infer<typeof SessionGateKind>;

/** An agent-reported request, never a grant or proof that a gate passed. */
export const SessionContinuationRequest = z.object({
  version: z.literal(1),
  gate_kind: SessionGateKind,
  phase: Id,
  next_action: z.string().trim().min(1).max(1_000),
  evidence_refs: z.array(z.object({
    evidence_id: Id,
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict()).max(32),
}).strict();
export type SessionContinuationRequest = z.infer<typeof SessionContinuationRequest>;

export const SessionDecision = z.object({
  decision_id: Id,
  question: z.string().trim().min(1).max(1_000),
  // Empty choices remain valid for legacy adapters requesting free-form input.
  choices: z.array(z.object({
    choice_id: Id,
    label: z.string().trim().min(1).max(160),
  }).strict()).max(8).refine(
    (choices) => new Set(choices.map((choice) => choice.choice_id)).size === choices.length,
    "choice IDs must be unique",
  ),
  continuation: SessionContinuationRequest.optional(),
}).strict();
export type SessionDecision = z.infer<typeof SessionDecision>;

--- packages/protocol/src/session-continuation.test.ts ---
import { describe, expect, it } from "vitest";
import { SessionDecision, SessionContinuationRequest } from "./session-continuation.js";

const decision = {
  decision_id: "decision_1",
  question: "Continue to verification?",
  choices: [{ choice_id: "continue", label: "Continue" }],
};
const continuation = {
  version: 1,
  gate_kind: "phase_continue",
  phase: "implementation",
  next_action: "Run the frozen acceptance checks",
  evidence_refs: [{ evidence_id: "result_1", sha256: "a".repeat(64) }],
};

describe("session continuation requests", () => {
  it("preserves legacy decisions without inventing a gate", () => {
    expect(SessionDecision.parse(decision)).toEqual(decision);
  });

  it("round-trips a versioned request with evidence references", () => {
    expect(SessionDecision.parse({ ...decision, continuation })).toEqual({ ...decision, continuation });
  });

  it.each(["phase_continue", "task_authorization", "risk_approval", "external_input"])(
    "keeps %s separate from an authorization decision", (gate_kind) => {
      expect(SessionContinuationRequest.parse({ ...continuation, gate_kind }).gate_kind).toBe(gate_kind);
      expect(() => SessionContinuationRequest.parse({ ...continuation, gate_kind, approved: true })).toThrow();
    },
  );

  it("rejects unknown versions, unbound evidence and duplicate choices", () => {
    expect(() => SessionContinuationRequest.parse({ ...continuation, version: 2 })).toThrow();
    expect(() => SessionContinuationRequest.parse({ ...continuation, gate_kind: "auto_approve" })).toThrow();
    expect(() => SessionContinuationRequest.parse({ ...continuation, evidence_refs: [{ evidence_id: "result_1" }] })).toThrow();
    expect(() => SessionDecision.parse({ ...decision, choices: [...decision.choices, ...decision.choices] })).toThrow();
    expect(SessionDecision.parse({ ...decision, choices: [] }).choices).toEqual([]);
  });
});

--- packages/cli/src/attention-loop-source.ts ---
import { open, realpath, lstat } from "node:fs/promises";
import { isAbsolute, relative } from "node:path";
import { LoopState } from "@osstack/loop";
/** No replay or cleanup port. A Loop JSON file is a lossy snapshot source. */
export async function readAttentionLoop(input: {
  repo: string;
  path: string;
  loop_id: string;
}) {
  if (!isAbsolute(input.path) || !isAbsolute(input.repo) || !input.loop_id)
    throw new Error("explicit_loop_binding_required");
  const repo = await realpath(input.repo);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const path = await realpath(input.path);
    const rel = relative(repo, path);
    if (rel.startsWith("..") || isAbsolute(rel))
      throw new Error("loop_outside_scope");
    if (!(await lstat(path)).isFile())
      throw new Error("regular_loop_file_required");
    handle = await open(path, "r");
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 1024 * 1024)
      throw new Error("unsupported_loop_source");
    const buffer = Buffer.alloc(1024 * 1024 + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 1024 * 1024) throw new Error("oversized_loop_source");
    const state = LoopState.parse(
      JSON.parse(buffer.subarray(0, bytesRead).toString("utf8"))
    );
    if (state.loop_id !== input.loop_id)
      throw new Error("loop_identity_conflict");
    return {
      loop_id: input.loop_id,
      path,
      state: "snapshot_available",
      updated_at: state.updated_at,
      in_progress: state.in_progress ?? [],
      pending: state.pending,
      completed_count: state.completed_tasks.length,
      wait: state.wait_reason ?? null,
      process_liveness: "unknown",
      coverage: "snapshot_only",
      gap: "best_effort_snapshot_no_event_replay",
      recovery_required: (state.in_progress ?? []).length > 0,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return {
        loop_id: input.loop_id,
        path: input.path,
        state: "source_missing",
        process_liveness: "unknown",
        coverage: "uncovered",
        gap: "source_missing",
      };
    throw error;
  } finally {
    await handle?.close();
  }
}

--- packages/cli/src/attention-loop-source.test.ts ---
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { readAttentionLoop } from "./attention-loop-source.js";
it("binds exact loop identity and never treats in-progress snapshots as live owners", async () => {
  const root = await mkdtemp(join(tmpdir(), "loop-source-"));
  try {
    const path = join(root, "state.json");
    await writeFile(
      path,
      JSON.stringify({
        loop_id: "l",
        started_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        completed_tasks: [],
        pending: [],
        in_progress: [],
        decisions: [],
      })
    );
    expect(
      await readAttentionLoop({ repo: root, path, loop_id: "l" })
    ).toMatchObject({ process_liveness: "unknown", coverage: "snapshot_only" });
    await expect(
      readAttentionLoop({ repo: root, path, loop_id: "other" })
    ).rejects.toThrow("identity");
    expect(
      await readAttentionLoop({
        repo: root,
        path: join(root, "missing"),
        loop_id: "l",
      })
    ).toMatchObject({ state: "source_missing" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
