import { mkdtempSync } from "node:fs";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  LessonDraftConfig,
  discardLessonDraft,
  listLessonDrafts,
  promoteLessonDraft,
  readLessonDraft,
  renderLessonDraft,
  shouldDraftLesson,
  writeLessonDraft,
  type LessonDraftInput,
} from "./lesson-draft.js";
import { LoopEngine } from "./loop-engine.js";
import type { IterationFeedback, Task } from "./types.js";

let workspace: string;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "osstack-lesson-"));
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

describe("shouldDraftLesson", () => {
  it("drafts only when the task recovered from failed attempts", () => {
    expect(shouldDraftLesson({ feedback: [feedback(1)] })).toBe(true);
    expect(shouldDraftLesson({ feedback: [] })).toBe(false);
  });
});

describe("renderLessonDraft", () => {
  it("includes prompt, failed evaluations, verifier catches, fix summary, rule, and suggestions", () => {
    const markdown = renderLessonDraft(draftInput());

    expect(markdown).toContain("# Lesson Draft: auth-session-expiry");
    expect(markdown).toContain("## Task Prompt");
    expect(markdown).toContain("Fix auth session expiry handling");
    expect(markdown).toContain("## Failed Evaluations");
    expect(markdown).toContain("- auth-tests");
    expect(markdown).toContain("## What The Verifier Caught");
    expect(markdown).toContain("Attempt 1: negative expiry test failed");
    expect(markdown).toContain("## Final Fix Summary");
    expect(markdown).toContain("success after 2 iteration(s)");
    expect(markdown).toContain("## Reusable Rule");
    expect(markdown).toContain("auth-tests");
    expect(markdown).toContain("## Suggested Evaluation");
    expect(markdown).toContain("pnpm test -- tests/auth");
    expect(markdown).toContain("## Suggested Target Skill");
    expect(markdown).toContain("never modified automatically");
  });

  it("infers the target skill from publish context when present", () => {
    const input = draftInput();
    input.task = {
      ...input.task,
      context: { publish: { skillId: "auth-hardening" } },
    };
    expect(renderLessonDraft(input)).toContain("- auth-hardening");
  });
});

describe("writeLessonDraft", () => {
  it("writes the draft under loop-lessons/drafts by default", async () => {
    const result = await writeLessonDraft(draftInput(), { workspacePath: workspace });

    expect(result.written).toBe(true);
    expect(result.path).toBe(join(workspace, "loop-lessons", "drafts", "auth-session-expiry.md"));
    await expect(readFile(result.path ?? "", "utf-8")).resolves.toContain("# Lesson Draft: auth-session-expiry");
  });

  it("skips writing when disabled or when there was no failure to learn from", async () => {
    const disabled = await writeLessonDraft(draftInput(), {
      workspacePath: workspace,
      config: { enabled: false },
    });
    expect(disabled).toMatchObject({ written: false, reason: "lesson drafts disabled" });

    const noFailure = await writeLessonDraft(
      { ...draftInput(), feedback: [] },
      { workspacePath: workspace },
    );
    expect(noFailure.written).toBe(false);
  });

  it("parses config defaults", () => {
    const config = LessonDraftConfig.parse({});
    expect(config.enabled).toBe(true);
    expect(config.dir).toBe("loop-lessons/drafts");
  });
});

describe("lesson draft review workflow", () => {
  it("lists drafts with title and suggested skill", async () => {
    const input = draftInput();
    input.task = { ...input.task, context: { publish: { skillId: "auth-hardening" } } };
    await writeLessonDraft(input, { workspacePath: workspace });

    const drafts = await listLessonDrafts(workspace);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({
      id: "auth-session-expiry",
      title: "auth-session-expiry",
      suggested_skill: "auth-hardening",
    });

    const read = await readLessonDraft(workspace, "auth-session-expiry");
    expect(read?.content).toContain("## Reusable Rule");
    expect(await readLessonDraft(workspace, "missing")).toBeNull();
    expect(await listLessonDrafts(join(workspace, "nowhere"))).toEqual([]);
  });

  it("promotes a draft into loop-lessons/promoted without touching skills by default", async () => {
    await writeLessonDraft(draftInput(), { workspacePath: workspace });

    const result = await promoteLessonDraft(workspace, "auth-session-expiry");
    expect(result.promoted).toBe(true);
    expect(result.to).toBe(join(workspace, "loop-lessons", "promoted", "auth-session-expiry.md"));
    expect(result.appended_to).toBeUndefined();
    expect(await listLessonDrafts(workspace)).toEqual([]);
    await expect(readFile(result.to ?? "", "utf-8")).resolves.toContain("# Lesson Draft: auth-session-expiry");
  });

  it("appends the reusable rule to a skill file only with an explicit --to-skill path", async () => {
    await writeLessonDraft(draftInput(), { workspacePath: workspace });
    await writeFile(join(workspace, "SKILL.md"), "# My Skill\n\nExisting content.\n", "utf-8");

    const result = await promoteLessonDraft(workspace, "auth-session-expiry", { toSkillPath: "SKILL.md" });
    expect(result).toMatchObject({ promoted: true, appended_to: "SKILL.md" });

    const skill = await readFile(join(workspace, "SKILL.md"), "utf-8");
    expect(skill).toContain("# My Skill");
    expect(skill).toContain("## Lesson: auth-session-expiry");
    expect(skill).toContain("auth-tests");
    expect(skill).toContain("### Suggested Evaluation");
  });

  it("refuses to promote into a missing skill file and keeps the draft", async () => {
    await writeLessonDraft(draftInput(), { workspacePath: workspace });

    const result = await promoteLessonDraft(workspace, "auth-session-expiry", { toSkillPath: "nope/SKILL.md" });
    expect(result.promoted).toBe(false);
    expect(result.reason).toContain("not found");
    expect(await listLessonDrafts(workspace)).toHaveLength(1);
  });

  it("discards a draft into loop-lessons/discarded", async () => {
    await writeLessonDraft(draftInput(), { workspacePath: workspace });

    const result = await discardLessonDraft(workspace, "auth-session-expiry");
    expect(result.discarded).toBe(true);
    expect(result.to).toBe(join(workspace, "loop-lessons", "discarded", "auth-session-expiry.md"));
    expect(await listLessonDrafts(workspace)).toEqual([]);

    const missing = await discardLessonDraft(workspace, "auth-session-expiry");
    expect(missing.discarded).toBe(false);
  });
});

