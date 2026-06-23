export interface CockpitTuiModel {
  mode: "terminal-cockpit";
  title: string;
  workspace: string;
  daemon: string;
  sections: Array<{ title: string; lines: string[] }>;
  actions: Array<{ label: string; command: string; status: string }>;
}

export interface CockpitKnowledgeSummary {
  cache_dir: string;
  pack_count: number;
  official: number;
  team: number;
  project: number;
  internal: number;
  top_pack?: {
    id: string;
    version: string;
    quality_score: number;
    sources: number;
  };
}

export interface CockpitTuiActionSelection {
  mode: "terminal-cockpit-action";
  selected_index: number;
  action: { label: string; command: string; status: string };
  next_command: string;
}

export interface CockpitTuiInteractiveQuit {
  mode: "terminal-cockpit-interactive";
  status: "quit";
}

export function cockpitTuiModel(daemonRaw: unknown, snapshotRaw: unknown, knowledge: CockpitKnowledgeSummary): CockpitTuiModel {
  const daemon = isRecord(daemonRaw) ? daemonRaw : {};
  const snapshot = isRecord(snapshotRaw) ? snapshotRaw : {};
  const dashboard = isRecord(snapshot["dashboard"]) ? snapshot["dashboard"] : {};
  const overview = isRecord(snapshot["overview"]) ? snapshot["overview"] : {};
  const board = isRecord(snapshot["board"]) ? snapshot["board"] : {};
  const evidence = isRecord(snapshot["evidence"]) ? snapshot["evidence"] : {};
  const quality = isRecord(snapshot["quality"]) ? snapshot["quality"] : {};
  const nextSteps = Array.isArray(snapshot["next_steps"]) ? snapshot["next_steps"] : [];
  const byStatus = isRecord(board["by_status"]) ? board["by_status"] : {};
  const latestReport = isRecord(evidence["latest_report"]) ? evidence["latest_report"] : {};
  const latestProofPack = isRecord(evidence["latest_proof_pack"]) ? evidence["latest_proof_pack"] : {};
  const actions = nextSteps
    .filter(isRecord)
    .map((step) => ({
      label: String(step["label"] ?? "unknown"),
      command: String(step["command"] ?? ""),
      status: String(step["status"] ?? "unknown"),
    }))
    .filter((action) => action.command.length > 0);
  const knowledgeActions = knowledge.pack_count === 0
    ? []
    : [{
      label: "Knowledge",
      command: `osstack knowledge search "<query>" --cache-dir ${knowledge.cache_dir} --json`,
      status: "ready",
    }];
  return {
    mode: "terminal-cockpit",
    title: "Osstack Cockpit TUI",
    workspace: String(dashboard["workspace_path"] ?? process.cwd()),
    daemon: `${String(daemon["version"] ?? "unknown")} phase=${String(daemon["phase"] ?? "unknown")}`,
    sections: [
      {
        title: "Overview",
        lines: [
          `runs=${String(overview["total_runs"] ?? 0)} active=${String(overview["active_runs"] ?? daemon["active_runs"] ?? 0)} queued=${String(overview["queued_tasks"] ?? 0)} loops=${String(overview["active_loops"] ?? daemon["active_loops"] ?? 0)}`,
          `progress=${String(overview["progress_percent"] ?? 0)}% quality=${String(quality["grade"] ?? "unknown")} success_rate=${String(quality["success_rate"] ?? "unknown")}`,
        ],
      },
      {
        title: "Kanban",
        lines: [
          `triage=${String(byStatus["triage"] ?? 0)} todo=${String(byStatus["todo"] ?? 0)} ready=${String(byStatus["ready"] ?? 0)}`,
          `running=${String(byStatus["running"] ?? 0)} blocked=${String(byStatus["blocked"] ?? 0)} done=${String(byStatus["done"] ?? 0)}`,
        ],
      },
      {
        title: "Evidence",
        lines: [
          `reports=${String(evidence["reports"] ?? 0)} proof_packs=${String(evidence["proof_packs"] ?? 0)}`,
          `latest_report=${String(latestReport["path"] ?? "none")}`,
          `latest_proof=${String(latestProofPack["path"] ?? "none")}`,
        ],
      },
      {
        title: "Knowledge",
        lines: [
          `cached_packs=${knowledge.pack_count} official=${knowledge.official} team=${knowledge.team} project=${knowledge.project} internal=${knowledge.internal}`,
          knowledge.top_pack === undefined
            ? "top_pack=none"
            : `top_pack=${knowledge.top_pack.id}@${knowledge.top_pack.version} quality=${knowledge.top_pack.quality_score} sources=${knowledge.top_pack.sources}`,
          `provenance=osstack knowledge sources --internal --cache-dir ${knowledge.cache_dir} --json`,
        ],
      },
      {
        title: "Next Actions",
        lines: actions.slice(0, 5).map((action) => `[${action.status}] ${action.label}: ${action.command}`),
      },
    ],
    actions: [...actions, ...knowledgeActions],
  };
}

