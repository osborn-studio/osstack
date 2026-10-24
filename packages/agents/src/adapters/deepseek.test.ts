import { mkdtempSync } from "node:fs";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { HermesEvent } from "@osstack/hermes-adapter";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentTask } from "../base.js";
import {
  extractEvaluationJudgments,
  extractImplementationDeviations,
} from "./deepseek-command.js";
import { DeepSeekReviewAdapter } from "./ds-review.js";
import { DeepSeekVerifyAdapter } from "./ds-verify.js";

const execFileAsync = promisify(execFile);

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "osstack-deepseek-adapter-"));
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(tmp, { recursive: true, force: true });
});

describe("DeepSeekReviewAdapter", () => {
  it("advertises review capabilities and runs ds-review over git diff", async () => {
    const workspace = await gitWorkspace();
    await writeFile(join(workspace, "app.txt"), "changed\n", "utf-8");
    const bin = await fakeCommand("ds-review", `
input="$(cat)"
out="$2"
mkdir -p "$(dirname "$out")"
printf 'reviewed:%s\\n' "$input" > "$out"
printf 'review ok\\n'
`);
    const adapter = new DeepSeekReviewAdapter({ bin });

    expect(adapter.capabilities().map((c) => c.kind).sort()).toEqual(["code.review", "review.code"]);
    await expect(adapter.isAvailable()).resolves.toMatchObject({ available: true });

    const events = await drain(adapter.invoke(task("ds-review.review.code", workspace), new AbortController().signal));
    expect(doneStatus(events)).toBe("completed");
    expect(events.some((event) => event.type === "token.delta")).toBe(true);
    await expect(readFile(reviewOutput(events, "ds-review", workspace), "utf-8"))
      .resolves.toContain("+changed");
  });

  it("reports unavailable when the command cannot be spawned", async () => {
    const adapter = new DeepSeekReviewAdapter({ bin: join(tmp, "missing-ds-review") });

    const availability = await adapter.isAvailable();

    expect(availability.available).toBe(false);
    expect(availability.reason).toContain("spawn");
  });
});

