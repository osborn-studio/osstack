import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createProbeSession,
  getProbeSession,
  listProbeEvents,
  listProbeItems,
  openDb,
} from "@osstack/core";
import {
  deriveProbeReadiness,
  deriveProbeSeverity,
  getCurrentProbeItem,
  materializeProbeQuestions,
  ProbeEventV1,
  ProbeItemV1,
  ProbeSessionV1,
  selectProbeQuestions,
} from "@osstack/governance";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let temporaryDirectory: string;

beforeEach(() => {
  temporaryDirectory = mkdtempSync(join(tmpdir(), "osstack-probe-conformance-"));
});

afterEach(() => {
  rmSync(temporaryDirectory, { recursive: true, force: true });
});

describe("probe R0 public-kernel conformance", () => {
  it("creates and restores a strict session without importing the CLI product", () => {
    const selection = selectProbeQuestions({
      doc_types: ["tech"],
      depth: "quick",
      familiarity: {
        domain: "expert",
        repository: "maintainer",
        intent: "review_ready",
      },
    });
    let itemSequence = 0;
    const items = materializeProbeQuestions({
      session_id: "probe_conform1",
      questions: selection.selected_questions,
      created_at_ms: 10,
      create_item_id: () => `pi_conform${++itemSequence}`,
    });
    const first = items[0];
    if (first === undefined) throw new Error("probe pack selected no questions");
    const session = ProbeSessionV1.parse({
      schema_version: "1",
      session_id: "probe_conform1",
      repo_id: "conformance",
      worktree_state: "not_git",
      input_refs: [],
      doc_types: ["tech"],
      question_pack_refs: selection.question_pack_refs,
      selected_question_ids: selection.selected_questions.map(
        (question) => question.question_id,
      ),
      unselected_required_question_ids:
        selection.unselected_required_question_ids,
      depth: "quick",
      question_budget: selection.question_budget,
      questions_presented: 1,
      familiarity: {
        domain: "expert",
        repository: "maintainer",
        intent: "review_ready",
      },
      revision: 1,
      created_at_ms: 10,
      updated_at_ms: 10,
      state: "active",
      current_question_id: first.item_id,
    });
    const event = ProbeEventV1.parse({
      schema_version: "1",
      event_id: "pe_conform1",
      session_id: session.session_id,
      revision: 1,
      type: "session_started",
      actor: { type: "human", id: "conformance-owner" },
      idempotency_key: "conformance-start",
      occurred_at_ms: 10,
      payload: {},
    });
    const databasePath = join(temporaryDirectory, "state.db");
    const db = openDb({ path: databasePath, minFreeBytes: 0 });
    createProbeSession(db, {
      session: {
        session_id: session.session_id,
        repo_id: session.repo_id,
        state: session.state,
        revision: session.revision,
        snapshot_json: JSON.stringify(session),
        created_at_ms: session.created_at_ms,
        updated_at_ms: session.updated_at_ms,
      },
      items: items.map((item) => ({
        item_id: item.item_id,
        question_id: item.question_id,
        state: item.state,
        current_quadrant: item.current_quadrant,
        severity: deriveProbeSeverity(item),
        updated_at_ms: item.updated_at_ms,
        item_json: JSON.stringify(item),
      })),
      event: {
        event_id: event.event_id,
        revision: event.revision,
        type: event.type,
        idempotency_key: event.idempotency_key,
        event_json: JSON.stringify(event),
        occurred_at_ms: event.occurred_at_ms,
      },
      receipt: {
        scope_key: "repo:conformance",
        idempotency_key: "conformance-start",
        request_sha256: "a".repeat(64),
        result_json: JSON.stringify({ session_id: session.session_id }),
        created_at_ms: 10,
      },
    });
    db.close();

    const reopened = openDb({ path: databasePath, minFreeBytes: 0 });
    try {
      const restoredSession = ProbeSessionV1.parse(
        JSON.parse(getProbeSession(reopened, session.session_id)?.snapshot_json ?? ""),
      );
      const restoredItems = listProbeItems(reopened, session.session_id).map(
        (row) => ProbeItemV1.parse(JSON.parse(row.item_json)),
      );
      expect(getCurrentProbeItem({
        session: restoredSession,
        items: restoredItems,
      })?.item_id).toBe(first.item_id);
      expect(listProbeEvents(reopened, session.session_id)).toHaveLength(1);
      expect(
        deriveProbeReadiness(
          { session: restoredSession, items: restoredItems },
          11,
        ).eligible,
      ).toBe(false);
    } finally {
      reopened.close();
    }
  });
});
