import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import {
  createKnowledgeHygieneTransactionPlanV1,
  type CreateKnowledgeHygieneTransactionPlanInputV1,
  type KnowledgeHygieneByteSpanV1,
  type KnowledgeHygieneInsertionPointV1,
  type KnowledgeHygienePlanActionV1,
  type KnowledgeHygieneTransactionPlanV1,
  type KnowledgeHygieneWriteSetEntryV1,
} from "./transaction-plan.js";

export interface KnowledgeHygieneFileSnapshotV1 {
  root_id: "repo" | "memory";
  path: string;
  content_utf8: string | null;
  mode: number;
}

export interface KnowledgeHygieneLineSelectionV1 {
  root_id: "repo" | "memory";
  path: string;
  start_line: number;
  end_line: number;
}

export interface KnowledgeHygieneTargetSelectionV1 {
  root_id: "repo" | "memory";
  path: string;
  placement: "before" | "after" | "replace";
}

export type KnowledgeHygieneActionDraftV1 =
  | {
      kind: "move";
      source: KnowledgeHygieneLineSelectionV1;
      target: KnowledgeHygieneTargetSelectionV1;
    }
  | {
      kind: "compress";
      sources: KnowledgeHygieneLineSelectionV1[];
      target: KnowledgeHygieneTargetSelectionV1;
      replacement_utf8: string;
    }
  | {
      kind: "delete";
      sources: KnowledgeHygieneLineSelectionV1[];
      reasons: string[];
    };

export interface BuildKnowledgeHygieneTransactionPlanInputV1 extends Omit<
  CreateKnowledgeHygieneTransactionPlanInputV1,
  "actions" | "write_set"
> {
  snapshots: KnowledgeHygieneFileSnapshotV1[];
  drafts: KnowledgeHygieneActionDraftV1[];
}

interface Mutation {
  start: number;
  end: number;
  replacement: Buffer;
}

interface BoundaryInsertion {
  placement: "before" | "after" | "replace";
  bytes: Buffer;
}

