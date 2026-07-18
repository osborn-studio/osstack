import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentCommandResult } from "@osstack/protocol";
import { probeSha256 } from "@osstack/governance";
import { EvaluationSpec } from "@osstack/loop";
import { listProbeEvents, openDb } from "@osstack/core";
import { afterEach, describe, expect, it } from "vitest";
import {
  handleProbeCommand,
  type ProbeCommandDependencies,
} from "./probe-command.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function harness() {
  const root = await mkdtemp(join(tmpdir(), "osstack-probe-cli-"));
  temporaryDirectories.push(root);
  const repo = join(root, "repo");
  const home = join(root, "home");
  await mkdir(repo, { recursive: true });
  await mkdir(home, { recursive: true });
  await writeFile(join(repo, "spec.md"), "# Probe feature\n", "utf8");
  const stdout: string[] = [];
  const stderr: string[] = [];
  let idSequence = 0;
  const deps: ProbeCommandDependencies = {
    cwd: () => repo,
    stdout: (value) => stdout.push(value),
    stderr: (value) => stderr.push(value),
    now_ms: () => 100 + idSequence,
    create_id: (prefix) => `${prefix}_1234567${++idSequence}`,
    state_db_path: async () => join(home, "state.db"),
    inspect_repository: async () => ({
      source_revision: "a".repeat(40),
      worktree_state: "dirty",
    }),
    min_free_bytes: 0,
    read_stdin: async () => "stdin value",
  };
  return { repo, home, stdout, stderr, deps };
}

function json(stdout: readonly string[]) {
  expect(stdout).toHaveLength(1);
  return AgentCommandResult.parse(JSON.parse(stdout[0] ?? ""));
}

function startArgs(extra: readonly string[] = []): string[] {
  return [
    "start",
    "--input",
    "spec.md",
    "--actor-kind",
    "human",
    "--actor-id",
    "owner",
    "--idempotency-key",
    "start-001",
    "--json",
    ...extra,
  ];
}

