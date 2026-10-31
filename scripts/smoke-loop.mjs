#!/usr/bin/env node
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = join(repoRoot, "packages", "cli", "dist", "bin.js");
const legacyLoopPath = join(repoRoot, "legacy-python", "runtime", "bin", "osb-loop");

if (!existsSync(cliPath)) {
  console.error(`Missing built CLI at ${cliPath}`);
  console.error("Run: pnpm build");
  process.exit(1);
}

const workspace = await mkdtemp(join(tmpdir(), "osstack-loop-smoke-"));
const worktreeRoot = join(workspace, "..", "osstack-loop-smoke-worktrees");
const keepWorkspace = process.env["OSSTACK_SMOKE_KEEP"] === "1";

try {
  await smokeLocalLoop();
  await smokeWorktreeLoop();
  await smokeDeepSeekReviewAdapter();
  await smokeDaemonLoop();
  await smokeLegacyShim();
  console.log(`[smoke] ok workspace=${workspace}`);
} finally {
  if (keepWorkspace) {
    console.log(`[smoke] kept workspace=${workspace}`);
  } else {
    await rm(workspace, { recursive: true, force: true });
    await rm(worktreeRoot, { recursive: true, force: true });
  }
}

async function smokeLocalLoop() {
  const localWorkspace = join(workspace, "local");
  await runCli([
    "loop",
    "enqueue",
    "Write the local smoke marker",
    "--workspace",
    localWorkspace,
    "--capability",
    "code.test",
    "--priority",
    "80",
    "--id",
    "smoke-local",
  ]);

  const doctor = parseJson((await runCli(["loop", "doctor", "--workspace", localWorkspace, "--json"])).stdout);
  assertCheck(doctor, "task_queue", "ok");
  const queueCheck = doctor.checks.find((check) => check.id === "task_queue");
  if (queueCheck?.details?.valid_tasks !== 1) {
    throw new Error(`loop doctor should report one queued task, got ${JSON.stringify(queueCheck)}`);
  }

  const run = await runCli([
    "loop",
    "run",
    "--workspace",
    localWorkspace,
    "--source",
    "task_queue",
    "--execute",
    "node -e \"require('fs').writeFileSync('done.txt', 'ok')\"",
    "--verify",
    "node -e \"process.exit(require('fs').readFileSync('done.txt','utf8') === 'ok' ? 0 : 1)\"",
    "--archive-completed",
    "--json",
  ]);
  const summary = parseJson(run.stdout);
  assertCompleted(summary, "smoke-local", "success");

  const state = await readJson(join(localWorkspace, "LOOP-STATE.json"));
  assertCompleted(state, "smoke-local", "success");
  const markdown = await readFile(join(localWorkspace, "STATE.md"), "utf-8");
  assertIncludes(markdown, "smoke-local - success", "STATE.md should include local task success");
  await stat(join(localWorkspace, "tasks", "archive"));

  const status = await runCli(["loop", "status", "--workspace", localWorkspace]);
  assertIncludes(status.stdout, "smoke-local - success", "loop status should render STATE.md");
}

async function smokeWorktreeLoop() {
  const gitWorkspace = join(workspace, "git");
  await rm(gitWorkspace, { recursive: true, force: true });
  await run("git", ["init", "-b", "main", gitWorkspace], { cwd: repoRoot });
  await writeFile(join(gitWorkspace, "app.txt"), "before\n", "utf-8");
  await run("git", ["add", "app.txt"], { cwd: gitWorkspace });
  await run("git", [
    "-c",
    "user.name=osstack-smoke",
    "-c",
    "user.email=osstack-smoke@example.invalid",
    "commit",
    "-m",
    "initial",
  ], { cwd: gitWorkspace });

  await runCli([
    "loop",
    "enqueue",
    "Update app.txt in an isolated worktree",
    "--workspace",
    gitWorkspace,
    "--capability",
    "code.test",
    "--id",
    "smoke-worktree",
  ]);

  const runResult = await runCli([
    "loop",
    "run",
    "--workspace",
    gitWorkspace,
    "--source",
    "task_queue",
    "--execute",
    "node -e \"require('fs').writeFileSync('app.txt', 'after smoke worktree\\n')\"",
    "--verify",
    "node -e \"process.exit(require('fs').readFileSync('app.txt','utf8') === 'after smoke worktree\\n' ? 0 : 1)\"",
    "--worktree",
    // Local landing is an explicit opt-in pinned to the checked-out branch (D7).
    "--land-branch",
    "main",
    "--worktree-root",
    worktreeRoot,
    "--json",
  ]);
  const summary = parseJson(runResult.stdout);
  assertCompleted(summary, "smoke-worktree", "success");
  assertIncludes(
    await readFile(join(gitWorkspace, "app.txt"), "utf-8"),
    "after smoke worktree",
    "worktree merge should update base workspace",
  );

  const worktrees = await run("git", ["worktree", "list", "--porcelain"], { cwd: gitWorkspace });
  if (worktrees.stdout.includes("osstack/loop/")) {
    throw new Error(`expected osstack worktrees to be cleaned, got:\n${worktrees.stdout}`);
  }
}

