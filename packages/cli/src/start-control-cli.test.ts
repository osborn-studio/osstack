import { mkdtempSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KanbanRepository, openDb } from "@osstack/core";
import { AgentCommandResult, ApprovalDecision, ApprovalRequest } from "@osstack/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  handleControlCommand,
  handleStartCommand,
  type StartControlDeps,
} from "./start-control-command.js";

let tmp: string;
let repoPath: string;
let registry: string;
let oldHome: string | undefined;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "osstack-start-control-"));
  repoPath = join(tmp, "repo");
  registry = join(tmp, "repos.json");
  oldHome = process.env["OSSTACK_HOME"];
  process.env["OSSTACK_HOME"] = join(tmp, "home");
  await mkdir(join(repoPath, ".osstack"), { recursive: true });
  await writeRepoYaml("propose");
  await writeRegistry();
});

afterEach(async () => {
  if (oldHome === undefined) delete process.env["OSSTACK_HOME"];
  else process.env["OSSTACK_HOME"] = oldHome;
  await rm(tmp, { recursive: true, force: true });
});

async function writeRepoYaml(_mode: string): Promise<void> {
  await writeFile(
    join(repoPath, ".osstack", "repo.yaml"),
    ["schema_version: 1", "product: demo", "role: tool", "default_branch: main", "verify_command: pnpm test", ""].join("\n"),
    "utf8",
  );
}

async function writePolicyYaml(body: string): Promise<void> {
  await writeFile(join(repoPath, ".osstack", "policy.yaml"), body, "utf8");
}

async function writeRegistry(): Promise<void> {
  await writeFile(
    registry,
    JSON.stringify([
      {
        repo_id: "demo",
        name: "demo",
        path: repoPath,
        role: "cli",
        priority: 50,
        verify_commands: ["pnpm test"],
        loop_doc_path: "docs/LOOP.md",
        enabled: true,
      },
    ]),
    "utf8",
  );
}

/** Deterministic harness: per-prefix id counters + captured out/err. */
function harness(): {
  deps: StartControlDeps;
  logs: string[];
  errs: string[];
  json: () => unknown;
} {
  const logs: string[] = [];
  const errs: string[] = [];
  const counters: Record<string, number> = {};
  const deps: StartControlDeps = {
    out: (line) => logs.push(line),
    err: (line) => errs.push(line),
    now: () => new Date("2026-07-11T09:00:00Z"),
    genId: (prefix) => {
      const next = (counters[prefix] ?? 0) + 1;
      counters[prefix] = next;
      return `${prefix}_${next}`;
    },
  };
  return { deps, logs, errs, json: () => JSON.parse(logs.join("\n")) };
}

const REGISTRY_ARGS = () => ["--registry", registry];

