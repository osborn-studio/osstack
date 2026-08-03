import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  agentAuthMode,
  defaultAdapters,
  rolesForCapabilityKinds,
} from "@osstack/agents";

export interface LoopDoctorCheck {
  id: string;
  status: "ok" | "warn" | "error";
  summary: string;
  details?: Record<string, unknown>;
}

export interface LoopDoctorResult {
  ok: boolean;
  workspace_path: string;
  state_json: string;
  daemon_checked: boolean;
  socket_path: string;
  checks: LoopDoctorCheck[];
}

export interface ProductAgentDoctorResult {
  total: number;
  available: number;
  unavailable: number;
  by_role: Record<string, string[]>;
  profiles: Array<{
    id: string;
    display_name: string;
    auth_mode: string;
    cost_tier: string;
    roles: string[];
    available: boolean;
    reason?: string;
  }>;
}

export interface ProductEntryCommandDeps {
  loopDoctor: (input: {
    workspacePath: string;
    stateFilePath: string;
    checkDaemon: boolean;
  }) => Promise<LoopDoctorResult>;
  printLoopDoctor: (result: LoopDoctorResult) => void;
  resolveLoopPath: (path: string, workspacePath: string) => string;
  agentDoctor?: () => Promise<ProductAgentDoctorResult>;
  cwd?: () => string;
  stdout?: (line: string) => void;
}

interface ProductEntryOutputDeps {
  stdout?: (line: string) => void;
}

function flagValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 && index + 1 < args.length ? args[index + 1] : undefined;
}

async function productAgentDoctor(): Promise<ProductAgentDoctorResult> {
  const profiles = await Promise.all(defaultAdapters().map(async (adapter) => {
    const availability = await adapter.isAvailable();
    const roles = rolesForCapabilityKinds(adapter.capabilities().map((capability) => capability.kind));
    return {
      id: adapter.id,
      display_name: adapter.display_name,
      auth_mode: agentAuthMode(adapter.id),
      cost_tier: adapter.cost_tier,
      roles,
      available: availability.available,
      ...(availability.reason !== undefined ? { reason: availability.reason } : {}),
    };
  }));
  const byRole: Record<string, string[]> = {};
  for (const profile of profiles) {
    for (const role of profile.roles) {
      byRole[role] = [...(byRole[role] ?? []), profile.id];
    }
  }
  return {
    total: profiles.length,
    available: profiles.filter((profile) => profile.available).length,
    unavailable: profiles.filter((profile) => !profile.available).length,
    by_role: byRole,
    profiles,
  };
}

function productDoctorNextSteps(
  loop: LoopDoctorResult,
  agents: ProductAgentDoctorResult,
): string[] {
  const steps: string[] = [];
  const taskQueue = loop.checks.find((check) => check.id === "task_queue");
  if (taskQueue?.status === "ok") {
    steps.push("Run queued work: osstack loop run --source task_queue --report --scorecard --proof");
  } else {
    steps.push("Queue a task: osstack loop enqueue \"Run local checks\" --capability code.test");
  }
  if (agents.available > 0) {
    steps.push("Try routing: osstack loop run --source task_queue --auto-agent --verify \"pnpm test\"");
  } else {
    steps.push("Configure an available agent or use --execute for local shell execution.");
  }
  steps.push("Read examples: osstack examples");
  return steps;
}

function printProductDoctor(
  result: {
    ok: boolean;
    workspace: string;
    loop: LoopDoctorResult;
    agents: ProductAgentDoctorResult;
    next_steps: string[];
  },
  deps: ProductEntryCommandDeps,
  stdout: (line: string) => void,
): void {
  stdout(`Osstack doctor: ${result.ok ? "ok" : "attention needed"}`);
  stdout(`workspace=${result.workspace}`);
  stdout("");
  deps.printLoopDoctor(result.loop);
  stdout("");
  stdout(`Agents: ${result.agents.available}/${result.agents.total} available`);
  for (const profile of result.agents.profiles) {
    stdout(`  [${profile.available ? "ok" : "warn"}] ${profile.id} auth=${profile.auth_mode} roles=${profile.roles.join(",") || "none"}`);
  }
  stdout("");
  stdout("Next steps:");
  for (const step of result.next_steps) stdout(`- ${step}`);
}

export async function handleProductDoctorCommand(
  args: string[],
  deps: ProductEntryCommandDeps,
): Promise<number> {
  const stdout = deps.stdout ?? console.log;
  if (args.includes("--help") || args.includes("-h")) {
    stdout(`osstack doctor — product readiness check

  osstack doctor [--workspace P] [--daemon] [--json]

Checks:
  - workspace, tasks/, LOOP-STATE.json, git/worktree readiness
  - daemon socket when --daemon is set
  - local agent registry roles, auth modes, and availability
`);
    return 0;
  }
  const workspacePath = flagValue(args, "--workspace") ?? (deps.cwd ?? process.cwd)();
  const loop = await deps.loopDoctor({
    workspacePath,
    stateFilePath: deps.resolveLoopPath(flagValue(args, "--state") ?? "LOOP-STATE.json", workspacePath),
    checkDaemon: args.includes("--daemon"),
  });
  const agents = await (deps.agentDoctor ?? productAgentDoctor)();
  const nextSteps = productDoctorNextSteps(loop, agents);
  const result = {
    ok: loop.ok && agents.total > 0,
    workspace: workspacePath,
    loop,
    agents,
    next_steps: nextSteps,
  };
  if (args.includes("--json")) {
    stdout(JSON.stringify(result, null, 2));
  } else {
    printProductDoctor(result, deps, stdout);
  }
  return result.ok ? 0 : 1;
}