async function smokeDeepSeekReviewAdapter() {
  const reviewWorkspace = join(workspace, "ds-review-adapter");
  await rm(reviewWorkspace, { recursive: true, force: true });
  await run("git", ["init", "-b", "main", reviewWorkspace], { cwd: repoRoot });
  await writeFile(join(reviewWorkspace, "app.txt"), "before\n", "utf-8");
  await run("git", ["add", "app.txt"], { cwd: reviewWorkspace });
  await run("git", [
    "-c",
    "user.name=osstack-smoke",
    "-c",
    "user.email=osstack-smoke@example.invalid",
    "commit",
    "-m",
    "initial",
  ], { cwd: reviewWorkspace });
  const binDir = join(reviewWorkspace, "bin");
  await mkdir(binDir, { recursive: true });
  const fakeReview = join(binDir, "ds-review");
  await writeFile(fakeReview, `#!/usr/bin/env bash
set -euo pipefail
if [ "\${1:-}" = "--help" ]; then echo help; exit 0; fi
out=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --output|-o) out="$2"; shift 2 ;;
    --strict) shift ;;
    *) shift ;;
  esac
done
input="$(cat)"
mkdir -p "$(dirname "$out")"
printf 'reviewed diff:\\n%s\\n' "$input" > "$out"
echo "fake ds-review ok"
`, "utf-8");
  await chmod(fakeReview, 0o755);

  const env = { OSSTACK_DS_REVIEW_BIN: fakeReview };
  await runCli([
    "loop",
    "enqueue",
    "Review changed app.txt",
    "--workspace",
    reviewWorkspace,
    "--capability",
    "review.code",
    "--id",
    "smoke-ds-review",
  ], { env });

  const runResult = await runCli([
    "loop",
    "run",
    "--workspace",
    reviewWorkspace,
    "--source",
    "task_queue",
    "--execute",
    "node -e \"require('fs').writeFileSync('app.txt', 'changed by review smoke\\n')\"",
    "--reviewer",
    "ds-review",
    "--json",
  ], { env });
  const summary = parseJson(runResult.stdout);
  assertCompleted(summary, "smoke-ds-review", "success");
  const report = await readFile(join(reviewWorkspace, "reviews", "ds-review", "latest.md"), "utf-8");
  assertIncludes(report, "+changed by review smoke", "ds-review adapter should review git diff");
}