describe("osstack start", () => {
  it("creates a contract markdown, tracks it, and prints the approve command (human)", async () => {
    const h = harness();
    const code = await handleStartCommand(
      ["Add billing dashboard", "--repo-id", "demo", ...REGISTRY_ARGS()],
      h.deps,
    );
    expect(code).toBe(0);
    const out = h.logs.join("\n");
    expect(out).toContain("Execution Contract created: ct_1");
    expect(out).toContain("status:   needs_approval");
    expect(out).toContain("osstack control ct_1 approve");

    // The contract markdown is written to a git-tracked path in the target
    // repo (the human reviews the TBDs and commits it).
    const md = await readFile(join(repoPath, ".osstack", "contracts", "ct_1.md"), "utf8");
    expect(md).toContain("# Execution Contract — ct_1");
    expect(md).toContain("Add billing dashboard");
    expect(md).toContain("pnpm test"); // verify command from repo.yaml
    expect(md).toContain("TBD"); // non-goals / acceptance left for the human
  });

  it("--json emits a needs_approval AgentCommandResult that parses STRICTLY", async () => {
    await writePolicyYaml(
      ["schema_version: 1", "mode: propose", "auto_apply: false", "requires_approval: [source]", "budgets:", "  max_iterations: 5", ""].join("\n"),
    );
    const h = harness();
    const code = await handleStartCommand(
      ["Add billing dashboard", "--repo-id", "demo", "--json", ...REGISTRY_ARGS()],
      h.deps,
    );
    expect(code).toBe(0);
    const parsed = AgentCommandResult.parse(h.json());
    expect(parsed.status).toBe("needs_approval");
    expect(parsed.protocol_version).toBe("1.0");
    // The ApprovalRequest itself validates against the strict protocol schema.
    expect(parsed.required_approvals).toHaveLength(1);
    expect(() => ApprovalRequest.parse(parsed.required_approvals![0])).not.toThrow();
    // next_actions[0] is the exact control approve invocation.
    expect(parsed.next_actions?.[0]?.command).toBe("control.approve");
    expect(parsed.next_actions?.[0]?.reason).toBe("osstack control ct_1 approve");
    expect(parsed.evidence_refs?.some((e) => e.kind === "report")).toBe(true);
  });

  it("blocks with policy_denied (exit 2) under observe mode", async () => {
    await writePolicyYaml(["schema_version: 1", "mode: observe", ""].join("\n"));
    const h = harness();
    const code = await handleStartCommand(
      ["x", "--repo-id", "demo", "--json", ...REGISTRY_ARGS()],
      h.deps,
    );
    expect(code).toBe(2);
    const parsed = AgentCommandResult.parse(h.json());
    expect(parsed.status).toBe("blocked");
    expect(parsed.error?.code).toBe("policy_denied");
  });

  it("fails closed (exit 1) on an invalid policy file", async () => {
    await writePolicyYaml(["schema_version: 1", "mode: bogus", ""].join("\n"));
    const h = harness();
    const code = await handleStartCommand(["x", "--repo-id", "demo", ...REGISTRY_ARGS()], h.deps);
    expect(code).toBe(1);
    expect(h.errs.join("\n")).toContain("invalid policy profile");
  });

  it("errors (not_found) when the repo is not registered", async () => {
    const h = harness();
    const code = await handleStartCommand(
      ["x", "--repo-id", "ghost", "--json", ...REGISTRY_ARGS()],
      h.deps,
    );
    expect(code).toBe(1);
    const parsed = AgentCommandResult.parse(h.json());
    expect(parsed.status).toBe("error");
    expect(parsed.error?.code).toBe("not_found");
  });

  it("errors when the repo has no .osstack/repo.yaml", async () => {
    await rm(join(repoPath, ".osstack", "repo.yaml"));
    const h = harness();
    const code = await handleStartCommand(["x", "--repo-id", "demo", ...REGISTRY_ARGS()], h.deps);
    expect(code).toBe(1);
    expect(h.errs.join("\n")).toContain("no .osstack/repo.yaml");
  });

  it("requires a goal and a --repo-id", async () => {
    const h1 = harness();
    expect(await handleStartCommand(["--repo-id", "demo", ...REGISTRY_ARGS()], h1.deps)).toBe(1);
    expect(h1.errs.join("\n")).toContain("requires a goal");

    const h2 = harness();
    expect(await handleStartCommand(["just a goal", ...REGISTRY_ARGS()], h2.deps)).toBe(1);
    expect(h2.errs.join("\n")).toContain("requires --repo-id");
  });
});