export async function handleExamplesCommand(
  args: string[],
  deps: ProductEntryOutputDeps = {},
): Promise<number> {
  const stdout = deps.stdout ?? console.log;
  const examples = osstackExamples();
  if (args.includes("--json")) {
    stdout(JSON.stringify({ examples }, null, 2));
    return 0;
  }
  stdout("# Osstack Examples\n");
  for (const example of examples) {
    stdout(`## ${example.title}`);
    stdout(example.description);
    stdout("");
    stdout("```bash");
    for (const command of example.commands) stdout(command);
    stdout("```\n");
  }
  return 0;
}

export async function handleGuideCommand(
  args: string[],
  deps: ProductEntryOutputDeps = {},
): Promise<number> {
  const stdout = deps.stdout ?? console.log;
  const markdown = renderQuickstartGuide();
  const output = flagValue(args, "--output");
  if (output !== undefined) {
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, markdown, "utf-8");
    if (args.includes("--json")) {
      stdout(JSON.stringify({ output }, null, 2));
    } else {
      stdout(`guide=${output}`);
    }
    return 0;
  }
  stdout(markdown);
  return 0;
}

function osstackExamples(): Array<{ title: string; description: string; commands: string[] }> {
  return [
    {
      title: "5-minute proof path",
      description: "Run one product-entry task, generate evidence, and open the cockpit summary.",
      commands: [
        "osstack doctor --workspace .",
        "osstack deliver \"Add one small verified change\" --verify \"pnpm test\" --auto-agent --worktree --report --scorecard --proof",
        "osstack cockpit --workspace .",
        "osstack proof view \"$(node -e 'const s=require(\"./LOOP-STATE.json\"); process.stdout.write(s.loop_id)')\" --audience engineer",
      ],
    },
    {
      title: "Fix a bug",
      description: "Queue a failing behavior, run the loop, and produce evidence.",
      commands: [
        "osstack loop enqueue \"Fix the failing unit test\" --capability code.test",
        "osstack loop run --source task_queue --verify \"pnpm test\" --report --scorecard --proof",
      ],
    },
    {
      title: "Implement a feature",
      description: "Use the product entry command to create a task, execute, verify, and package proof.",
      commands: [
        "osstack deliver \"Add billing dashboard\" --verify \"pnpm test\" --auto-agent --worktree --report --scorecard --proof --json",
      ],
    },
    {
      title: "Review git diff",
      description: "Turn local changes into a review/checker workflow.",
      commands: [
        "osstack loop run --source git_diff --reviewer ds-review --verify \"pnpm test\" --report",
      ],
    },
    {
      title: "Auto-agent routing",
      description: "Let router and policy choose the maker based on capability and local availability.",
      commands: [
        "osstack agent list",
        "osstack loop run --source task_queue --auto-agent --verify \"pnpm test\"",
      ],
    },
    {
      title: "Worktree isolation",
      description: "Run each task in an isolated worktree, then merge only successful changes.",
      commands: [
        "osstack loop run --source task_queue --worktree --worktree-root ../osstack-worktrees --verify \"pnpm test\"",
      ],
    },
    {
      title: "Proof pack",
      description: "Generate report, scorecard, proof pack, and PR evidence body.",
      commands: [
        "osstack loop run --source task_queue --report --scorecard --proof",
        "osstack pr --dry-run",
      ],
    },
  ];
}

function renderQuickstartGuide(): string {
  return `# Osstack 5-minute quickstart

## 1. Install and check readiness

\`\`\`bash
npm install -g @osstack/cli
osstack --version
osstack doctor --workspace .
\`\`\`

## 2. Queue one task

\`\`\`bash
osstack loop enqueue "Run local checks and fix the first failure" --capability code.test
\`\`\`

## 3. Run the loop and generate evidence

\`\`\`bash
osstack loop run --source task_queue --verify "pnpm test" --report --scorecard --proof
\`\`\`

## 4. Inspect the result from cockpit and proof views

\`\`\`bash
osstack loop status
osstack cockpit --workspace .
# cockpit prints latest_report=... and latest_proof=...
osstack proof view "$(node -e 'const s=require("./LOOP-STATE.json"); process.stdout.write(s.loop_id)')" --audience engineer
\`\`\`

## 5. Prefer the one-command product entry path next time

\`\`\`bash
osstack deliver "Add one small verified change" --verify "pnpm test" --auto-agent --worktree --report --scorecard --proof
osstack cockpit --workspace .
\`\`\`

More workflows:

\`\`\`bash
osstack examples
\`\`\`
`;
}