async function smokeDaemonLoop() {
  const daemonWorkspace = join(workspace, "daemon");
  const daemonEnv = {
    OSSTACK_HOME: join(workspace, "daemon-home"),
    OSSTACK_SOCKET: join(workspace, "daemon.sock"),
  };
  let daemon = await startDaemonProcess(daemonEnv);
  try {
    await runCli(["health"], { env: daemonEnv });
    await runCli([
      "loop",
      "enqueue",
      "Write the daemon smoke marker",
      "--workspace",
      daemonWorkspace,
      "--capability",
      "code.test",
      "--id",
      "smoke-daemon",
    ], { env: daemonEnv });

    const daemonDoctor = parseJson((await runCli([
      "loop",
      "doctor",
      "--workspace",
      daemonWorkspace,
      "--daemon",
      "--json",
    ], { env: daemonEnv })).stdout);
    assertCheck(daemonDoctor, "daemon", "ok");

    const start = await runCli([
      "loop",
      "start",
      "--workspace",
      daemonWorkspace,
      "--source",
      "task_queue",
      "--execute",
      "node -e \"require('fs').writeFileSync('daemon-done.txt', 'ok')\"",
      "--verify",
      "node -e \"process.exit(require('fs').readFileSync('daemon-done.txt','utf8') === 'ok' ? 0 : 1)\"",
      "--archive-completed",
      "--once",
      "--interval-ms",
      "25",
      "--json",
    ], { env: daemonEnv });
    const started = parseJson(start.stdout);
    if (typeof started.loop_session_id !== "string") {
      throw new Error(`expected daemon loop_session_id, got ${JSON.stringify(started)}`);
    }

    const session = await waitForLoopSession(started.loop_session_id, daemonEnv, (candidate) => (
      candidate.status === "stopped" && candidate.executed_task_count === 1
    ));
    if (session.successful_task_count !== 1 || session.stop_reason !== "max cycles reached") {
      throw new Error(`unexpected daemon loop session: ${JSON.stringify(session)}`);
    }

    const status = await runCli(["loop", "status", "--daemon", "--workspace", daemonWorkspace], { env: daemonEnv });
    assertIncludes(status.stdout, "smoke-daemon - success", "daemon loop status should include task success");
    await stat(join(daemonWorkspace, "tasks", "archive"));

    const goalWorkspace = join(workspace, "daemon-goal");
    await runCli([
      "loop",
      "enqueue",
      "Stop when the daemon goal passes",
      "--workspace",
      goalWorkspace,
      "--capability",
      "code.test",
      "--id",
      "smoke-daemon-goal",
    ], { env: daemonEnv });

    const goalStart = await runCli([
      "loop",
      "start",
      "--workspace",
      goalWorkspace,
      "--source",
      "task_queue",
      "--execute",
      "node -e \"require('fs').writeFileSync('goal-done.txt', 'ok')\"",
      "--goal",
      "node -e \"process.exit(require('fs').existsSync('goal-done.txt') ? 0 : 1)\"",
      "--cycles",
      "5",
      "--interval-ms",
      "25",
      "--json",
    ], { env: daemonEnv });
    const goalStarted = parseJson(goalStart.stdout);
    if (typeof goalStarted.loop_session_id !== "string") {
      throw new Error(`expected daemon goal loop_session_id, got ${JSON.stringify(goalStarted)}`);
    }
    const goalSession = await waitForLoopSession(goalStarted.loop_session_id, daemonEnv, (candidate) => (
      candidate.status === "stopped" && candidate.executed_task_count === 1
    ));
    if (goalSession.successful_task_count !== 1 || goalSession.stop_reason !== "goal command passed") {
      throw new Error(`unexpected daemon goal loop session: ${JSON.stringify(goalSession)}`);
    }
    const goalStatus = await runCli(["loop", "status", "--daemon", "--workspace", goalWorkspace], { env: daemonEnv });
    assertIncludes(goalStatus.stdout, "goal: passed", "daemon goal loop status should include passed goal decision");

    const scheduledWorkspace = join(workspace, "daemon-scheduled");
    await runCli([
      "loop",
      "enqueue",
      "Run from a daemon cron schedule",
      "--workspace",
      scheduledWorkspace,
      "--capability",
      "code.test",
      "--id",
      "smoke-daemon-scheduled",
    ], { env: daemonEnv });

    const scheduledStart = await runCli([
      "loop",
      "start",
      "--workspace",
      scheduledWorkspace,
      "--source",
      "task_queue",
      "--execute",
      "node -e \"require('fs').writeFileSync('scheduled-done.txt', 'ok')\"",
      "--schedule",
      "* * * * *",
      "--cycles",
      "1",
      "--json",
    ], { env: daemonEnv });
    const scheduledStarted = parseJson(scheduledStart.stdout);
    if (typeof scheduledStarted.loop_session_id !== "string" || scheduledStarted.schedule !== "* * * * *") {
      throw new Error(`expected daemon scheduled loop_session_id, got ${JSON.stringify(scheduledStarted)}`);
    }
    const scheduledSession = await waitForLoopSession(scheduledStarted.loop_session_id, daemonEnv, (candidate) => (
      candidate.status === "stopped" && candidate.executed_task_count === 1
    ));
    if (scheduledSession.stop_reason !== "max cycles reached") {
      throw new Error(`unexpected daemon scheduled loop session: ${JSON.stringify(scheduledSession)}`);
    }
    const scheduledStatus = await runCli(["loop", "status", "--daemon", "--workspace", scheduledWorkspace], { env: daemonEnv });
    assertIncludes(
      scheduledStatus.stdout,
      "smoke-daemon-scheduled - success",
      "daemon scheduled loop status should include task success",
    );

    const stats = await runCli(["stats"], { env: daemonEnv });
    assertIncludes(stats.stdout, "loop_sessions=3", "daemon stats should include smoke loop sessions");
    assertIncludes(stats.stdout, "loop_cycles=3", "daemon stats should include completed loop cycles");
    assertIncludes(stats.stdout, "executed=3", "daemon stats should include executed task count");
    assertIncludes(stats.stdout, "ok=3", "daemon stats should include successful task count");

    const recoveryWorkspace = join(workspace, "daemon-kill-recovery");
    const recoveryStart = await runCli([
      "loop",
      "start",
      "--workspace",
      recoveryWorkspace,
      "--source",
      "task_queue",
      "--execute",
      "node -e \"require('fs').writeFileSync('kill-recovery-done.txt', 'ok')\"",
      "--interval-ms",
      "50",
      "--json",
    ], { env: daemonEnv });
    const recoveryStarted = parseJson(recoveryStart.stdout);
    if (typeof recoveryStarted.loop_session_id !== "string") {
      throw new Error(`expected daemon recovery loop_session_id, got ${JSON.stringify(recoveryStarted)}`);
    }
    await waitForLoopSession(recoveryStarted.loop_session_id, daemonEnv, (candidate) => (
      candidate.status === "running" && candidate.executed_task_count === 0
    ));

    await daemon.kill("SIGKILL");
    daemon = null;

    await mkdir(join(recoveryWorkspace, "tasks"), { recursive: true });
    await writeFile(join(recoveryWorkspace, "tasks", "kill-recovery.json"), JSON.stringify({
      task_id: "smoke-daemon-kill-recovery",
      capability: "code.test",
      prompt: "Resume after the daemon process is killed",
    }), "utf-8");

    daemon = await startDaemonProcess(daemonEnv);
    const recovered = await waitForLoopSession(recoveryStarted.loop_session_id, daemonEnv, (candidate) => (
      candidate.status === "running" && candidate.executed_task_count >= 1
    ));
    if (recovered.successful_task_count < 1) {
      throw new Error(`expected recovered daemon loop to complete queued task, got ${JSON.stringify(recovered)}`);
    }

    const recoveryStatus = await runCli(["loop", "status", "--daemon", "--workspace", recoveryWorkspace], { env: daemonEnv });
    assertIncludes(
      recoveryStatus.stdout,
      "smoke-daemon-kill-recovery - success",
      "daemon loop should resume persisted session after SIGKILL and restart",
    );

    await runCli(["loop", "stop", recoveryStarted.loop_session_id, "--json"], { env: daemonEnv });
    await waitForLoopSession(recoveryStarted.loop_session_id, daemonEnv, (candidate) => candidate.status === "stopped");

    const recoveryStats = await runCli(["stats"], { env: daemonEnv });
    assertIncludes(recoveryStats.stdout, "loop_sessions=4", "daemon stats should include recovered loop session");
    assertIncludes(recoveryStats.stdout, "executed=4", "daemon stats should include recovered task execution");
    assertIncludes(recoveryStats.stdout, "ok=4", "daemon stats should include recovered successful task");
  } finally {
    await daemon?.stop();
  }
}

