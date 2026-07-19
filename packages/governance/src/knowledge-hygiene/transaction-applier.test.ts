import { createHash } from "node:crypto";
import {
  chmod,
  link,
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  KnowledgeHygieneSimulatedCrashV1,
  applyKnowledgeHygieneTransactionPlanV1,
  recoverKnowledgeHygieneTransactionPlanV1,
} from "./transaction-applier.js";
import { buildKnowledgeHygieneTransactionPlanV1 } from "./transaction-builder.js";
import { approveKnowledgeHygieneTransactionPlanV1 } from "./transaction-plan.js";

const created: string[] = [];
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

afterEach(async () => {
  await Promise.all(created.splice(0).map((path) => rm(path, {
    recursive: true,
    force: true,
  })));
});

async function approvedPlan() {
  const root = await mkdtemp(join(tmpdir(), "osstack-transaction-"));
  created.push(root);
  const repo = join(root, "repo");
  const memory = join(root, "memory");
  const state = join(root, "state");
  await mkdir(join(repo, "docs"), { recursive: true });
  await mkdir(memory, { recursive: true });
  await mkdir(state, { recursive: true });
  await writeFile(join(memory, "MEMORY.md"), "alpha\nbeta\n");
  await writeFile(join(repo, "docs", "knowledge.md"), "# Knowledge\n");
  await chmod(join(memory, "MEMORY.md"), 0o640);
  const plan = buildKnowledgeHygieneTransactionPlanV1({
    kind: "memory",
    revision: 1,
    created_at: "2026-07-18T00:00:00.000Z",
    expires_at: "2026-07-19T00:00:00.000Z",
    repo: {
      repo_id: "repo-1",
      root_realpath: await realpath(repo),
      base_revision: "HEAD",
      fingerprint: digest("repo"),
    },
    memory_root: {
      root_realpath: await realpath(memory),
      fingerprint: digest("memory"),
    },
    snapshots: [
      { root_id: "memory", path: "MEMORY.md", content_utf8: "alpha\nbeta\n", mode: 0o640 },
      { root_id: "repo", path: "docs/knowledge.md", content_utf8: "# Knowledge\n", mode: 0o644 },
    ],
    drafts: [{
      kind: "move",
      source: { root_id: "memory", path: "MEMORY.md", start_line: 1, end_line: 1 },
      target: {
        root_id: "repo",
        path: "docs/knowledge.md",
        placement: "after",
        purpose: "documentation",
      },
    }],
    evidence_refs: [],
  });
  return {
    root,
    repo,
    memory,
    state,
    plan: approveKnowledgeHygieneTransactionPlanV1(plan, {
      action_ids: [plan.actions[0]!.action_id],
      actor: "owner",
      reason: "Approved exact byte move.",
      if_revision: 1,
      local_user_id: "501",
      tty_consented_at: "2026-07-18T00:01:00.000Z",
    }),
  };
}