describe("DeepSeekVerifyAdapter", () => {
  it("advertises verifier capabilities and forwards strict output options", async () => {
    const workspace = await gitWorkspace();
    const bin = await fakeCommand("ds-verify", `
out=""
strict="no"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --output) out="$2"; shift 2 ;;
    --strict) strict="yes"; shift ;;
    --help) echo help; exit 0 ;;
    *) shift ;;
  esac
done
mkdir -p "$(dirname "$out")"
printf 'verify strict=%s\\n' "$strict" > "$out"
printf 'verify ok\\n'
`);
    const adapter = new DeepSeekVerifyAdapter({ bin, strict: true });

    expect(adapter.capabilities().map((c) => c.kind).sort()).toEqual([
      "release.verify",
      "verify.acceptance",
      "verify.alignment",
    ]);

    const events = await drain(adapter.invoke(task("ds-verify.verify.alignment", workspace), new AbortController().signal));
    expect(doneStatus(events)).toBe("completed");
    await expect(readFile(reviewOutput(events, "ds-verify", workspace), "utf-8"))
      .resolves.toContain("strict=yes");
  });

  it("forwards evaluation specs via env file and reports per-spec judgments", async () => {
    const workspace = await gitWorkspace();
    const bin = await fakeCommand("ds-verify", `
out=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --output) out="$2"; shift 2 ;;
    *) shift ;;
  esac
done
mkdir -p "$(dirname "$out")"
cp "$OSSTACK_EVALUATION_SPECS_FILE" "$out"
printf 'OSSTACK_EVALUATIONS: {"evaluations":[{"id":"no-bypass","pass":false,"summary":"constant allow found"},{"id":"docs-updated","pass":true}]}\\n'
printf 'OSSTACK_IMPLEMENTATION_DEVIATIONS: {"deviations":[{"deviation_id":"boundary-drift"}]}\\n'
`);
    const adapter = new DeepSeekVerifyAdapter({ bin });

    const specs = [
      { id: "no-bypass", mode: "semantic_review", description: "No authorization bypass.", acceptance: "Reject constant allow." },
      { id: "docs-updated", mode: "semantic_review", description: "Docs updated." },
    ];
    const agentTask: AgentTask = {
      ...task("ds-verify.verify.alignment", workspace),
      context: { repo_path: workspace, evaluation_specs: specs },
    };
    const events = await drain(adapter.invoke(agentTask, new AbortController().signal));

    expect(doneStatus(events)).toBe("completed");
    const done = [...events].reverse().find((event) => event.type === "done");
    expect((done?.payload as { evaluation_judgments?: unknown }).evaluation_judgments).toEqual([
      { id: "no-bypass", pass: false, summary: "constant allow found" },
      { id: "docs-updated", pass: true },
    ]);
    expect((done?.payload as { implementation_deviations?: unknown }).implementation_deviations).toEqual([
      { deviation_id: "boundary-drift" },
    ]);
    // The binary saw the full spec JSON through OSSTACK_EVALUATION_SPECS_FILE.
    await expect(readFile(reviewOutput(events, "ds-verify", workspace), "utf-8"))
      .resolves.toContain("Reject constant allow.");
  });

  it("extracts only well-formed judgment lines from stdout", () => {
    expect(extractEvaluationJudgments("no judgments here\n")).toEqual([]);
    expect(extractEvaluationJudgments("OSSTACK_EVALUATIONS: not json\n")).toEqual([]);
    expect(extractEvaluationJudgments([
      "noise",
      'OSSTACK_EVALUATIONS: {"evaluations":[{"id":"stale","pass":false}]}',
      'OSSTACK_EVALUATIONS: {"evaluations":[{"id":"a","pass":true,"summary":"ok"},{"pass":true},{"id":"b","pass":"yes"}]}',
    ].join("\n"))).toEqual([{ id: "a", pass: true, summary: "ok" }]);
  });

  it("transports only explicitly enveloped implementation deviation objects", () => {
    expect(extractImplementationDeviations("ordinary review failure\n")).toEqual([]);
    expect(extractImplementationDeviations([
      "noise",
      "OSSTACK_IMPLEMENTATION_DEVIATIONS: not-json",
      'OSSTACK_IMPLEMENTATION_DEVIATIONS: {"deviations":[{"deviation_id":"boundary-drift"},null,"prose"]}',
    ].join("\n"))).toEqual([{ deviation_id: "boundary-drift" }]);
  });

  it("maps command failures to terminal error and failed done events", async () => {
    const workspace = await gitWorkspace();
    const bin = await fakeCommand("ds-verify", `
if [ "$1" = "--help" ]; then echo help; exit 0; fi
echo verify failed >&2
exit 7
`);
    const adapter = new DeepSeekVerifyAdapter({ bin });

    const events = await drain(adapter.invoke(task("ds-verify.verify.alignment", workspace), new AbortController().signal));

    expect(events).toContainEqual(expect.objectContaining({
      type: "error",
      payload: expect.objectContaining({ code: "deepseek_command_failed" }),
    }));
    expect(doneStatus(events)).toBe("failed");
  });
});

async function drain(it: AsyncIterable<HermesEvent>): Promise<HermesEvent[]> {
  const events: HermesEvent[] = [];
  for await (const event of it) events.push(event);
  return events;
}

function doneStatus(events: HermesEvent[]): string | undefined {
  const done = [...events].reverse().find((event: HermesEvent) => event.type === "done");
  return done === undefined ? undefined : String((done.payload as { status?: unknown }).status);
}

function task(capabilityId: string, workspace: string): AgentTask {
  return {
    run_id: `run_${capabilityId.replaceAll(".", "_")}`,
    task_id: "task-1",
    session_id: "session-1",
    capability_id: capabilityId,
    prompt: "Run DeepSeek adapter",
    context: { repo_path: workspace },
  };
}

async function fakeCommand(name: string, body: string): Promise<string> {
  const bin = join(tmp, name);
  await writeFile(bin, `#!/usr/bin/env bash\nset -euo pipefail\nif [ "\${1:-}" = "--help" ]; then echo help; exit 0; fi\n${body}\n`, "utf-8");
  await chmod(bin, 0o755);
  return bin;
}

async function gitWorkspace(): Promise<string> {
  const workspace = join(tmp, `repo-${Math.random().toString(16).slice(2)}`);
  await mkdir(workspace, { recursive: true });
  await execFileAsync("git", ["init"], { cwd: workspace });
  await execFileAsync("git", ["config", "user.name", "test"], { cwd: workspace });
  await execFileAsync("git", ["config", "user.email", "test@example.invalid"], { cwd: workspace });
  await writeFile(join(workspace, "app.txt"), "base\n", "utf-8");
  await execFileAsync("git", ["add", "app.txt"], { cwd: workspace });
  await execFileAsync("git", ["commit", "-m", "initial"], { cwd: workspace });
  return workspace;
}