async function smokeLegacyShim() {
  const legacyWorkspace = join(workspace, "legacy-shim");
  await rm(legacyWorkspace, { recursive: true, force: true });
  await run("git", ["init", "-b", "main", legacyWorkspace], { cwd: repoRoot });
  await writeFile(join(legacyWorkspace, "legacy.txt"), "before\n", "utf-8");
  await run("git", ["add", "legacy.txt"], { cwd: legacyWorkspace });
  await run("git", [
    "-c",
    "user.name=osstack-smoke",
    "-c",
    "user.email=osstack-smoke@example.invalid",
    "commit",
    "-m",
    "initial",
  ], { cwd: legacyWorkspace });
  await writeFile(join(legacyWorkspace, "legacy.txt"), "after legacy shim\n", "utf-8");

  await run("bash", [
    legacyLoopPath,
    "--no-review",
    "--no-verify",
    "--output",
    join(legacyWorkspace, "LEGACY-STATE.md"),
  ], {
    cwd: legacyWorkspace,
    env: { OSB_LOOP_WAIT_TIMEOUT_SECONDS: "30" },
    timeoutMs: 45_000,
  });

  const state = await readJson(join(legacyWorkspace, "LOOP-STATE.json"));
  const completed = state.completed_tasks;
  if (!Array.isArray(completed) || completed.length === 0) {
    throw new Error(`legacy osb-loop should complete at least one git_diff task, got ${JSON.stringify(state)}`);
  }
  if (completed.some((task) => task.outcome !== "success" || task.capability !== "code.review")) {
    throw new Error(`legacy osb-loop should complete code.review tasks successfully, got ${JSON.stringify(completed)}`);
  }
  const markdown = await readFile(join(legacyWorkspace, "LEGACY-STATE.md"), "utf-8");
  assertIncludes(markdown, "code.review", "legacy osb-loop output should render loop markdown");
}

