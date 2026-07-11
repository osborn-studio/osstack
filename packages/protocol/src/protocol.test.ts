// Protocol contract tests: fixture parsing, invalid rejection, backward-compat
// corpus, consumer-lenient parsing, and the A-003 status<->code mapping.

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import {
  AgentCommand,
  AgentCommandResult,
  ApprovalDecision,
  ApprovalRequest,
  EventEnvelope,
  EvidenceRef,
  parseInboundAgentCommand,
  parseInboundAgentCommandResult,
  PolicyDecision,
  RunSummary,
  Task,
} from "./index.js";

const VALID_DIR = fileURLToPath(new URL("../fixtures/valid", import.meta.url));
const INVALID_DIR = fileURLToPath(new URL("../fixtures/invalid", import.meta.url));

/** Maps a fixture's schema key to the strict schema that must validate it. */
const SCHEMA_BY_KEY: Record<string, z.ZodTypeAny> = {
  task: Task,
  "run-summary": RunSummary,
  "event-envelope": EventEnvelope,
  "evidence-ref": EvidenceRef,
  "approval-request": ApprovalRequest,
  "approval-decision": ApprovalDecision,
  "policy-decision": PolicyDecision,
  "agent-command": AgentCommand,
  "agent-command-result": AgentCommandResult,
};

/** Fixture filename -> schema key: strip the .(valid|invalid).json suffix, then
 *  drop any `__variant` discriminator (e.g. agent-command-result__blocked). */
function schemaKeyOf(filename: string): string {
  const base = filename.replace(/\.(valid|invalid)\.json$/, "");
  return base.split("__")[0] as string;
}

function readJson(dir: string, filename: string): unknown {
  return JSON.parse(readFileSync(`${dir}/${filename}`, "utf-8"));
}

function schemaFor(filename: string): z.ZodTypeAny {
  const key = schemaKeyOf(filename);
  const schema = SCHEMA_BY_KEY[key];
  if (!schema) throw new Error(`no schema registered for key '${key}' (fixture ${filename})`);
  return schema;
}

const validFiles = readdirSync(VALID_DIR).filter((f) => f.endsWith(".valid.json")).sort();
const invalidFiles = readdirSync(INVALID_DIR).filter((f) => f.endsWith(".invalid.json")).sort();

// ── Backward-compatibility corpus (A-007) ─────────────────────────────────
// APPEND-ONLY. Every fixture published for protocol major 1 MUST parse against
// all later minors, forever. Never delete or mutate an entry; a breaking change
// is a new MAJOR with a new fixture directory. Adding a row is allowed.
const FROZEN_V1_FIXTURES = [
  "agent-command-result.valid.json",
  "agent-command-result__blocked.valid.json",
  "agent-command-result__error.valid.json",
  "agent-command-result__needs-approval.valid.json",
  "agent-command.valid.json",
  "approval-decision.valid.json",
  "approval-request.valid.json",
  "event-envelope.valid.json",
  "evidence-ref.valid.json",
  "policy-decision.valid.json",
  "run-summary.valid.json",
  "task.valid.json",
] as const;

describe("valid fixtures parse with their schema", () => {
  it("covers at least one fixture per protocol type", () => {
    const keys = new Set(validFiles.map(schemaKeyOf));
    for (const key of Object.keys(SCHEMA_BY_KEY)) {
      expect(keys, `missing a valid fixture for '${key}'`).toContain(key);
    }
  });

  for (const filename of validFiles) {
    it(`parses ${filename}`, () => {
      const result = schemaFor(filename).safeParse(readJson(VALID_DIR, filename));
      if (!result.success) {
        throw new Error(`${filename} should parse but failed:\n${result.error.toString()}`);
      }
      expect(result.success).toBe(true);
    });
  }
});