describe("handleProbeCommand", () => {
  it("starts a strict, persisted one-question-at-a-time session", async () => {
    const command = await harness();

    expect(await handleProbeCommand(startArgs(), command.deps)).toBe(0);
    const envelope = json(command.stdout);
    expect(envelope).toMatchObject({
      status: "ok",
      result: {
        command: "probe.start",
        session: {
          repo_id: "repo",
          state: "active",
          revision: 1,
          question_budget: 20,
          questions_presented: 1,
        },
        current_item: {
          question_id: "cal.domain_familiarity.v1",
          state: "open",
        },
      },
    });
    expect(command.stderr).toEqual([]);
    const sessionId = (envelope.result?.session as { session_id: string })
      .session_id;
    const db = openDb({
      path: join(command.home, "state.db"),
      minFreeBytes: 0,
    });
    try {
      const event = JSON.parse(
        listProbeEvents(db, sessionId)[0]?.event_json ?? "{}",
      ) as { payload?: Record<string, unknown> };
      expect(event.payload).toMatchObject({
        metric_facts: {
          item_facts: expect.arrayContaining([
            expect.objectContaining({
              item_id: expect.stringMatching(/^pi_/),
              required: true,
              severity: expect.stringMatching(/^(high|medium|low)$/),
              impact: expect.any(Number),
              origin: "calibration",
            }),
          ]),
        },
      });
    } finally {
      db.close();
    }
  });

  it("rejects destination flags on calibration answers", async () => {
    const command = await harness();
    await handleProbeCommand(startArgs(), command.deps);
    const started = json(command.stdout);
    const session = started.result?.session as {
      session_id: string;
      revision: number;
    };
    const item = started.result?.current_item as { item_id: string };

    command.stdout.length = 0;
    const code = await handleProbeCommand(
      [
        "next",
        "--session",
        session.session_id,
        "--question",
        item.item_id,
        "--if-revision",
        String(session.revision),
        "--answer",
        "working",
        "--destination-role",
        "technical_design",
        "--destination-path",
        "docs/design.md",
        "--actor-kind",
        "human",
        "--actor-id",
        "owner",
        "--idempotency-key",
        "answer-with-destination",
        "--json",
      ],
      command.deps,
    );

    expect(code).toBe(2);
    expect(json(command.stdout)).toMatchObject({
      status: "error",
      error: { code: "bad_request" },
    });
  });

  it("uses the registered repository identity for start and repo status", async () => {
    const command = await harness();
    command.deps.resolve_repo_id = async () => "registered-osstack";

    expect(await handleProbeCommand(startArgs(), command.deps)).toBe(0);
    expect(json(command.stdout).result).toMatchObject({
      session: { repo_id: "registered-osstack" },
    });

    command.stdout.length = 0;
    expect(
      await handleProbeCommand(
        ["status", "--repo", command.repo, "--json"],
        command.deps,
      ),
    ).toBe(0);
    expect(json(command.stdout).result).toMatchObject({
      command: "probe.status",
      repo_id: "registered-osstack",
      sessions: [expect.objectContaining({ repo_id: "registered-osstack" })],
    });
  });

  it("rejects a destination whose existing symlink ancestor escapes the repo", async () => {
    const command = await harness();
    const outside = join(command.home, "outside");
    await mkdir(outside, { recursive: true });
    await symlink(outside, join(command.repo, "escaped"));
    await handleProbeCommand(
      startArgs([
        "--domain-familiarity",
        "expert",
        "--repo-familiarity",
        "maintainer",
        "--intent-maturity",
        "review_ready",
      ]),
      command.deps,
    );
    const started = json(command.stdout);
    const session = started.result?.session as {
      session_id: string;
      revision: number;
    };
    const item = started.result?.current_item as { item_id: string };

    command.stdout.length = 0;
    const code = await handleProbeCommand(
      [
        "next",
        "--session",
        session.session_id,
        "--question",
        item.item_id,
        "--if-revision",
        String(session.revision),
        "--answer",
        "Use an explicit schema.",
        "--destination-role",
        "technical_design",
        "--destination-path",
        "escaped/design.md",
        "--actor-kind",
        "human",
        "--actor-id",
        "owner",
        "--idempotency-key",
        "escaping-destination",
        "--json",
      ],
      command.deps,
    );

    expect(code).toBe(2);
    expect(json(command.stdout)).toMatchObject({
      status: "error",
      error: { code: "bad_request" },
    });
  });

  it("renders a manifest-last portable ledger and detects later manual edits", async () => {
    const command = await harness();
    await handleProbeCommand(
      startArgs([
        "--domain-familiarity",
        "expert",
        "--repo-familiarity",
        "maintainer",
        "--intent-maturity",
        "review_ready",
      ]),
      command.deps,
    );
    const started = json(command.stdout);
    const session = started.result?.session as {
      session_id: string;
      revision: number;
    };

    const renderArgs = [
      "render",
      "--session",
      session.session_id,
      "--if-revision",
      String(session.revision),
      "--target",
      "all",
      "--actor-kind",
      "agent",
      "--actor-id",
      "codex",
      "--idempotency-key",
      "render-001",
      "--json",
    ];
    command.stdout.length = 0;
    expect(await handleProbeCommand(renderArgs, command.deps)).toBe(0);
    const rendered = json(command.stdout);
    const artifact = rendered.result?.artifact as {
      out_dir: string;
      manifest: { files: Array<{ path: string }> };
    };
    expect(artifact.manifest.files.map((file) => file.path)).toEqual([
      "ledger.json",
      "ledger.md",
      "product-delta.md",
      "technical-delta.md",
      "test-matrix.md",
    ]);
    const output = join(command.repo, artifact.out_dir);
    await expect(
      readFile(join(output, "render-manifest.json"), "utf8"),
    ).resolves.toContain(`"session_id":"${session.session_id}"`);

    command.stdout.length = 0;
    expect(await handleProbeCommand(renderArgs, command.deps)).toBe(0);
    expect(json(command.stdout).result).toEqual(rendered.result);

    await writeFile(join(output, "ledger.md"), "manual edit\n", "utf8");
    command.stdout.length = 0;
    expect(await handleProbeCommand(renderArgs, command.deps)).toBe(3);
    expect(json(command.stdout)).toMatchObject({
      status: "error",
      error: { code: "conflict" },
    });
  });

  it("attests destination content without editing it and reserves verification for humans", async () => {
    const command = await harness();
    await handleProbeCommand(
      startArgs([
        "--domain-familiarity",
        "expert",
        "--repo-familiarity",
        "maintainer",
        "--intent-maturity",
        "review_ready",
      ]),
      command.deps,
    );
    const started = json(command.stdout);
    const session = started.result?.session as { session_id: string };
    const first = started.result?.current_item as { item_id: string };
    command.stdout.length = 0;
    await handleProbeCommand(
      [
        "next",
        "--session",
        session.session_id,
        "--question",
        first.item_id,
        "--if-revision",
        "1",
        "--answer",
        "Use a versioned model.",
        "--destination-role",
        "technical_design",
        "--destination-path",
        "docs/technical-design.md",
        "--actor-kind",
        "human",
        "--actor-id",
        "owner",
        "--idempotency-key",
        "answer-for-attestation",
        "--json",
      ],
      command.deps,
    );

    const appliedArgs = [
      "ledger",
      "destination",
      "--session",
      session.session_id,
      "--item",
      first.item_id,
      "--state",
      "applied",
      "--content-sha256",
      "a".repeat(64),
      "--if-revision",
      "2",
      "--actor-kind",
      "agent",
      "--actor-id",
      "codex",
      "--idempotency-key",
      "destination-applied",
      "--json",
    ];
    command.stdout.length = 0;
    expect(await handleProbeCommand(appliedArgs, command.deps)).toBe(0);
    expect(json(command.stdout).result).toMatchObject({
      command: "probe.ledger.destination",
      session: { revision: 3 },
    });
    command.stdout.length = 0;
    await handleProbeCommand(
      ["ledger", "--session", session.session_id, "--state", "resolved", "--json"],
      command.deps,
    );
    expect(json(command.stdout).result?.items).toEqual([
      expect.objectContaining({
        item_id: first.item_id,
        destination: {
          role: "technical_design",
          path: "docs/technical-design.md",
          write_state: "applied",
          content_sha256: "a".repeat(64),
        },
      }),
    ]);
    await expect(
      readFile(join(command.repo, "docs/technical-design.md"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });

    command.stdout.length = 0;
    expect(
      await handleProbeCommand(
        [
          ...appliedArgs.slice(0, appliedArgs.indexOf("--state") + 1),
          "verified",
          "--content-sha256",
          "a".repeat(64),
          "--if-revision",
          "3",
          "--actor-kind",
          "agent",
          "--actor-id",
          "codex",
          "--idempotency-key",
          "destination-agent-verified",
          "--json",
        ],
        command.deps,
      ),
    ).toBe(2);

    command.stdout.length = 0;
    expect(
      await handleProbeCommand(
        [
          "ledger",
          "destination",
          "--session",
          session.session_id,
          "--item",
          first.item_id,
          "--state",
          "verified",
          "--content-sha256",
          "a".repeat(64),
          "--if-revision",
          "3",
          "--actor-kind",
          "human",
          "--actor-id",
          "owner",
          "--idempotency-key",
          "destination-human-verified",
          "--json",
        ],
        command.deps,
      ),
    ).toBe(0);
    expect(json(command.stdout).result).toMatchObject({
      session: { revision: 4 },
    });
    command.stdout.length = 0;
    await handleProbeCommand(
      ["ledger", "--session", session.session_id, "--state", "resolved", "--json"],
      command.deps,
    );
    expect(json(command.stdout).result?.items).toEqual([
      expect.objectContaining({
        item_id: first.item_id,
        destination: expect.objectContaining({ write_state: "verified" }),
      }),
    ]);
  });

  it("replays start and answer idempotently without duplicating events", async () => {
    const command = await harness();
    await handleProbeCommand(startArgs(), command.deps);
    const started = json(command.stdout);
    const session = started.result?.session as {
      session_id: string;
      revision: number;
    };
    const item = started.result?.current_item as { item_id: string };

    command.stdout.length = 0;
    expect(await handleProbeCommand(startArgs(), command.deps)).toBe(0);
    expect(json(command.stdout).result?.session).toEqual(started.result?.session);

    const answerArgs = [
      "next",
      "--session",
      session.session_id,
      "--question",
      item.item_id,
      "--if-revision",
      "1",
      "--answer",
      "working",
      "--actor-kind",
      "human",
      "--actor-id",
      "owner",
      "--idempotency-key",
      "answer-001",
      "--json",
    ];
    command.stdout.length = 0;
    expect(await handleProbeCommand(answerArgs, command.deps)).toBe(0);
    const answered = json(command.stdout);
    expect(answered.result).toMatchObject({
      command: "probe.next",
      session: { revision: 2, familiarity: { domain: "working" } },
      current_item: { question_id: "cal.repo_familiarity.v1" },
    });

    command.stdout.length = 0;
    expect(await handleProbeCommand(answerArgs, command.deps)).toBe(0);
    expect(json(command.stdout).result).toEqual(answered.result);

    command.stdout.length = 0;
    const ledgerCode = await handleProbeCommand(
      ["ledger", "--session", session.session_id, "--json"],
      command.deps,
    );
    expect(ledgerCode).toBe(0);
    const ledger = json(command.stdout).result as { events: unknown[] };
    expect(ledger.events).toHaveLength(2);
  });

  it("keeps repeated reads stable and rejects stale writes", async () => {
    const command = await harness();
    await handleProbeCommand(startArgs(), command.deps);
    const started = json(command.stdout);
    const sessionId = (started.result?.session as { session_id: string })
      .session_id;
    const itemId = (started.result?.current_item as { item_id: string }).item_id;

    command.stdout.length = 0;
    await handleProbeCommand(
      ["next", "--session", sessionId, "--json"],
      command.deps,
    );
    const firstRead = json(command.stdout);
    command.stdout.length = 0;
    await handleProbeCommand(
      ["next", "--session", sessionId, "--json"],
      command.deps,
    );
    expect(json(command.stdout).result).toEqual(firstRead.result);

    command.stdout.length = 0;
    expect(
      await handleProbeCommand(
        [
          "next",
          "--session",
          sessionId,
          "--question",
          itemId,
          "--if-revision",
          "0",
          "--answer",
          "working",
          "--actor-kind",
          "human",
          "--actor-id",
          "owner",
          "--idempotency-key",
          "stale-answer",
          "--json",
        ],
        command.deps,
      ),
    ).toBe(3);
    expect(json(command.stdout)).toMatchObject({
      status: "error",
      error: { code: "conflict", retryable: true },
    });
  });

  it("requires document destinations for non-calibration answers", async () => {
    const command = await harness();
    await handleProbeCommand(
      startArgs([
        "--domain-familiarity",
        "expert",
        "--repo-familiarity",
        "maintainer",
        "--intent-maturity",
        "review_ready",
      ]),
      command.deps,
    );
    const started = json(command.stdout);
    const session = started.result?.session as {
      session_id: string;
      revision: number;
    };
    const item = started.result?.current_item as { item_id: string };

    command.stdout.length = 0;
    expect(
      await handleProbeCommand(
        [
          "next",
          "--session",
          session.session_id,
          "--question",
          item.item_id,
          "--if-revision",
          "1",
          "--answer",
          "Use additive SQLite migrations.",
          "--actor-kind",
          "human",
          "--actor-id",
          "owner",
          "--idempotency-key",
          "answer-no-destination",
          "--json",
        ],
        command.deps,
      ),
    ).toBe(2);
    expect(json(command.stdout)).toMatchObject({
      status: "error",
      error: { code: "bad_request" },
    });

    command.stdout.length = 0;
    expect(
      await handleProbeCommand(
        [
          "next",
          "--session",
          session.session_id,
          "--question",
          item.item_id,
          "--if-revision",
          "1",
          "--answer",
          "Use additive SQLite migrations.",
          "--destination-role",
          "technical_design",
          "--destination-path",
          "docs/technical-design.md",
          "--actor-kind",
          "human",
          "--actor-id",
          "owner",
          "--idempotency-key",
          "answer-with-destination",
          "--json",
        ],
        command.deps,
      ),
    ).toBe(0);
    expect(json(command.stdout).result).toMatchObject({
      session: { revision: 2 },
    });
  });

  it("pauses and resumes the same presented question", async () => {
    const command = await harness();
    await handleProbeCommand(startArgs(), command.deps);
    const started = json(command.stdout);
    const sessionId = (started.result?.session as { session_id: string })
      .session_id;
    const itemId = (started.result?.current_item as { item_id: string }).item_id;

    command.stdout.length = 0;
    expect(
      await handleProbeCommand(
        [
          "next",
          "--session",
          sessionId,
          "--if-revision",
          "1",
          "--pause",
          "--reason",
          "Owner requested a break.",
          "--actor-kind",
          "human",
          "--actor-id",
          "owner",
          "--idempotency-key",
          "pause-001",
          "--json",
        ],
        command.deps,
      ),
    ).toBe(0);
    expect(json(command.stdout).result).toMatchObject({
      session: { state: "paused", revision: 2 },
      current_item: { item_id: itemId },
    });

    command.stdout.length = 0;
    expect(
      await handleProbeCommand(
        [
          "resume",
          "--session",
          sessionId,
          "--if-revision",
          "2",
          "--actor-kind",
          "human",
          "--actor-id",
          "owner",
          "--idempotency-key",
          "resume-001",
          "--json",
        ],
        command.deps,
      ),
    ).toBe(0);
    expect(json(command.stdout).result).toMatchObject({
      session: {
        state: "active",
        revision: 3,
        questions_presented: 1,
      },
      current_item: { item_id: itemId },
    });
  });

  it("requires explicit session or repository scope and supports ledger filters", async () => {
    const command = await harness();
    expect(await handleProbeCommand(["next", "--json"], command.deps)).toBe(2);
    expect(json(command.stdout)).toMatchObject({
      status: "error",
      error: { code: "bad_request" },
    });

    command.stdout.length = 0;
    expect(await handleProbeCommand(["status", "--json"], command.deps)).toBe(
      2,
    );

    command.stdout.length = 0;
    await handleProbeCommand(startArgs(), command.deps);
    const started = json(command.stdout);
    const sessionId = (started.result?.session as { session_id: string })
      .session_id;
    command.stdout.length = 0;
    expect(
      await handleProbeCommand(
        [
          "ledger",
          "--session",
          sessionId,
          "--state",
          "open",
          "--quadrant",
          "ku",
          "--severity",
          "low",
          "--json",
        ],
        command.deps,
      ),
    ).toBe(0);
    const ledgerResult = json(command.stdout).result as {
      command: string;
      items: Array<{ question_id: string; state: string }>;
    };
    expect(ledgerResult).toMatchObject({
      command: "probe.ledger",
    });
    expect(ledgerResult.items).toHaveLength(3);
    expect(ledgerResult.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          question_id: "cal.domain_familiarity.v1",
          state: "open",
        }),
      ]),
    );
  });

  it("gates a live session and the same portable ledger identically from a fresh home", async () => {
    const command = await harness();
    command.deps.now_ms = () => 1_000;
    await handleProbeCommand(
      startArgs([
        "--domain-familiarity",
        "expert",
        "--repo-familiarity",
        "maintainer",
        "--intent-maturity",
        "review_ready",
      ]),
      command.deps,
    );
    const started = json(command.stdout);
    const session = started.result?.session as {
      session_id: string;
      revision: number;
    };

    command.stdout.length = 0;
    expect(
      await handleProbeCommand(
        ["gate", "--session", session.session_id, "--json"],
        command.deps,
      ),
    ).toBe(0);
    const live = json(command.stdout);
    expect(live).toMatchObject({
      status: "ok",
      result: {
        command: "probe.gate",
        source: { kind: "session", ref: session.session_id },
        policy_source: "built_in",
        enforcement: "report",
        eligible: false,
      },
    });

    command.stdout.length = 0;
    expect(
      await handleProbeCommand(
        [
          "render",
          "--session",
          session.session_id,
          "--if-revision",
          String(session.revision),
          "--target",
          "ledger",
          "--actor-kind",
          "agent",
          "--actor-id",
          "codex",
          "--idempotency-key",
          "render-for-gate",
          "--json",
        ],
        command.deps,
      ),
    ).toBe(0);
    json(command.stdout);

    const freshHome = join(command.home, "fresh");
    await mkdir(freshHome, { recursive: true });
    command.stdout.length = 0;
    expect(
      await handleProbeCommand(
        [
          "gate",
          "--ledger",
          `docs/probe/sessions/${session.session_id}/ledger.json`,
          "--json",
        ],
        {
          ...command.deps,
          state_db_path: async () => join(freshHome, "state.db"),
        },
      ),
    ).toBe(0);
    const portable = json(command.stdout);
    expect(portable).toMatchObject({
      status: "ok",
      result: {
        source: {
          kind: "ledger",
          ref: `docs/probe/sessions/${session.session_id}/ledger.json`,
        },
      },
    });
    expect(portable.result?.readiness).toEqual(live.result?.readiness);
  });

  it("returns a policy_denied blocked envelope and exit 1 in block mode", async () => {
    const command = await harness();
    await handleProbeCommand(
      startArgs([
        "--domain-familiarity",
        "expert",
        "--repo-familiarity",
        "maintainer",
        "--intent-maturity",
        "review_ready",
      ]),
      command.deps,
    );
    const sessionId = (
      json(command.stdout).result?.session as { session_id: string }
    ).session_id;
    await mkdir(join(command.repo, ".osstack"), { recursive: true });
    await writeFile(
      join(command.repo, ".osstack", "probe.yaml"),
      "schema_version: 1\nenforcement: block\n",
      "utf8",
    );

    command.stdout.length = 0;
    expect(
      await handleProbeCommand(
        ["gate", "--session", sessionId, "--json"],
        command.deps,
      ),
    ).toBe(1);
    expect(json(command.stdout)).toMatchObject({
      status: "blocked",
      result: { command: "probe.gate", eligible: false },
      error: { code: "policy_denied", retryable: false },
    });
  });

  it("fails closed on an invalid gate config and portable artifact tampering", async () => {
    const command = await harness();
    await mkdir(join(command.repo, ".osstack"), { recursive: true });
    await writeFile(
      join(command.repo, ".osstack", "probe.yaml"),
      "schema_version: 2\nenforcement: silent\n",
      "utf8",
    );
    expect(await handleProbeCommand(startArgs(), command.deps)).toBe(2);
    expect(json(command.stdout)).toMatchObject({
      status: "error",
      error: { code: "bad_request" },
    });

    await rm(join(command.repo, ".osstack", "probe.yaml"));
    command.stdout.length = 0;
    await handleProbeCommand(
      startArgs([
        "--domain-familiarity",
        "expert",
        "--repo-familiarity",
        "maintainer",
        "--intent-maturity",
        "review_ready",
      ]),
      command.deps,
    );
    const session = json(command.stdout).result?.session as {
      session_id: string;
      revision: number;
    };
    command.stdout.length = 0;
    await handleProbeCommand(
      [
        "render",
        "--session",
        session.session_id,
        "--if-revision",
        String(session.revision),
        "--target",
        "ledger",
        "--actor-kind",
        "agent",
        "--actor-id",
        "codex",
        "--idempotency-key",
        "render-tamper",
        "--json",
      ],
      command.deps,
    );
    await writeFile(
      join(
        command.repo,
        "docs",
        "probe",
        "sessions",
        session.session_id,
        "ledger.json",
      ),
      "{}\n",
      "utf8",
    );

    command.stdout.length = 0;
    expect(
      await handleProbeCommand(
        [
          "gate",
          "--ledger",
          `docs/probe/sessions/${session.session_id}/ledger.json`,
          "--json",
        ],
        command.deps,
      ),
    ).toBe(2);
    expect(json(command.stdout)).toMatchObject({
      status: "error",
      error: { code: "bad_request" },
    });
  });

  it("uses repository gate budgets when selecting start questions", async () => {
    const command = await harness();
    await mkdir(join(command.repo, ".osstack"), { recursive: true });
    await writeFile(
      join(command.repo, ".osstack", "probe.yaml"),
      [
        "schema_version: 1",
        "budgets:",
        "  quick: 3",
        "  standard: 12",
        "  deep: 30",
        "",
      ].join("\n"),
      "utf8",
    );

    expect(
      await handleProbeCommand(startArgs(["--depth", "quick"]), command.deps),
    ).toBe(0);
    expect(json(command.stdout)).toMatchObject({
      result: { session: { depth: "quick", question_budget: 3 } },
    });
  });

  it("adds an evidence-bound dynamic batch atomically and idempotently", async () => {
    const command = await harness();
    const evidenceContent = "export const migrationVersion = 11;\n";
    await writeFile(
      join(command.repo, "evidence.ts"),
      evidenceContent,
      "utf8",
    );
    const questionId = `dynamic.${"b".repeat(64)}.v1`;
    const batch = {
      schema_version: "1",
      batch_id: "pqb_12345678",
      origin: "blindspot",
      generated_by: { type: "agent", id: "probe-skill" },
      source_revision: "a".repeat(40),
      questions: [
        {
          schema_version: "1",
          question_id: questionId,
          item_kind: "risk",
          initial_quadrant: "uu",
          current_quadrant: "ku",
          doc_type: "tech",
          category: "migration",
          origin: "blindspot",
          prompt: "How must the existing state be migrated?",
          options: [],
          impact: 3,
          irreversibility: 3,
          uncertainty: 3,
          required: true,
          evidence_refs: [
            {
              kind: "file",
              ref: "evidence.ts",
              sha256: probeSha256(evidenceContent),
            },
          ],
          destination_hint: "technical_design",
        },
      ],
    };
    await writeFile(
      join(command.repo, "questions.json"),
      JSON.stringify(batch),
      "utf8",
    );
    await handleProbeCommand(
      startArgs([
        "--domain-familiarity",
        "expert",
        "--repo-familiarity",
        "maintainer",
        "--intent-maturity",
        "review_ready",
      ]),
      command.deps,
    );
    const started = json(command.stdout);
    const session = started.result?.session as {
      session_id: string;
      revision: number;
      current_question_id: string;
    };
    const currentItemId = (
      started.result?.current_item as { item_id: string }
    ).item_id;

    const addArgs = [
      "add",
      "--session",
      session.session_id,
      "--if-revision",
      "1",
      "--from",
      "questions.json",
      "--actor-kind",
      "agent",
      "--actor-id",
      "probe-skill",
      "--idempotency-key",
      "add-dynamic-1",
      "--json",
    ];
    command.stdout.length = 0;
    expect(await handleProbeCommand(addArgs, command.deps)).toBe(0);
    const added = json(command.stdout);
    expect(added).toMatchObject({
      status: "ok",
      result: {
        command: "probe.add",
        session: {
          revision: 2,
          current_question_id: currentItemId,
          questions_presented: 1,
          selected_question_ids: expect.arrayContaining([questionId]),
        },
      },
    });

    command.stdout.length = 0;
    expect(await handleProbeCommand(addArgs, command.deps)).toBe(0);
    expect(json(command.stdout).result).toEqual(added.result);

    command.stdout.length = 0;
    expect(
      await handleProbeCommand(
        addArgs.map((value) =>
          value === "add-dynamic-1" ? "add-dynamic-2" : value,
        ).map((value, index, values) =>
          values[index - 1] === "--if-revision" ? "2" : value,
        ),
        command.deps,
      ),
    ).toBe(2);
    expect(json(command.stdout)).toMatchObject({
      status: "error",
      error: { code: "bad_request" },
    });
  });

  it("registers standalone and attached skill restatements without inventing findings", async () => {
    const command = await harness();
    const specContent = await readFile(join(command.repo, "spec.md"), "utf8");
    const restatementContent = "# Restatement\nImplement probe safely.\n";
    await writeFile(
      join(command.repo, "restatement.md"),
      restatementContent,
      "utf8",
    );
    const findings = [
      {
        schema_version: "1",
        finding_id: "prf_12345678",
        kind: "ambiguous",
        spec_evidence: {
          sha256: probeSha256(specContent),
          path: "spec.md",
          line: 1,
          anchor: "Probe feature",
        },
        restatement_evidence: {
          sha256: probeSha256(restatementContent),
          path: "restatement.md",
          line: 2,
          anchor: "safely",
        },
        explanation: "The skill found a guarantee requiring owner confirmation.",
        proposed_question: "Which safety guarantee must the implementation preserve?",
        impact: 3,
        irreversibility: 3,
        uncertainty: 2,
        destination_hint: "technical_design",
      },
    ];
    await writeFile(
      join(command.repo, "findings.json"),
      JSON.stringify(findings),
      "utf8",
    );
    const standaloneArgs = [
      "restate",
      "--spec",
      "spec.md",
      "--restatement",
      "restatement.md",
      "--findings",
      "findings.json",
      "--actor-kind",
      "agent",
      "--actor-id",
      "probe-skill",
      "--idempotency-key",
      "restate-standalone",
      "--json",
    ];
    expect(await handleProbeCommand(standaloneArgs, command.deps)).toBe(0);
    const standalone = json(command.stdout);
    expect(standalone).toMatchObject({
      status: "ok",
      result: {
        command: "probe.restate",
        session: {
          state: "active",
          revision: 1,
          question_pack_refs: [],
          selected_question_ids: [expect.stringMatching(/^dynamic\./)],
        },
        current_item: {
          origin: "restatement_diff",
          prompt: findings[0]?.proposed_question,
        },
      },
    });
    expect(JSON.stringify(standalone)).not.toContain("is wrong");

    command.stdout.length = 0;
    await handleProbeCommand(
      startArgs([
        "--domain-familiarity",
        "expert",
        "--repo-familiarity",
        "maintainer",
        "--intent-maturity",
        "review_ready",
      ]),
      command.deps,
    );
    const target = json(command.stdout).result?.session as {
      session_id: string;
    };
    command.stdout.length = 0;
    expect(
      await handleProbeCommand(
        [
          ...standaloneArgs.slice(0, -1),
          "--session",
          target.session_id,
          "--if-revision",
          "1",
          "--json",
        ].map((value) =>
          value === "restate-standalone" ? "restate-attached" : value,
        ),
        command.deps,
      ),
    ).toBe(0);
    expect(json(command.stdout)).toMatchObject({
      status: "ok",
      result: {
        command: "probe.restate",
        session: { session_id: target.session_id, revision: 2 },
      },
    });

    command.stdout.length = 0;
    expect(
      await handleProbeCommand(
        ["ledger", "--session", target.session_id, "--json"],
        command.deps,
      ),
    ).toBe(0);
    expect(json(command.stdout).result).toMatchObject({
      events: [
        expect.anything(),
        {
          type: "items_added",
          payload: {
            origin: "restatement_diff",
            restatement_findings: findings,
          },
        },
      ],
    });

    command.stdout.length = 0;
    expect(
      await handleProbeCommand(
        standaloneArgs.filter((value, index, values) =>
          value !== "findings.json" && values[index - 1] !== "--findings",
        ),
        command.deps,
      ),
    ).toBe(2);
    expect(json(command.stdout)).toMatchObject({
      status: "error",
      error: { code: "bad_request" },
    });
  });

  it("compiles a registered package script into a loop-compatible delta only", async () => {
    const command = await harness();
    await mkdir(join(command.repo, "packages", "app"), { recursive: true });
    await writeFile(
      join(command.repo, "packages", "app", "package.json"),
      JSON.stringify({ scripts: { test: "vitest run" } }),
      "utf8",
    );
    await handleProbeCommand(
      startArgs([
        "--doc-type",
        "test",
        "--domain-familiarity",
        "expert",
        "--repo-familiarity",
        "maintainer",
        "--intent-maturity",
        "review_ready",
      ]),
      command.deps,
    );
    const started = json(command.stdout);
    const session = started.result?.session as {
      session_id: string;
    };
    const item = started.result?.current_item as {
      item_id: string;
      category: string;
    };
    expect(item.category).toBe("acceptance");

    command.stdout.length = 0;
    expect(
      await handleProbeCommand(
        [
          "next",
          "--session",
          session.session_id,
          "--question",
          item.item_id,
          "--if-revision",
          "1",
          "--answer",
          "Run the app package test script.",
          "--destination-role",
          "evaluation_spec",
          "--destination-path",
          "docs/probe/evaluations.md",
          "--actor-kind",
          "human",
          "--actor-id",
          "owner",
          "--idempotency-key",
          "answer-for-compile",
          "--json",
        ],
        command.deps,
      ),
    ).toBe(0);
    json(command.stdout);

    const requests = {
      schema_version: "1",
      requests: [
        {
          item_id: item.item_id,
          template_id: "package-script.v1",
          params: {
            description: "App package tests pass.",
            package_path: "packages/app",
            script: "test",
          },
        },
      ],
    };
    await writeFile(
      join(command.repo, "compile-requests.json"),
      JSON.stringify(requests),
      "utf8",
    );
    const compileArgs = [
      "compile",
      "--session",
      session.session_id,
      "--if-revision",
      "2",
      "--from",
      "compile-requests.json",
      "--actor-kind",
      "agent",
      "--actor-id",
      "probe-compiler",
      "--idempotency-key",
      "compile-1",
      "--json",
    ];
    command.stdout.length = 0;
    expect(await handleProbeCommand(compileArgs, command.deps)).toBe(0);
    const compiled = json(command.stdout);
    expect(compiled).toMatchObject({
      status: "ok",
      result: {
        command: "probe.compile",
        session: { revision: 3 },
        evaluation_delta: {
          exported_revision: 2,
          evaluations: [
            {
              mode: "command",
              command: "pnpm --dir 'packages/app' run test",
            },
          ],
        },
        artifact: {
          path: `docs/probe/evaluations/${session.session_id}-r2.json`,
        },
      },
    });
    const evaluation = (
      compiled.result?.evaluation_delta as {
        evaluations: unknown[];
      }
    ).evaluations[0];
    expect(EvaluationSpec.safeParse(evaluation).success).toBe(true);
    await expect(
      readFile(join(command.repo, "tasks", "queue.json"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });

    command.stdout.length = 0;
    expect(await handleProbeCommand(compileArgs, command.deps)).toBe(0);
    expect(json(command.stdout).result).toEqual(compiled.result);

    const artifactPath = join(
      command.repo,
      "docs",
      "probe",
      "evaluations",
      `${session.session_id}-r2.json`,
    );
    await writeFile(
      artifactPath,
      `${await readFile(artifactPath, "utf8")} `,
      "utf8",
    );
    command.stdout.length = 0;
    expect(await handleProbeCommand(compileArgs, command.deps)).toBe(3);
    expect(json(command.stdout)).toMatchObject({
      status: "error",
      error: { code: "conflict" },
    });
  });
});