describe("LoopEngine lesson draft hook", () => {
  it("writes a lesson draft when a task succeeds after a failed attempt", async () => {
    await enqueue("recovering-task");
    // Attempt 1 fails verification, attempt 2 passes: execute bumps a counter,
    // verify requires the counter to reach 2.
    const engine = new LoopEngine({
      workspacePath: workspace,
      sources: ["task_queue"],
      executeCommand: "node -e \"const fs=require('fs');const n=fs.existsSync('n.txt')?Number(fs.readFileSync('n.txt','utf8')):0;fs.writeFileSync('n.txt',String(n+1))\"",
      verifyCommands: ["node -e \"process.exit(Number(require('fs').readFileSync('n.txt','utf8'))>=2?0:1)\""],
      maxIterations: 2,
    });
    const result = await engine.runOnce();

    const completed = result.state.completed_tasks[0];
    expect(completed?.outcome).toBe("success");
    expect(completed?.iterations).toBe(2);
    const draftPath = join(workspace, "loop-lessons", "drafts", "recovering-task.md");
    expect(completed?.lesson_draft_path).toBe(draftPath);
    await expect(readFile(draftPath, "utf-8")).resolves.toContain("# Lesson Draft: recovering-task");

    const drafted = result.events.find((event) => event.type === "loop.lesson.drafted");
    expect(drafted?.payload).toMatchObject({ task_id: "recovering-task", path: draftPath, failed_attempts: 1 });

    const markdown = engine.statusMarkdown(result.state);
    expect(markdown).toContain(`Lesson draft: ${draftPath}`);
  });

  it("writes no draft for first-attempt successes or when disabled", async () => {
    await enqueue("clean-task");
    const cleanEngine = new LoopEngine({
      workspacePath: workspace,
      sources: ["task_queue"],
      executeCommand: "exit 0",
    });
    const cleanResult = await cleanEngine.runOnce();
    expect(cleanResult.state.completed_tasks[0]?.lesson_draft_path).toBeUndefined();
    await expect(access(join(workspace, "loop-lessons"))).rejects.toThrow();

    await enqueue("disabled-task");
    const disabledEngine = new LoopEngine({
      workspacePath: workspace,
      sources: ["task_queue"],
      executeCommand: "node -e \"const fs=require('fs');const n=fs.existsSync('m.txt')?Number(fs.readFileSync('m.txt','utf8')):0;fs.writeFileSync('m.txt',String(n+1))\"",
      verifyCommands: ["node -e \"process.exit(Number(require('fs').readFileSync('m.txt','utf8'))>=2?0:1)\""],
      maxIterations: 2,
      lessonDrafts: { enabled: false },
    });
    const disabledResult = await disabledEngine.runOnce();
    const disabledTask = disabledResult.state.completed_tasks.find((task) => task.task_id === "disabled-task");
    expect(disabledTask?.outcome).toBe("success");
    expect(disabledTask?.lesson_draft_path).toBeUndefined();
    await expect(access(join(workspace, "loop-lessons"))).rejects.toThrow();
  });
});

function feedback(attempt: number): IterationFeedback {
  return {
    attempt,
    verdict_summary: "1 issue found by local verifier.",
    blocking_issues: [{ severity: "error", message: "negative expiry test failed", rule: "verify.command_failed" }],
    failed_evaluations: ["auth-tests"],
    suggested_focus: ["satisfy evaluation auth-tests: Auth test suite passes."],
  };
}

function draftInput(): LessonDraftInput {
  const task: Task = {
    task_id: "auth-session-expiry",
    capability: "code.fix",
    prompt: "Fix auth session expiry handling",
    priority: 80,
    source: "task_queue",
    evaluation: [{
      id: "auth-tests",
      mode: "command",
      description: "Auth test suite passes.",
      required: true,
      command: "pnpm test -- tests/auth",
      target_paths: [],
      forbidden_paths: [],
      weight: 1,
    }],
  };
  return {
    task,
    iterations: 2,
    feedback: [feedback(1)],
    finalVerdict: {
      pass: true,
      score: 1,
      issues: [],
      reviewer_agent_id: "local-verifier",
      summary: "1 verifier command and 0 verifier adapters passed.",
    },
    changedFiles: ["src/auth/session.ts"],
    diffSummary: "1 file changed",
  };
}

async function enqueue(taskId: string): Promise<void> {
  await mkdir(join(workspace, "tasks"), { recursive: true });
  await writeFile(
    join(workspace, "tasks", `${taskId}.json`),
    `${JSON.stringify({ task_id: taskId, capability: "code.fix", prompt: `Recover ${taskId}`, priority: 50 }, null, 2)}\n`,
    "utf-8",
  );
}