describe("invalid fixtures are rejected and document why", () => {
  it("covers at least one invalid fixture per protocol type", () => {
    const keys = new Set(invalidFiles.map(schemaKeyOf));
    for (const key of Object.keys(SCHEMA_BY_KEY)) {
      expect(keys, `missing an invalid fixture for '${key}'`).toContain(key);
    }
  });

  for (const filename of invalidFiles) {
    it(`rejects ${filename}`, () => {
      const fixture = readJson(INVALID_DIR, filename) as { $reason?: unknown; value?: unknown };
      expect(typeof fixture.$reason, `${filename} must document a $reason`).toBe("string");
      expect((fixture.$reason as string).length).toBeGreaterThan(0);
      expect("value" in fixture, `${filename} must carry a value`).toBe(true);
      const result = schemaFor(filename).safeParse(fixture.value);
      expect(result.success, `${filename} should be rejected but parsed`).toBe(false);
    });
  }
});

describe("backward-compatibility corpus (A-007, append-only)", () => {
  it("the on-disk valid corpus exactly matches FROZEN_V1_FIXTURES", () => {
    // Two-way equality: nothing added without registering, nothing frozen removed.
    expect(validFiles).toEqual([...FROZEN_V1_FIXTURES].sort());
  });

  it("every frozen fixture still parses under the current schemas", () => {
    for (const filename of FROZEN_V1_FIXTURES) {
      const result = schemaFor(filename).safeParse(readJson(VALID_DIR, filename));
      expect(result.success, `${filename} broke backward compatibility`).toBe(true);
    }
  });
});

describe("consumer-lenient vs producer-strict (A-007)", () => {
  it("an unknown extra field fails the strict schema but passes the lenient parser", () => {
    const fixture = readJson(INVALID_DIR, "agent-command__unknown-field.invalid.json") as {
      value: Record<string, unknown>;
    };
    // Producer-strict rejects the unknown field.
    expect(AgentCommand.safeParse(fixture.value).success).toBe(false);
    // Consumer-lenient accepts it and preserves the passthrough field.
    const parsed = parseInboundAgentCommand(fixture.value);
    expect(parsed.command).toBe("portfolio.daily");
    expect((parsed as Record<string, unknown>).debug).toBe(true);
  });

  it("the lenient result parser tolerates unknown fields but still enforces A-003", () => {
    const okWithExtra = {
      protocol_version: "1.0",
      status: "ok",
      result: {},
      trace_id: "abc",
    };
    expect(AgentCommandResult.safeParse(okWithExtra).success).toBe(false); // strict rejects extra
    expect(() => parseInboundAgentCommandResult(okWithExtra)).not.toThrow(); // lenient accepts

    // Business rule still enforced by the lenient parser.
    expect(() =>
      parseInboundAgentCommandResult({ protocol_version: "1.0", status: "error", trace_id: "x" }),
    ).toThrow();
  });
});

describe("A-003 / A-006 status<->code mapping", () => {
  it("accepts status ok without an error object", () => {
    expect(
      AgentCommandResult.safeParse({ protocol_version: "1.0", status: "ok", result: {} }).success,
    ).toBe(true);
  });

  it("rejects status error without an error object", () => {
    expect(
      AgentCommandResult.safeParse({ protocol_version: "1.0", status: "error" }).success,
    ).toBe(false);
  });

  it("rejects status blocked with an internal (non-blocked) error code", () => {
    expect(
      AgentCommandResult.safeParse({
        protocol_version: "1.0",
        status: "blocked",
        error: { code: "internal", message: "boom", retryable: true },
      }).success,
    ).toBe(false);
  });

  it("accepts status blocked with policy_denied and budget_exceeded", () => {
    for (const code of ["policy_denied", "budget_exceeded"]) {
      expect(
        AgentCommandResult.safeParse({
          protocol_version: "1.0",
          status: "blocked",
          error: { code, message: "denied", retryable: false },
        }).success,
        `blocked+${code} should be accepted`,
      ).toBe(true);
    }
  });

  it("rejects status error carrying a blocked-only code (A-006)", () => {
    expect(
      AgentCommandResult.safeParse({
        protocol_version: "1.0",
        status: "error",
        error: { code: "policy_denied", message: "denied", retryable: false },
      }).success,
    ).toBe(false);
  });

  it("rejects status needs_approval with an empty required_approvals", () => {
    expect(
      AgentCommandResult.safeParse({
        protocol_version: "1.0",
        status: "needs_approval",
        required_approvals: [],
      }).success,
    ).toBe(false);
  });
});