async function startDaemonProcess(env) {
  const child = spawn(process.execPath, [cliPath, "serve"], {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  let ready = false;

  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString("utf-8");
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf-8");
  });

  try {
    await waitFor(async () => {
      if (child.exitCode !== null) {
        throw new Error(`daemon exited early with ${child.exitCode}\n${stdout.trim()}\n${stderr.trim()}`);
      }
      if (stdout.includes("osstack daemon listening") || existsSync(env.OSSTACK_SOCKET)) {
        ready = true;
        return true;
      }
      return false;
    }, 5_000, "daemon did not become ready");
  } catch (error) {
    child.kill("SIGKILL");
    throw error;
  }

  return {
    stop: async () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill("SIGTERM");
      try {
        await waitFor(
          () => child.exitCode !== null || child.signalCode !== null,
          5_000,
          "daemon did not stop after SIGTERM",
        );
      } catch (error) {
        child.kill("SIGKILL");
        throw error;
      }
    },
    kill: async (signal) => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill(signal);
      await waitFor(
        () => child.exitCode !== null || child.signalCode !== null,
        5_000,
        `daemon did not exit after ${signal}`,
      );
    },
    get stdout() { return stdout; },
    get stderr() { return stderr; },
    get ready() { return ready; },
  };
}

async function waitForLoopSession(loopSessionId, env, predicate) {
  let last;
  await waitFor(async () => {
    const list = await runCli(["loop", "list", "--json"], { env });
    const result = parseJson(list.stdout);
    if (!Array.isArray(result.loops)) {
      throw new Error(`expected daemon loop list, got ${JSON.stringify(result)}`);
    }
    last = result.loops.find((loop) => loop.loop_session_id === loopSessionId);
    return last !== undefined && predicate(last);
  }, 8_000, () => `loop session did not reach expected state: ${JSON.stringify(last)}`);
  return last;
}

async function runCli(args, options = {}) {
  return await run(process.execPath, [cliPath, ...args], { cwd: repoRoot, ...options });
}

async function run(command, args, options) {
  return await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...(options.env ?? {}) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timeoutMs = options.timeoutMs ?? 30_000;
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      rejectPromise(new Error(`${command} ${args.join(" ")} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf-8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf-8");
    });
    child.on("error", rejectPromise);
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code === 0) {
        resolvePromise({ stdout, stderr });
      } else {
        rejectPromise(new Error([
          `${command} ${args.join(" ")} failed with exit ${code}`,
          stdout.trim(),
          stderr.trim(),
        ].filter(Boolean).join("\n")));
      }
    });
  });
}

async function waitFor(predicate, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      if (await predicate()) return;
    } catch (error) {
      lastError = error;
      if (error.message?.includes("expected daemon loop list")) throw error;
    }
    await sleep(25);
  }
  const rendered = typeof message === "function" ? message() : message;
  if (lastError !== undefined) {
    throw new Error(`${rendered}\nlast error: ${lastError.message}`);
  }
  throw new Error(rendered);
}

async function readJson(path) {
  return parseJson(await readFile(path, "utf-8"));
}

function parseJson(value) {
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new Error(`expected JSON output, got:\n${value}\n${error.message}`);
  }
}

function assertCompleted(value, taskId, outcome) {
  const tasks = value.completed_tasks;
  if (!Array.isArray(tasks)) {
    throw new Error("expected completed_tasks array");
  }
  const task = tasks.find((candidate) => candidate.task_id === taskId);
  if (task?.outcome !== outcome) {
    throw new Error(`expected ${taskId} outcome=${outcome}, got ${JSON.stringify(task)}`);
  }
}

function assertIncludes(value, expected, message) {
  if (!value.includes(expected)) {
    throw new Error(`${message}: missing ${JSON.stringify(expected)} in ${JSON.stringify(value)}`);
  }
}

function assertCheck(result, id, status) {
  const checks = result.checks;
  if (!Array.isArray(checks)) {
    throw new Error(`expected doctor checks array, got ${JSON.stringify(result)}`);
  }
  const check = checks.find((candidate) => candidate.id === id);
  if (check?.status !== status) {
    throw new Error(`expected doctor check ${id}=${status}, got ${JSON.stringify(check)}`);
  }
}