describe("knowledge hygiene crash-recoverable transaction applier", () => {
  it("dry-runs, applies atomically per file, preserves mode, and replays idempotently", async () => {
    const fixture = await approvedPlan();
    const dryRun = await applyKnowledgeHygieneTransactionPlanV1(fixture.plan, {
      state_root: fixture.state,
      execute: false,
      now: () => new Date("2026-07-18T00:02:00.000Z"),
    });
    expect(dryRun.receipt.status).toBe("verified");
    expect(await readFile(join(fixture.memory, "MEMORY.md"), "utf8"))
      .toBe("alpha\nbeta\n");

    const applied = await applyKnowledgeHygieneTransactionPlanV1(dryRun.plan, {
      state_root: fixture.state,
      execute: true,
      now: () => new Date("2026-07-18T00:03:00.000Z"),
    });
    expect(applied.plan.state).toBe("applied");
    expect(await readFile(join(fixture.memory, "MEMORY.md"), "utf8"))
      .toBe("beta\n");
    expect(await readFile(join(fixture.repo, "docs", "knowledge.md"), "utf8"))
      .toContain("alpha\n");

    const replay = await applyKnowledgeHygieneTransactionPlanV1(applied.plan, {
      state_root: fixture.state,
      execute: true,
      now: () => new Date("2026-07-18T00:04:00.000Z"),
    });
    expect(replay.receipt.status).toBe("already_applied");
  });

  it("fails before writing on stale preimages", async () => {
    const fixture = await approvedPlan();
    await writeFile(join(fixture.memory, "MEMORY.md"), "changed\n");
    await expect(applyKnowledgeHygieneTransactionPlanV1(fixture.plan, {
      state_root: fixture.state,
      execute: true,
      now: () => new Date("2026-07-18T00:02:00.000Z"),
    })).rejects.toThrow("preimage");
    expect(await readFile(join(fixture.repo, "docs", "knowledge.md"), "utf8"))
      .toBe("# Knowledge\n");
  });

  it("leaves a durable journal on simulated kill and recovers in reverse", async () => {
    const fixture = await approvedPlan();
    await expect(applyKnowledgeHygieneTransactionPlanV1(fixture.plan, {
      state_root: fixture.state,
      execute: true,
      now: () => new Date("2026-07-18T00:02:00.000Z"),
      hooks: {
        after_write: (index) => {
          if (index === 0) throw new KnowledgeHygieneSimulatedCrashV1();
        },
      },
    })).rejects.toBeInstanceOf(KnowledgeHygieneSimulatedCrashV1);

    const recovered = await recoverKnowledgeHygieneTransactionPlanV1(
      { ...fixture.plan, state: "recovery_required" },
      {
        state_root: fixture.state,
        now: () => new Date("2026-07-18T00:03:00.000Z"),
      },
    );
    expect(recovered.plan.state).toBe("recovered");
    expect(await readFile(join(fixture.memory, "MEMORY.md"), "utf8"))
      .toBe("alpha\nbeta\n");
    expect(await readFile(join(fixture.repo, "docs", "knowledge.md"), "utf8"))
      .toBe("# Knowledge\n");
  });

  it("reclaims a dead lock but rejects a symlink lock", async () => {
    const fixture = await approvedPlan();
    const lockRoot = join(fixture.state, "locks");
    await mkdir(lockRoot, { recursive: true });
    const lockPath = join(lockRoot, `${fixture.plan.plan_id}.lock`);
    await writeFile(lockPath, "99999999\n", { mode: 0o600 });
    const applied = await applyKnowledgeHygieneTransactionPlanV1(fixture.plan, {
      state_root: fixture.state,
      execute: true,
      now: () => new Date("2026-07-18T00:02:00.000Z"),
    });
    expect(applied.plan.state).toBe("applied");

    const unsafe = await approvedPlan();
    const unsafeLockRoot = join(unsafe.state, "locks");
    await mkdir(unsafeLockRoot, { recursive: true });
    await symlink(
      join(unsafe.root, "outside"),
      join(unsafeLockRoot, `${unsafe.plan.plan_id}.lock`),
    );
    await expect(applyKnowledgeHygieneTransactionPlanV1(unsafe.plan, {
      state_root: unsafe.state,
      execute: true,
      now: () => new Date("2026-07-18T00:02:00.000Z"),
    })).rejects.toThrow("lock is unsafe");
  });

  it("rolls an applied transaction back when a caller postcondition fails", async () => {
    const fixture = await approvedPlan();
    const applied = await applyKnowledgeHygieneTransactionPlanV1(fixture.plan, {
      state_root: fixture.state,
      execute: true,
      now: () => new Date("2026-07-18T00:02:00.000Z"),
    });
    const recovered = await recoverKnowledgeHygieneTransactionPlanV1(
      { ...applied.plan, state: "recovery_required" },
      {
        state_root: fixture.state,
        allow_applied: true,
        now: () => new Date("2026-07-18T00:03:00.000Z"),
      },
    );
    expect(recovered.plan.state).toBe("recovered");
    expect(await readFile(join(fixture.memory, "MEMORY.md"), "utf8"))
      .toBe("alpha\nbeta\n");
  });

  it("fails safely before writes when backup preparation or expiry fails", async () => {
    const backupFailure = await approvedPlan();
    await expect(applyKnowledgeHygieneTransactionPlanV1(backupFailure.plan, {
      state_root: backupFailure.state,
      execute: true,
      now: () => new Date("2026-07-18T00:02:00.000Z"),
      hooks: {
        before_backup: (index) => {
          if (index === 1) throw new Error("backup unavailable");
        },
      },
    })).rejects.toThrow("backup unavailable");
    expect(await readFile(join(backupFailure.memory, "MEMORY.md"), "utf8"))
      .toBe("alpha\nbeta\n");
    expect(await readFile(join(backupFailure.repo, "docs", "knowledge.md"), "utf8"))
      .toBe("# Knowledge\n");

    const expired = await approvedPlan();
    await expect(applyKnowledgeHygieneTransactionPlanV1(expired.plan, {
      state_root: expired.state,
      execute: true,
      now: () => new Date("2026-07-19T00:00:00.000Z"),
    })).rejects.toThrow("expired");
  });

  it("rejects symlink and hard-link targets without touching their referents", async () => {
    const symlinked = await approvedPlan();
    const outside = join(symlinked.root, "outside.md");
    await writeFile(outside, "outside\n");
    const target = join(symlinked.repo, "docs", "knowledge.md");
    await unlink(target);
    await symlink(outside, target);
    await expect(applyKnowledgeHygieneTransactionPlanV1(symlinked.plan, {
      state_root: symlinked.state,
      execute: true,
      now: () => new Date("2026-07-18T00:02:00.000Z"),
    })).rejects.toThrow("not a regular file");
    expect(await readFile(outside, "utf8")).toBe("outside\n");

    const hardLinked = await approvedPlan();
    const hardOutside = join(hardLinked.root, "outside.md");
    await writeFile(hardOutside, "# Knowledge\n");
    const hardTarget = join(hardLinked.repo, "docs", "knowledge.md");
    await unlink(hardTarget);
    await link(hardOutside, hardTarget);
    await expect(applyKnowledgeHygieneTransactionPlanV1(hardLinked.plan, {
      state_root: hardLinked.state,
      execute: true,
      now: () => new Date("2026-07-18T00:02:00.000Z"),
    })).rejects.toThrow("hard-link count");
    expect(await readFile(hardOutside, "utf8")).toBe("# Knowledge\n");
  });

  it("recovers after a last-step kill and a second interruption during recovery", async () => {
    const fixture = await approvedPlan();
    await expect(applyKnowledgeHygieneTransactionPlanV1(fixture.plan, {
      state_root: fixture.state,
      execute: true,
      now: () => new Date("2026-07-18T00:02:00.000Z"),
      hooks: {
        after_write: (index) => {
          if (index === fixture.plan.write_set.length - 1) {
            throw new KnowledgeHygieneSimulatedCrashV1();
          }
        },
      },
    })).rejects.toBeInstanceOf(KnowledgeHygieneSimulatedCrashV1);

    const recoveryPlan = { ...fixture.plan, state: "recovery_required" as const };
    await expect(recoverKnowledgeHygieneTransactionPlanV1(recoveryPlan, {
      state_root: fixture.state,
      now: () => new Date("2026-07-18T00:03:00.000Z"),
      hooks: {
        after_restore: (index) => {
          if (index === 0) throw new KnowledgeHygieneSimulatedCrashV1();
        },
      },
    })).rejects.toBeInstanceOf(KnowledgeHygieneSimulatedCrashV1);

    const recovered = await recoverKnowledgeHygieneTransactionPlanV1(
      recoveryPlan,
      {
        state_root: fixture.state,
        now: () => new Date("2026-07-18T00:04:00.000Z"),
      },
    );
    expect(recovered.plan.state).toBe("recovered");
    expect(await readFile(join(fixture.memory, "MEMORY.md"), "utf8"))
      .toBe("alpha\nbeta\n");
    expect(await readFile(join(fixture.repo, "docs", "knowledge.md"), "utf8"))
      .toBe("# Knowledge\n");
  });

  it("preserves an external concurrent edit while recovering completed writes", async () => {
    const fixture = await approvedPlan();
    const target = join(fixture.repo, "docs", "knowledge.md");
    await expect(applyKnowledgeHygieneTransactionPlanV1(fixture.plan, {
      state_root: fixture.state,
      execute: true,
      now: () => new Date("2026-07-18T00:02:00.000Z"),
      hooks: {
        after_write: async (index) => {
          if (index === 0) await writeFile(target, "external concurrent edit\n");
        },
      },
    })).rejects.toMatchObject({ code: "apply_failed_recovered" });
    expect(await readFile(join(fixture.memory, "MEMORY.md"), "utf8"))
      .toBe("alpha\nbeta\n");
    expect(await readFile(target, "utf8")).toBe("external concurrent edit\n");
  });
});