function digest(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function fileKey(rootId: "repo" | "memory", path: string): string {
  return `${rootId}:${path}`;
}

function lineOffsets(content: string): Array<{ start: number; end: number }> {
  const offsets: Array<{ start: number; end: number }> = [];
  let byte = 0;
  for (const match of content.matchAll(/.*(?:\r\n|\n|\r|$)/gu)) {
    const value = match[0];
    if (value === "") continue;
    const bytes = Buffer.byteLength(value, "utf8");
    offsets.push({ start: byte, end: byte + bytes });
    byte += bytes;
  }
  return offsets;
}

function span(
  selection: KnowledgeHygieneLineSelectionV1,
  snapshots: ReadonlyMap<string, KnowledgeHygieneFileSnapshotV1>,
): KnowledgeHygieneByteSpanV1 {
  const snapshot = snapshots.get(fileKey(selection.root_id, selection.path));
  if (snapshot?.content_utf8 === null || snapshot === undefined) {
    throw new Error(`source snapshot is absent: ${selection.root_id}:${selection.path}`);
  }
  if (
    !Number.isInteger(selection.start_line)
    || !Number.isInteger(selection.end_line)
    || selection.start_line < 1
    || selection.end_line < selection.start_line
  ) {
    throw new Error("line selection is invalid");
  }
  const offsets = lineOffsets(snapshot.content_utf8);
  const first = offsets[selection.start_line - 1];
  const last = offsets[selection.end_line - 1];
  if (first === undefined || last === undefined) {
    throw new Error(
      `line selection exceeds ${selection.root_id}:${selection.path}`,
    );
  }
  const content = Buffer.from(snapshot.content_utf8, "utf8");
  const selected = content.subarray(first.start, last.end);
  if (selected.length === 0) throw new Error("source selection is empty");
  return {
    root_id: selection.root_id,
    path: selection.path,
    blob_sha256: digest(content),
    start_byte: first.start,
    end_byte: last.end,
    bytes_sha256: digest(selected),
    start_line: selection.start_line,
    end_line: selection.end_line,
  };
}

function target(
  selection: KnowledgeHygieneTargetSelectionV1,
  snapshots: ReadonlyMap<string, KnowledgeHygieneFileSnapshotV1>,
): KnowledgeHygieneInsertionPointV1 {
  const snapshot = snapshots.get(fileKey(selection.root_id, selection.path));
  if (snapshot === undefined) {
    throw new Error(`target snapshot was not declared: ${selection.root_id}:${selection.path}`);
  }
  return {
    root_id: selection.root_id,
    path: selection.path,
    preimage_sha256: snapshot.content_utf8 === null
      ? null
      : digest(snapshot.content_utf8),
    placement: selection.placement,
  };
}

function selectedBytes(
  source: KnowledgeHygieneByteSpanV1,
  snapshots: ReadonlyMap<string, KnowledgeHygieneFileSnapshotV1>,
): Buffer {
  const content = snapshots.get(fileKey(source.root_id, source.path))?.content_utf8;
  if (content === undefined || content === null) {
    throw new Error(`source snapshot unavailable: ${source.root_id}:${source.path}`);
  }
  return Buffer.from(content, "utf8").subarray(source.start_byte, source.end_byte);
}

function actionId(body: unknown): string {
  return `khta_${digest(JSON.stringify(body))}`;
}

function addMutation(
  mutations: Map<string, Mutation[]>,
  source: KnowledgeHygieneByteSpanV1,
  replacement = Buffer.alloc(0),
): void {
  const key = fileKey(source.root_id, source.path);
  const entries = mutations.get(key) ?? [];
  entries.push({ start: source.start_byte, end: source.end_byte, replacement });
  mutations.set(key, entries);
}

function addInsertion(
  insertions: Map<string, BoundaryInsertion[]>,
  selection: KnowledgeHygieneTargetSelectionV1,
  bytes: Buffer,
): void {
  const key = fileKey(selection.root_id, selection.path);
  const entries = insertions.get(key) ?? [];
  entries.push({ placement: selection.placement, bytes });
  insertions.set(key, entries);
}

function applyMutations(content: Buffer, mutations: readonly Mutation[]): Buffer {
  const ordered = [...mutations].sort((left, right) => left.start - right.start);
  const chunks: Buffer[] = [];
  let cursor = 0;
  for (const mutation of ordered) {
    if (mutation.start < cursor || mutation.end > content.length) {
      throw new Error("source byte spans overlap or exceed their preimage");
    }
    chunks.push(content.subarray(cursor, mutation.start), mutation.replacement);
    cursor = mutation.end;
  }
  chunks.push(content.subarray(cursor));
  return Buffer.concat(chunks);
}

function withSeparator(left: Buffer, right: Buffer): Buffer {
  if (left.length === 0 || right.length === 0 || left[left.length - 1] === 0x0a) {
    return Buffer.concat([left, right]);
  }
  return Buffer.concat([left, Buffer.from("\n"), right]);
}

export function buildKnowledgeHygieneTransactionPlanV1(
  input: BuildKnowledgeHygieneTransactionPlanInputV1,
): KnowledgeHygieneTransactionPlanV1 {
  if (input.drafts.length === 0) throw new Error("transaction plan requires a draft action");
  const snapshots = new Map<string, KnowledgeHygieneFileSnapshotV1>();
  for (const snapshot of input.snapshots) {
    const key = fileKey(snapshot.root_id, snapshot.path);
    if (snapshots.has(key)) throw new Error(`duplicate snapshot: ${key}`);
    snapshots.set(key, snapshot);
  }
  const actions: KnowledgeHygienePlanActionV1[] = [];
  const mutations = new Map<string, Mutation[]>();
  const insertions = new Map<string, BoundaryInsertion[]>();

  for (const draft of input.drafts) {
    if (draft.kind === "move") {
      const source = span(draft.source, snapshots);
      const destination = target(draft.target, snapshots);
      if (fileKey(source.root_id, source.path) === fileKey(
        destination.root_id,
        destination.path,
      )) {
        throw new Error("move source and target must be different files");
      }
      const body = { kind: "move" as const, risk: "medium" as const, source, target: destination };
      actions.push({ ...body, action_id: actionId(body) });
      const bytes = selectedBytes(source, snapshots);
      addMutation(mutations, source);
      addInsertion(insertions, draft.target, bytes);
      continue;
    }
    if (draft.kind === "delete") {
      const sources = draft.sources.map((selection) => span(selection, snapshots));
      if (sources.length !== draft.reasons.length) {
        throw new Error("delete requires one discard reason per source");
      }
      const discards = sources.map((source, index) => ({
        source_bytes_sha256: source.bytes_sha256,
        reason: draft.reasons[index] ?? "",
      }));
      const body = { kind: "delete" as const, risk: "high" as const, sources, discards };
      actions.push({ ...body, action_id: actionId(body) });
      sources.forEach((source) => {
        addMutation(mutations, source);
      });
      continue;
    }
    const sources = draft.sources.map((selection) => span(selection, snapshots));
    const destination = target(draft.target, snapshots);
    const replacement = Buffer.from(draft.replacement_utf8, "utf8");
    const targetKey = fileKey(destination.root_id, destination.path);
    const sourceKeys = new Set(sources.map((source) =>
      fileKey(source.root_id, source.path)
    ));
    const inline = draft.target.placement === "replace" && sourceKeys.has(targetKey);
    if (inline && (sourceKeys.size !== 1 || sources.some((source) =>
      fileKey(source.root_id, source.path) !== targetKey
    ))) {
      throw new Error("inline compression requires all sources in the target file");
    }
    if (!inline && draft.target.placement === "replace") {
      const targetContent = snapshots.get(targetKey)?.content_utf8;
      if (targetContent !== null && targetContent !== "") {
        throw new Error("cross-file replacement cannot discard an existing target");
      }
    }
    const claims = sources.map((source, index) => ({
      claim_id: `claim_${digest(JSON.stringify([source.bytes_sha256, index]))}`,
      source,
      disposition: {
        status: "preserved" as const,
        target_bytes_sha256: digest(replacement),
      },
    }));
    const body = {
      kind: "compress" as const,
      risk: "high" as const,
      sources,
      target: destination,
      replacement_utf8: draft.replacement_utf8,
      claims,
    };
    actions.push({ ...body, action_id: actionId(body) });
    if (inline) {
      sources.forEach((source, index) => {
        addMutation(
          mutations,
          source,
          index === 0 ? replacement : Buffer.alloc(0),
        );
      });
    } else {
      sources.forEach((source) => {
        addMutation(mutations, source);
      });
      addInsertion(insertions, draft.target, replacement);
    }
  }

  const affected = new Set([...mutations.keys(), ...insertions.keys()]);
  const writeSet: KnowledgeHygieneWriteSetEntryV1[] = [...affected].sort()
    .map((key) => {
      const snapshot = snapshots.get(key);
      if (snapshot === undefined) throw new Error(`missing write-set snapshot: ${key}`);
      let content = Buffer.from(snapshot.content_utf8 ?? "", "utf8");
      content = Buffer.from(applyMutations(content, mutations.get(key) ?? []));
      for (const insertion of insertions.get(key) ?? []) {
        if (insertion.placement === "before") {
          content = Buffer.from(withSeparator(insertion.bytes, content));
        } else if (insertion.placement === "after") {
          content = Buffer.from(withSeparator(content, insertion.bytes));
        } else {
          content = Buffer.from(insertion.bytes);
        }
      }
      return {
        root_id: snapshot.root_id,
        path: snapshot.path,
        preimage_sha256: snapshot.content_utf8 === null
          ? null
          : digest(snapshot.content_utf8),
        after_sha256: digest(content),
        after_utf8: content.toString("utf8"),
        mode: snapshot.content_utf8 === null ? 0o644 : snapshot.mode,
      };
    });

  for (const action of actions) {
    if (action.kind !== "move") continue;
    const targetEntry = writeSet.find((entry) =>
      entry.root_id === action.target.root_id && entry.path === action.target.path
    );
    if (
      targetEntry === undefined
      || !Buffer.from(targetEntry.after_utf8, "utf8")
        .includes(selectedBytes(action.source, snapshots))
    ) {
      throw new Error("move content-conservation assertion failed");
    }
  }

  return createKnowledgeHygieneTransactionPlanV1({
    kind: input.kind,
    revision: input.revision,
    created_at: input.created_at,
    expires_at: input.expires_at,
    repo: input.repo,
    ...(input.memory_root === undefined ? {} : { memory_root: input.memory_root }),
    actions,
    write_set: writeSet,
    evidence_refs: input.evidence_refs,
  });
}
