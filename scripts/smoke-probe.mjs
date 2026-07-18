#!/usr/bin/env node

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = join(repoRoot, "packages", "cli", "dist", "bin.js");

if (!existsSync(cliPath)) {
  console.error(`Missing built CLI at ${cliPath}; run pnpm build first.`);
  process.exit(2);
}

const fixtureRoot = await mkdtemp(join(tmpdir(), "osstack-probe-smoke-"));
const workspace = join(fixtureRoot, "repo");
const home = join(fixtureRoot, "home");
const freshHome = join(fixtureRoot, "fresh-home");
await mkdir(join(workspace, "docs"), { recursive: true });
await mkdir(home, { recursive: true });
await mkdir(freshHome, { recursive: true });
await writeFile(
  join(workspace, "docs", "intent.md"),
  "# Probe smoke intent\n\nPersist architecture decisions before implementation.\n",
  "utf8",
);

try {
  for (let index = 1; index <= 10; index++) {
    await exerciseSession(index);
  }
  console.log(
    "probe smoke PASS: 10 restart-safe sessions, idempotent writes, portable rendering, and fresh-home gate parity",
  );
} finally {
  await rm(fixtureRoot, { recursive: true, force: true });
}

async function exerciseSession(index) {
  const started = await probe([
    "start",
    "--repo",
    workspace,
    "--repo-id",
    "probe-smoke",
    "--input",
    "docs/intent.md",
    "--depth",
    "quick",
    "--domain-familiarity",
    "expert",
    "--repo-familiarity",
    "maintainer",
    "--intent-maturity",
    "review_ready",
    "--actor-kind",
    "human",
    "--actor-id",
    "smoke-owner",
    "--idempotency-key",
    `start-${index}`,
    "--json",
  ]);
  const sessionId = started.session.session_id;
  const firstItemId = started.current_item.item_id;

  if (index === 1) {
    const replayedStart = await probe([
      "start",
      "--repo",
      workspace,
      "--repo-id",
      "probe-smoke",
      "--input",
      "docs/intent.md",
      "--depth",
      "quick",
      "--domain-familiarity",
      "expert",
      "--repo-familiarity",
      "maintainer",
      "--intent-maturity",
      "review_ready",
      "--actor-kind",
      "human",
      "--actor-id",
      "smoke-owner",
      "--idempotency-key",
      `start-${index}`,
      "--json",
    ]);
    assert(replayedStart.session.session_id === sessionId, "start retry changed session");
  }

  const answered = await probe([
    "next",
    "--session",
    sessionId,
    "--question",
    firstItemId,
    "--if-revision",
    "1",
    "--answer",
    "Use versioned schemas and transactionally persisted events.",
    "--destination-role",
    "technical_design",
    "--destination-path",
    "docs/technical-design.md",
    "--actor-kind",
    "human",
    "--actor-id",
    "smoke-owner",
    "--idempotency-key",
    `answer-${index}`,
    "--json",
  ]);
  const secondItemId = answered.current_item.item_id;
  const repeatedRead = await probe([
    "next",
    "--session",
    sessionId,
    "--json",
  ]);
  assert(repeatedRead.current_item.item_id === secondItemId, "read advanced the question");

  const paused = await probe([
    "next",
    "--session",
    sessionId,
    "--question",
    secondItemId,
    "--if-revision",
    "2",
    "--pause",
    "--reason",
    "restart checkpoint",
    "--actor-kind",
    "human",
    "--actor-id",
    "smoke-owner",
    "--idempotency-key",
    `pause-${index}`,
    "--json",
  ]);
  assert(paused.session.state === "paused", "session did not pause");

  const restarted = await probe([
    "status",
    "--session",
    sessionId,
    "--json",
  ]);
  assert(restarted.session.state === "paused", "restart lost paused state");
  assert(restarted.current_item.item_id === secondItemId, "restart changed current item");

  const resumed = await probe([
    "resume",
    "--session",
    sessionId,
    "--if-revision",
    "3",
    "--actor-kind",
    "human",
    "--actor-id",
    "smoke-owner",
    "--idempotency-key",
    `resume-${index}`,
    "--json",
  ]);
  assert(resumed.session.state === "active", "session did not resume");
  assert(resumed.current_item.item_id === secondItemId, "resume skipped current item");

  const replayedResume = await probe([
    "resume",
    "--session",
    sessionId,
    "--if-revision",
    "3",
    "--actor-kind",
    "human",
    "--actor-id",
    "smoke-owner",
    "--idempotency-key",
    `resume-${index}`,
    "--json",
  ]);
  assert(replayedResume.session.revision === 4, "resume retry changed revision");

  const ledger = await probe([
    "ledger",
    "--session",
    sessionId,
    "--json",
  ]);
  assert(ledger.events.length === 4, `expected 4 events, got ${ledger.events.length}`);
  assert(ledger.session.revision === 4, "ledger revision mismatch");

  if (index === 1) {
    await probe([
      "render",
      "--session",
      sessionId,
      "--if-revision",
      "4",
      "--target",
      "ledger",
      "--actor-kind",
      "agent",
      "--actor-id",
      "probe-smoke",
      "--idempotency-key",
      "render-1",
      "--json",
    ]);
    const liveGate = await probe([
      "gate",
      "--session",
      sessionId,
      "--json",
    ]);
    const portableGate = await probe(
      [
        "gate",
        "--ledger",
        `docs/probe/sessions/${sessionId}/ledger.json`,
        "--json",
      ],
      freshHome,
    );
    assert(
      JSON.stringify(liveGate.readiness) ===
        JSON.stringify(portableGate.readiness),
      "fresh-home portable gate differs from live session gate",
    );
  }
}

async function probe(args, commandHome = home) {
  const { stdout, stderr } = await execFileAsync(
    process.execPath,
    [cliPath, "probe", ...args],
    {
      cwd: workspace,
      encoding: "utf8",
      timeout: 20_000,
      env: {
        ...process.env,
        OSSTACK_HOME: commandHome,
      },
    },
  );
  assert(stderr === "", `unexpected stderr: ${stderr}`);
  const envelope = JSON.parse(stdout);
  assert(envelope.status === "ok", `probe failed: ${stdout}`);
  assert(envelope.result?.command?.startsWith("probe."), "invalid probe command envelope");
  return envelope.result;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