function reviewOutput(events: HermesEvent[], id: string, workspace: string): string {
 const output=events.find(event=>event.type==='progress'&&(event.payload as {phase?:string}).phase===`${id}.output`);
 const path=(JSON.parse((output?.payload as {detail:string}).detail) as {path:string}).path;
 expect(isAbsolute(path)).toBe(true);const rel=relative(workspace,path);expect(rel==='..'||rel.startsWith('..'+sep)).toBe(true);return path;
}
it('retains an explicit caller output path instead of replacing it with scratch',async()=>{
 const workspace=await gitWorkspace(),destination=join(tmp,'explicit-review.md');
 const bin=await fakeCommand('explicit-review',`cat >/dev/null
printf 'explicit' > "$2"
`);
 const adapter=new DeepSeekReviewAdapter({bin,outputPath:destination});
 const events=await drain(adapter.invoke(task('ds-review.review.code',workspace),new AbortController().signal));
 expect(doneStatus(events)).toBe('completed');expect(await readFile(destination,'utf8')).toBe('explicit');
});
it('keeps the explicit task output override ahead of the adapter option',async()=>{
 const workspace=await gitWorkspace(),destination=join(tmp,'task-review.md'),fallback=join(tmp,'option-review.md');
 const bin=await fakeCommand('context-review',`cat >/dev/null\nprintf 'task override' > "$2"\n`);
 const adapter=new DeepSeekReviewAdapter({bin,outputPath:fallback});const input=task('ds-review.review.code',workspace);
 input.context={...input.context,review_output_path:destination};
 const events=await drain(adapter.invoke(input,new AbortController().signal));
 expect(doneStatus(events)).toBe('completed');expect(await readFile(destination,'utf8')).toBe('task override');await expect(readFile(fallback)).rejects.toThrow();
});

it('reports output allocation failure as failed events without running the command',async()=>{
 const workspace=await gitWorkspace(),badRoot=join(tmp,'not-directory'),marker=join(tmp,'spawned');await writeFile(badRoot,'file');
 const bin=await fakeCommand('allocation-failure',`printf 'spawned' > "${marker}"
`);vi.stubEnv('OSSTACK_SCRATCH_ROOT',badRoot);
 const events=await drain(new DeepSeekReviewAdapter({bin}).invoke(task('ds-review.review.code',workspace),new AbortController().signal));
 expect(doneStatus(events)).toBe('failed');expect(events).toContainEqual(expect.objectContaining({type:'error',payload:expect.objectContaining({code:'deepseek_output_unavailable'})}));await expect(readFile(marker)).rejects.toThrow();
});
it('does not start the reviewer when cancelled after allocating default output',async()=>{
 const workspace=await gitWorkspace(),marker=join(tmp,'spawned');const bin=await fakeCommand('abort-output',`printf 'spawned' > "${marker}"
`);
 const controller=new AbortController(),iterator=new DeepSeekReviewAdapter({bin}).invoke(task('ds-review.review.code',workspace),controller.signal)[Symbol.asyncIterator]();
 expect((await iterator.next()).value?.type).toBe('run.started');const output=await iterator.next();expect((output.value?.payload as {phase:string}).phase).toBe('ds-review.output');controller.abort();
 const events:HermesEvent[]=[];for(;;){const next=await iterator.next();if(next.done)break;events.push(next.value);}expect(doneStatus(events)).toBe('cancelled');await expect(readFile(marker)).rejects.toThrow();
});
it('preserves long paths and repeated spaces in progress and completion evidence',async()=>{
 const workspace=await gitWorkspace(),destination=join(tmp,'a'.repeat(80),'two  spaces','b'.repeat(80),'c'.repeat(80),'output.md');await mkdir(dirname(destination),{recursive:true});
 const bin=await fakeCommand('long-output',`printf 'artifact' > "$2"
`);const events=await drain(new DeepSeekVerifyAdapter({bin,outputPath:destination}).invoke(task('ds-verify.verify.alignment',workspace),new AbortController().signal));
 expect(doneStatus(events)).toBe('completed');expect(reviewOutput(events,'ds-verify',workspace)).toBe(destination);const done=[...events].reverse().find(event=>event.type==='done');expect((done?.payload as {result_summary:string}).result_summary).toContain(JSON.stringify(destination));expect(await readFile(destination,'utf8')).toBe('artifact');
});