export function renderCockpitTui(model: CockpitTuiModel): string {
  const width = 88;
  const lines = [
    `+ ${model.title} ${"-".repeat(Math.max(1, width - model.title.length - 4))}`,
    `Workspace: ${model.workspace}`,
    `Daemon: ${model.daemon}`,
    "",
    ...model.sections.flatMap((section) => [
      `[${section.title}]`,
      ...(section.lines.length === 0 ? ["  none"] : section.lines.map((line) => `  ${line}`)),
      "",
    ]),
    "[Actions]",
    ...(model.actions.length === 0
      ? ["  none"]
      : model.actions.slice(0, 9).map((action, index) => `  ${index + 1}. [${action.status}] ${action.label}: ${action.command}`)),
  ];
  return lines.join("\n").trimEnd();
}

export function selectCockpitTuiAction(model: CockpitTuiModel, selectedIndex: number): CockpitTuiActionSelection | undefined {
  const action = model.actions[selectedIndex - 1];
  if (action === undefined) return undefined;
  const command = concreteCockpitTuiCommand(action.command, model.workspace);
  const concreteAction = { ...action, command };
  return {
    mode: "terminal-cockpit-action",
    selected_index: selectedIndex,
    action: concreteAction,
    next_command: command,
  };
}

export async function runInteractiveCockpitTui(model: CockpitTuiModel, options: { json: boolean }): Promise<number> {
  const answer = await readCockpitTuiInteractiveInput(model, options);
  if (answer === undefined || answer.toLowerCase() === "q" || answer.toLowerCase() === "quit") {
    const quit: CockpitTuiInteractiveQuit = { mode: "terminal-cockpit-interactive", status: "quit" };
    if (options.json) console.log(JSON.stringify(quit, null, 2));
    else console.log("cockpit_interactive=quit");
    return 0;
  }
  const selectedIndex = Number(answer);
  if (!Number.isInteger(selectedIndex) || selectedIndex < 1) {
    console.error(`osstack: cockpit tui interactive selection must be 1-${model.actions.length} or q`);
    return 1;
  }
  const selected = selectCockpitTuiAction(model, selectedIndex);
  if (selected === undefined) {
    console.error(`osstack: cockpit tui interactive selection must be 1-${model.actions.length} or q`);
    return 1;
  }
  if (options.json) console.log(JSON.stringify(selected, null, 2));
  else console.log(renderCockpitTuiAction(selected));
  return 0;
}

export function renderCockpitTuiAction(selection: CockpitTuiActionSelection): string {
  return [
    `selected=${selection.selected_index}`,
    `status=${selection.action.status}`,
    `label=${selection.action.label}`,
    `command=${selection.next_command}`,
  ].join("\n");
}

async function readCockpitTuiInteractiveInput(model: CockpitTuiModel, options: { json: boolean }): Promise<string | undefined> {
  const testInput = process.env["OSSTACK_TEST_COCKPIT_TUI_INPUT"];
  if (testInput !== undefined) return testInput.split(/\r?\n/, 1)[0]?.trim();
  if (!options.json) {
    console.log(renderCockpitTui(model));
    console.log("");
  }
  if (process.stdin.isTTY !== true) {
    console.error("osstack: cockpit tui --interactive requires a TTY; use --action N for scripts");
    return undefined;
  }
  const { createInterface } = await import("node:readline/promises");
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await readline.question(`Select action 1-${model.actions.length}, or q to quit: `);
    return answer.trim();
  } finally {
    readline.close();
  }
}

function concreteCockpitTuiCommand(command: string, workspace: string): string {
  return command.replaceAll("<path>", shellQuote(workspace));
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
