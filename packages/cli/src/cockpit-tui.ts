import { attentionDisplayText } from "./attention-dashboard.js";

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

export interface CockpitTuiFullscreenState {
  active_section_index: number;
  selected_action_index: number;
}

export type CockpitTuiKey =
  | "up"
  | "down"
  | "left"
  | "right"
  | "enter"
  | "q"
  | "escape"
  | string;

export type CockpitTuiKeyResult =
  | { type: "state"; state: CockpitTuiFullscreenState }
  | { type: "select"; selection: CockpitTuiActionSelection }
  | { type: "quit" }
  | { type: "none"; state: CockpitTuiFullscreenState };

export type CockpitTuiFullscreenRunResult =
  | { type: "select"; state: CockpitTuiFullscreenState; selection: CockpitTuiActionSelection }
  | { type: "quit"; state: CockpitTuiFullscreenState }
  | { type: "none"; state: CockpitTuiFullscreenState };

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
  const autonomy = isRecord(snapshot["autonomy"]) ? snapshot["autonomy"] : {};
  const deployFreezes = (
    Array.isArray(autonomy["deploy_freezes"])
      ? autonomy["deploy_freezes"]
      : []
  )
    .filter(isRecord)
    .filter(
      (freeze) =>
        freeze["frozen"] === true
        || freeze["frozen"] === 1,
    );
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
  const freezeActions = deployFreezes
    .filter((freeze) => typeof freeze["repo_id"] === "string")
    .map((freeze) => {
      const repoId = String(freeze["repo_id"]);
      return {
        label: `Review production freeze ${repoId}`,
        command:
          `osstack autonomy freeze request ${shellQuote(repoId)} --json`,
        status: "needs_approval",
      };
    });
  return {
    mode: "terminal-cockpit",
    title: "Osstack Cockpit TUI",
    workspace: String(dashboard["workspace_path"] ?? process.cwd()),
    daemon: `${String(daemon["version"] ?? "unknown")} phase=${String(daemon["phase"] ?? "unknown")}`,
    sections: [
      ...(isRecord(snapshot["attention"]) ? [{ title: "Attention", lines: attentionLines(snapshot["attention"]) }] : []),
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
        title: "Autonomy",
        lines: [
          `autonomy_run_id=${String(autonomy["autonomy_run_id"] ?? "none")} state=${String(autonomy["state"] ?? "none")} risk=${String(autonomy["risk"] ?? "none")}`,
          `approval_status=${String(autonomy["approval_status"] ?? "none")} candidate_proof=${String(autonomy["candidate_proof"] ?? "none")}`,
          `pr_url=${String(autonomy["pr_url"] ?? "none")} last_transition=${String(autonomy["last_transition"] ?? "none")}`,
          `production_freezes=${deployFreezes.length}`,
          ...deployFreezes.slice(0, 2).map(
            (freeze) =>
              `freeze=${String(freeze["repo_id"] ?? "unknown")} reason=${String(freeze["reason"] ?? "unknown")} source=${String(freeze["source_run_id"] ?? "unknown")}`,
          ),
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
    actions: [...actions, ...freezeActions, ...knowledgeActions],
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

export function initialCockpitTuiFullscreenState(model: CockpitTuiModel): CockpitTuiFullscreenState {
  return {
    active_section_index: model.sections.length === 0 ? -1 : 0,
    selected_action_index: model.actions.length === 0 ? 0 : 1,
  };
}

export function updateCockpitTuiFullscreenState(
  model: CockpitTuiModel,
  state: CockpitTuiFullscreenState,
  key: CockpitTuiKey,
): CockpitTuiKeyResult {
  const normalized = key.toLowerCase();
  if (normalized === "q" || normalized === "escape") return { type: "quit" };
  if (normalized === "enter") {
    const selection = selectCockpitTuiAction(model, state.selected_action_index);
    return selection === undefined ? { type: "none", state } : { type: "select", selection };
  }

  const nextState = { ...state };
  if (normalized === "up") {
    nextState.active_section_index = clamp(nextState.active_section_index - 1, 0, model.sections.length - 1);
    nextState.selected_action_index = clamp(nextState.selected_action_index - 1, 1, model.actions.length);
    return { type: "state", state: nextState };
  }
  if (normalized === "down") {
    nextState.active_section_index = clamp(nextState.active_section_index + 1, 0, model.sections.length - 1);
    nextState.selected_action_index = clamp(nextState.selected_action_index + 1, 1, model.actions.length);
    return { type: "state", state: nextState };
  }
  if (normalized === "left") {
    nextState.active_section_index = clamp(nextState.active_section_index - 1, 0, model.sections.length - 1);
    return { type: "state", state: nextState };
  }
  if (normalized === "right") {
    nextState.active_section_index = clamp(nextState.active_section_index + 1, 0, model.sections.length - 1);
    return { type: "state", state: nextState };
  }
  return { type: "none", state };
}

export function renderCockpitFullscreen(
  model: CockpitTuiModel,
  options: { width?: number; height?: number; state?: Partial<CockpitTuiFullscreenState> } = {},
): string {
  const width = Math.max(72, Math.min(options.width ?? process.stdout.columns ?? 100, 140));
  const height = Math.max(20, Math.min(options.height ?? process.stdout.rows ?? 34, 60));
  const baseState = initialCockpitTuiFullscreenState(model);
  const state = {
    active_section_index: options.state?.active_section_index ?? baseState.active_section_index,
    selected_action_index: options.state?.selected_action_index ?? baseState.selected_action_index,
  };
  const innerWidth = width - 4;
  const rule = "-".repeat(width - 2);
  const lines = [
    `+${rule}+`,
    frameLine("OSSTACK COCKPIT", width),
    frameLine(`Workspace: ${model.workspace}`, width),
    frameLine(`Daemon: ${model.daemon}`, width),
    frameLine("", width),
    ...model.sections.flatMap((section, index) => {
      const marker = index === state.active_section_index ? ">" : " ";
      return [
        frameLine(`${marker} ${section.title}`, width),
        ...section.lines.slice(0, section.title === "Attention" ? 5 : 3).map((line) => frameLine(`  ${line}`, width)),
      ];
    }),
    frameLine("", width),
    frameLine("Actions", width),
    ...(model.actions.length === 0
      ? [frameLine("  none", width)]
      : model.actions.slice(0, 9).map((action, index) => {
        const selected = index + 1 === state.selected_action_index ? ">" : " ";
        return frameLine(`${selected} ${index + 1}. [${action.status}] ${action.label}: ${action.command}`, width);
      })),
    frameLine("", width),
    frameLine("Keys: up/down move | enter select | q quit", width),
    `+${rule}+`,
  ];
  // Reserve the action and key footer when observation details grow. Clipping
  // the tail hid actionable rows after adding the Attention section.
  const footerStart = lines.indexOf(frameLine("Actions", width)) - 1;
  const footer = lines.slice(footerStart);
  const clipped = [...lines.slice(0, Math.min(footerStart, height - footer.length)), ...footer];
  while (clipped.length < height) {
    clipped.splice(clipped.length - 1, 0, frameLine("", width));
  }
  return clipped.map((line) => trimToWidth(line, innerWidth + 4)).join("\n").trimEnd();
}

export function runCockpitTuiFullscreenKeys(model: CockpitTuiModel, keys: CockpitTuiKey[]): CockpitTuiFullscreenRunResult {
  let state = initialCockpitTuiFullscreenState(model);
  for (const key of keys) {
    const result = updateCockpitTuiFullscreenState(model, state, key);
    if (result.type === "state" || result.type === "none") {
      state = result.state;
      continue;
    }
    if (result.type === "select") {
      return { type: "select", state, selection: result.selection };
    }
    return { type: "quit", state };
  }
  return { type: "none", state };
}

export function cockpitTuiKeyFromInput(value: string): CockpitTuiKey {
  if (value === "\u0003") return "q";
  if (value === "\u001b") return "escape";
  if (value === "\r" || value === "\n") return "enter";
  if (value === "\u001b[A") return "up";
  if (value === "\u001b[B") return "down";
  if (value === "\u001b[C") return "right";
  if (value === "\u001b[D") return "left";
  return value;
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

export async function runInteractiveCockpitFullscreen(model: CockpitTuiModel, options: { json: boolean }): Promise<number> {
  const scriptedKeys = readCockpitTuiFullscreenTestKeys();
  if (scriptedKeys !== undefined) {
    const result = runCockpitTuiFullscreenKeys(model, scriptedKeys);
    if (result.type === "select") {
      if (options.json) console.log(JSON.stringify(result.selection, null, 2));
      else console.log(renderCockpitTuiAction(result.selection));
      return 0;
    }
    const quit: CockpitTuiInteractiveQuit = { mode: "terminal-cockpit-interactive", status: "quit" };
    if (options.json) console.log(JSON.stringify(quit, null, 2));
    else console.log("cockpit_interactive=quit");
    return 0;
  }
  if (!options.json) {
    console.log(renderCockpitFullscreen(model));
    console.log("");
  }
  if (process.stdin.isTTY !== true) {
    console.error("osstack: cockpit tui --fullscreen --interactive requires a TTY; use --action N for scripts");
    return 1;
  }
  const result = await runCockpitTuiFullscreenRawMode(model, { json: options.json });
  if (result.type === "select") {
    if (options.json) console.log(JSON.stringify(result.selection, null, 2));
    else console.log(renderCockpitTuiAction(result.selection));
    return 0;
  }
  const quit: CockpitTuiInteractiveQuit = { mode: "terminal-cockpit-interactive", status: "quit" };
  if (options.json) console.log(JSON.stringify(quit, null, 2));
  else console.log("cockpit_interactive=quit");
  return 0;
}

async function runCockpitTuiFullscreenRawMode(
  model: CockpitTuiModel,
  options: { json: boolean },
): Promise<CockpitTuiFullscreenRunResult> {
  const stdin = process.stdin as NodeJS.ReadStream & { setRawMode?: (mode: boolean) => void };
  if (typeof stdin.setRawMode !== "function") {
    console.error("osstack: cockpit tui --fullscreen --interactive raw-mode is unavailable in this terminal");
    return { type: "quit", state: initialCockpitTuiFullscreenState(model) };
  }
  let state = initialCockpitTuiFullscreenState(model);
  return await new Promise<CockpitTuiFullscreenRunResult>((resolve) => {
    const render = () => {
      if (options.json) return;
      process.stdout.write(`\u001b[?25l\u001b[2J\u001b[H${renderCockpitFullscreen(model, { state })}\n`);
    };
    const finish = (result: CockpitTuiFullscreenRunResult) => {
      stdin.off("data", onData);
      stdin.setRawMode?.(false);
      stdin.pause();
      if (!options.json) process.stdout.write("\u001b[?25h\n");
      resolve(result);
    };
    const onData = (chunk: Buffer) => {
      const key = cockpitTuiKeyFromInput(chunk.toString("utf-8"));
      const result = updateCockpitTuiFullscreenState(model, state, key);
      if (result.type === "state" || result.type === "none") {
        state = result.state;
        render();
        return;
      }
      if (result.type === "select") {
        finish({ type: "select", state, selection: result.selection });
        return;
      }
      finish({ type: "quit", state });
    };
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);
    render();
  });
}

export function renderCockpitTuiAction(selection: CockpitTuiActionSelection): string {
  return [
    `selected=${selection.selected_index}`,
    `status=${selection.action.status}`,
    `label=${selection.action.label}`,
    `command=${selection.next_command}`,
  ].join("\n");
}

function readCockpitTuiFullscreenTestKeys(): CockpitTuiKey[] | undefined {
  const testInput = process.env["OSSTACK_TEST_COCKPIT_TUI_KEYS"];
  if (testInput === undefined) return undefined;
  return testInput
    .split(/[,\s]+/)
    .map((key) => key.trim())
    .filter((key) => key.length > 0);
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

function frameLine(value: string, width: number): string {
  const innerWidth = width - 4;
  const text = trimToWidth(value, innerWidth);
  return `| ${text}${" ".repeat(Math.max(0, innerWidth - visibleLength(text)))} |`;
}

function trimToWidth(value: string, width: number): string {
  if (visibleLength(value) <= width) return value;
  if (width <= 1) return value.slice(0, width);
  return `${value.slice(0, Math.max(0, width - 1))}~`;
}

function visibleLength(value: string): number {
  return [...value].length;
}

function clamp(value: number, min: number, max: number): number {
  if (max < min) return 0;
  return Math.min(Math.max(value, min), max);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Display only. These observations never become executable TUI actions. */
function attentionLines(value: Record<string, unknown>): string[] {
  const text = attentionDisplayText;
  const totals = isRecord(value["totals"]) ? value["totals"] : undefined;
  const lines = [
    `${text(value["status"])}${value["reason"] ? " " + text(value["reason"]) : ""} | ${text(value["scope_filter"])} default tenant`,
  ];
  if (totals === undefined) lines.push("counts=unknown");
  else {
    lines.push(`open_items=${text(totals["open_items"])} uncertain_answers=${text(totals["uncertain_answers"])} pending_answers=${text(totals["pending_answers"])}`);
    lines.push(`unmonitored_subjects=${text(totals["unmonitored_subjects"])} dead_letters=${text(totals["dead_letters"])} scopes=${text(totals["scopes"])}`);
    lines.push(`applied_answers=${text(totals["applied_answers"])} (not task completion); missing_source_items=${text(totals["missing_source_items"])}`);
    lines.push(`human_waits=${text(totals["human_waits"])} system_waits=${text(totals["system_waits"])} unknown_waits=${text(totals["unknown_waits"])}`);
  }
  const scopes = Array.isArray(value["scopes"]) ? value["scopes"].filter(isRecord) : [];
  const issue = scopes.find(scope => scope["coverage"] !== "covered");
  if (issue) lines.splice(3, 0, `${text(issue["task_title"])}: ${text(issue["coverage"])} ${text(issue["reason"])}`);
  for (const scope of scopes) lines.push(`${text(scope["task_title"])}: ${text(scope["coverage"])} ${text(scope["reason"])} scope=${text(scope["scope_id"])}`);
  if (value["truncated"] === true) lines.push(`More scopes: returned=${text(value["returned"])} next_after=${text(value["next_after"])}`);
  lines.push("Read-only observation; use attention inventory/inbox for an explicit scope.");
  return lines;
}