describe("osstack control", () => {
  async function start(deps: StartControlDeps): Promise<void> {
    await writePolicyYaml(
      ["schema_version: 1", "mode: propose", "budgets:", "  max_iterations: 7", ""].join("\n"),
    );
    await handleStartCommand(
      ["Add billing dashboard", "--repo-id", "demo", ...REGISTRY_ARGS()],
      deps,
    );
  }

  it("approve records an ApprovalDecision and emits the deliver command (strict --json)", async () => {
    const h = harness();
    await start(h.deps);
    h.logs.length = 0;
    const code = await handleControlCommand(["ct_1", "approve", "--json"], h.deps);
    expect(code).toBe(0);
    const parsed = AgentCommandResult.parse(h.json());
    expect(parsed.status).toBe("ok");
    const decision = (parsed.result as Record<string, unknown>)["approval_decision"];
    expect(() => ApprovalDecision.parse(decision)).not.toThrow();
    // next_actions[0] is the ready-to-run deliver command with verify + budget flags.
    expect(parsed.next_actions?.[0]?.command).toBe("deliver.run");
    expect(parsed.next_actions?.[0]?.reason).toContain("osstack deliver");
    expect(parsed.next_actions?.[0]?.reason).toContain("--verify");
    expect(parsed.next_actions?.[0]?.reason).toContain("--max-iter 7");
  });

  it("rejects a double-approve with a conflict", async () => {
    const h = harness();
    await start(h.deps);
    await handleControlCommand(["ct_1", "approve"], h.deps);
    h.logs.length = 0;
    h.errs.length = 0;
    const code = await handleControlCommand(["ct_1", "approve", "--json"], h.deps);
    expect(code).toBe(1);
    const parsed = AgentCommandResult.parse(h.json());
    expect(parsed.error?.code).toBe("conflict");
  });

  it("refuses an agent actor as policy_denied / blocked / exit 2 (A-004)", async () => {
    const h = harness();
    await start(h.deps);
    h.logs.length = 0;
    const code = await handleControlCommand(
      ["ct_1", "approve", "--actor", "agent:opus", "--json"],
      h.deps,
    );
    expect(code).toBe(2);
    const parsed = AgentCommandResult.parse(h.json());
    expect(parsed.status).toBe("blocked");
    expect(parsed.error?.code).toBe("policy_denied");
    expect(parsed.error?.message).toContain("A-004");

    // Human path: same denial, same exit code.
    h.errs.length = 0;
    const humanCode = await handleControlCommand(["ct_1", "approve", "--actor", "agent:opus"], h.deps);
    expect(humanCode).toBe(2);
    expect(h.errs.join("\n")).toContain("policy_denied");
  });

  it("emits a shell-safe deliver command for a hostile goal, plus raw deliver_args (B1)", async () => {
    const hostile = "fix $(id) `whoami` 'quote'";
    const h = harness();
    await writePolicyYaml(
      ["schema_version: 1", "mode: propose", "budgets:", "  max_iterations: 7", ""].join("\n"),
    );
    await handleStartCommand([hostile, "--repo-id", "demo", ...REGISTRY_ARGS()], h.deps);
    h.logs.length = 0;
    const code = await handleControlCommand(["ct_1", "approve", "--json"], h.deps);
    expect(code).toBe(0);
    const parsed = AgentCommandResult.parse(h.json());
    const result = parsed.result as Record<string, unknown>;

    // The printed string single-quotes every value: $(…) and backticks are
    // inert inside '…', and the embedded single quote is escaped as '\''.
    const command = result["deliver_command"] as string;
    expect(command).toContain("'fix $(id) `whoami` '\\''quote'\\'''");
    expect(command).not.toContain('"fix'); // no live-substitution double quoting
    expect(parsed.next_actions?.[0]?.reason).toBe(command);

    // Structured argv carries the RAW text — agent consumers never parse shell.
    const argv = result["deliver_args"] as string[];
    expect(argv[0]).toBe("deliver");
    expect(argv[1]).toBe(hostile);
    expect(argv).toContain("--verify");
    expect(argv).toContain("pnpm test");
  });

  it("approve succeeds against the approval row when the card was moved out-of-band (B2)", async () => {
    const h = harness();
    await start(h.deps);

    // Simulate an out-of-band drag: archive the card directly. archived -> ready
    // is an illegal card transition, so the projection must fail — but the
    // approval row is authoritative and approve must still succeed.
    const dbPath = join(tmp, "home", "state.db");
    const db = openDb({ path: dbPath });
    try {
      new KanbanRepository(db, dbPath).moveCard("ct_1", "archived");
    } finally {
      db.close();
    }

    h.logs.length = 0;
    const code = await handleControlCommand(["ct_1", "approve", "--json"], h.deps);
    expect(code).toBe(0);
    const parsed = AgentCommandResult.parse(h.json());
    expect(parsed.status).toBe("ok");
    const result = parsed.result as Record<string, unknown>;
    expect(result["status"]).toBe("approved");
    expect(() => ApprovalDecision.parse(result["approval_decision"])).not.toThrow();
    // The failed card projection degrades to a warning, never a crash.
    const warnings = result["warnings"] as string[];
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("projection failed");

    // status also reports from the approval row, not the stale card.
    h.logs.length = 0;
    await handleControlCommand(["ct_1", "status", "--json"], h.deps);
    const status = AgentCommandResult.parse(h.json());
    expect((status.result as Record<string, unknown>)["status"]).toBe("approved");
  });

  it("revise re-opens the approval and a later approve succeeds (strict --json)", async () => {
    const h = harness();
    await start(h.deps);
    h.logs.length = 0;
    const revCode = await handleControlCommand(
      ["ct_1", "revise", "--reason", "tighten acceptance", "--json"],
      h.deps,
    );
    expect(revCode).toBe(0);
    const revised = AgentCommandResult.parse(h.json());
    expect((revised.result as Record<string, unknown>)["status"]).toBe("revising");

    // Re-approval after revise is allowed (approval row moves revising -> approved).
    const okCode = await handleControlCommand(["ct_1", "approve"], h.deps);
    expect(okCode).toBe(0);
  });

  it("revise requires a --reason", async () => {
    const h = harness();
    await start(h.deps);
    h.errs.length = 0;
    const code = await handleControlCommand(["ct_1", "revise"], h.deps);
    expect(code).toBe(1);
    expect(h.errs.join("\n")).toContain("requires --reason");
  });

  it("stop archives the contract; a later approve conflicts", async () => {
    const h = harness();
    await start(h.deps);
    h.logs.length = 0;
    const stopCode = await handleControlCommand(
      ["ct_1", "stop", "--reason", "descoped", "--json"],
      h.deps,
    );
    expect(stopCode).toBe(0);
    const stopped = AgentCommandResult.parse(h.json());
    expect((stopped.result as Record<string, unknown>)["status"]).toBe("stopped");

    h.errs.length = 0;
    const approveCode = await handleControlCommand(["ct_1", "approve"], h.deps);
    expect(approveCode).toBe(1);
  });

  it("status renders the contract + the full append-only approval trail (strict --json)", async () => {
    const h = harness();
    await start(h.deps);
    await handleControlCommand(["ct_1", "revise", "--reason", "tighten"], h.deps);
    await handleControlCommand(["ct_1", "approve"], h.deps);
    h.logs.length = 0;
    const code = await handleControlCommand(["ct_1", "status", "--json"], h.deps);
    expect(code).toBe(0);
    const parsed = AgentCommandResult.parse(h.json());
    const result = parsed.result as Record<string, unknown>;
    expect(result["status"]).toBe("approved");
    expect(() => ApprovalRequest.parse(result["approval_request"])).not.toThrow();
    // Protocol surface: only the LATEST decision.
    expect(() => ApprovalDecision.parse(result["approval_decision"])).not.toThrow();
    // Full history: every revise/approve appended in order (S1).
    const trail = result["approval_trail"] as { action: string; reason?: string }[];
    expect(trail.map((d) => d.action)).toEqual(["revise", "approve"]);
    expect(trail[0]?.reason).toBe("tighten");

    // Human output renders each trail entry too.
    h.logs.length = 0;
    await handleControlCommand(["ct_1", "status"], h.deps);
    const human = h.logs.join("\n");
    expect(human).toContain("revise by human:owner");
    expect(human).toContain("approve by human:owner");
  });

  it("errors (not_found) for an unknown contract id", async () => {
    const h = harness();
    const code = await handleControlCommand(["ct_ghost", "status", "--json"], h.deps);
    expect(code).toBe(1);
    const parsed = AgentCommandResult.parse(h.json());
    expect(parsed.error?.code).toBe("not_found");
  });

  it("rejects an unknown action", async () => {
    const h = harness();
    await start(h.deps);
    h.errs.length = 0;
    const code = await handleControlCommand(["ct_1", "frobnicate"], h.deps);
    expect(code).toBe(1);
    expect(h.errs.join("\n")).toContain("unknown control action");
  });
});
