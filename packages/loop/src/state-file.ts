import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { LoopState, type CompletedTask, type Task } from "./types.js";

export interface LoopStateFilePaths {
  jsonPath: string;
  markdownPath: string;
}

export interface WriteLoopStateOptions {
  /** Defaults to STATE.md beside the JSON file. */
  markdownPath?: string;
}

export function createInitialLoopState(loopId: string, now = new Date()): LoopState {
  const timestamp = now.toISOString();
  return LoopState.parse({
    loop_id: loopId,
    started_at: timestamp,
    updated_at: timestamp,
    completed_tasks: [],
    pending: [],
    in_progress: [],
    decisions: [],
  });
}

export async function readLoopState(jsonPath: string): Promise<LoopState | null> {
  try {
    const raw = await readFile(jsonPath, "utf-8");
    return LoopState.parse(JSON.parse(raw));
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

export async function writeLoopState(
  jsonPath: string,
  state: LoopState,
  options: WriteLoopStateOptions = {},
): Promise<LoopStateFilePaths> {
  const parsed = LoopState.parse({
    ...state,
    updated_at: state.updated_at,
  });
  const markdownPath = options.markdownPath ?? join(dirname(jsonPath), "STATE.md");

  await mkdir(dirname(jsonPath), { recursive: true });
  await mkdir(dirname(markdownPath), { recursive: true });

  await writeFileAtomic(jsonPath, `${JSON.stringify(parsed, null, 2)}\n`);
  await writeFileAtomic(markdownPath, renderLoopStateMarkdown(parsed));

  return { jsonPath, markdownPath };
}

export function renderLoopStateMarkdown(state: LoopState): string {
  const lines: string[] = [
    `# Loop State - ${state.updated_at}`,
    "",
    "## In Progress",
    ...renderTasks(state.in_progress ?? [], false),
    "",
    "## Completed",
    ...renderCompletedTasks(state.completed_tasks),
    "",
    "## Pending",
    ...renderTasks(state.pending ?? [], true),
  ];

  if (state.key_metrics) {
    lines.push(
      "",
      "## Key Metrics",
      `- Total cycles: ${state.key_metrics.total_cycles}`,
      `- Average duration: ${state.key_metrics.avg_duration_ms} ms`,
      `- Success rate: ${Math.round(state.key_metrics.success_rate * 100)}%`,
      `- Tokens consumed: ${state.key_metrics.tokens_consumed}`,
    );
  }

  if (state.knowledge !== undefined) {
    lines.push("", "## Knowledge Trace", ...renderKnowledgeTrace(state.knowledge));
  }

  if (state.decisions && state.decisions.length > 0) {
    lines.push("", "## Decisions", ...state.decisions.map((decision) => `- ${decision}`));
  }

  return `${lines.join("\n")}\n`;
}

function renderTasks(tasks: Task[], includePriority: boolean): string[] {
  if (tasks.length === 0) return ["- None"];

  return tasks.map((task) => {
    const priority = includePriority ? `, priority ${task.priority}` : "";
    return `- [ ] ${task.prompt} (${task.capability}${priority})`;
  });
}

function renderCompletedTasks(tasks: CompletedTask[]): string[] {
  if (tasks.length === 0) return ["- None"];

  return tasks.map((task) => {
    const capability = task.capability === undefined ? "" : `, ${task.capability}`;
    return `- [x] ${task.task_id} - ${task.outcome} via ${task.agent_id} (${task.iterations} iteration${task.iterations === 1 ? "" : "s"}, ${task.duration_ms} ms${capability})`;
  });
}

function renderKnowledgeTrace(knowledge: LoopState["knowledge"]): string[] {
  if (knowledge === undefined) return ["- Mode: off"];
  const lines = [
    `- Mode: ${knowledge.mode}`,
    `- Status: ${knowledge.status}`,
  ];
  if (knowledge.query !== undefined) lines.push(`- Query: ${knowledge.query}`);
  if (knowledge.reason !== undefined) lines.push(`- Reason: ${knowledge.reason}`);
  if (knowledge.packs.length > 0) {
    lines.push(...knowledge.packs.map((pack) => (
      `- Pack: ${pack.id}@${pack.version} (${pack.source_kind}, quality ${pack.quality_score})`
    )));
  }
  if (knowledge.results.length > 0) {
    lines.push(...knowledge.results.map((result) => (
      `- Chunk: ${result.chunk_id} (${result.pack_id}@${result.pack_version}, score ${result.score}) - ${result.title}`
    )));
  }
  return lines;
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && error.code === "ENOENT";
}

async function writeFileAtomic(targetPath: string, content: string): Promise<void> {
  const tmpPath = join(dirname(targetPath), `.${basename(targetPath)}.${process.pid}.${Date.now()}.tmp`);
  await writeFile(tmpPath, content, "utf-8");
  await rename(tmpPath, targetPath);
}
