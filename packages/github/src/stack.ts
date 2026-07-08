import { z } from "zod";
import { defaultCommandRunner, type CommandRunner } from "./branch-scanner.js";
import { CheckState } from "./types.js";

export const StackNode = z.object({
  number: z.number().int(),
  state: z.string(),
  base: z.string(),
  head: z.string(),
  mergeable: z.string(),
  mergeStateStatus: z.string(),
  ciState: CheckState,
  title: z.string(),
  url: z.string(),
});
export type StackNode = z.infer<typeof StackNode>;

export const StackEdge = z.object({
  parent: z.number().int(),
  child: z.number().int(),
});
export type StackEdge = z.infer<typeof StackEdge>;

export const StackModel = z.object({
  nodes: z.array(StackNode),
  edges: z.array(StackEdge),
  order: z.array(z.number().int()),
});
export type StackModel = z.infer<typeof StackModel>;

export const DriftIssueKind = z.enum([
  "conflicting",
  "ci_failing",
  "ci_pending",
  "not_mergeable",
  "orphan_base",
]);
export type DriftIssueKind = z.infer<typeof DriftIssueKind>;

export const DriftIssue = z.object({
  number: z.number().int(),
  kind: DriftIssueKind,
  detail: z.string(),
});
export type DriftIssue = z.infer<typeof DriftIssue>;

export const DriftReport = z.object({
  clean: z.boolean(),
  issues: z.array(DriftIssue),
});
export type DriftReport = z.infer<typeof DriftReport>;

export interface IngestStackSpec {
  prNumbers: number[];
  repo?: string;
}

const PrViewJson = z.object({
  number: z.number().int(),
  state: z.string(),
  baseRefName: z.string(),
  headRefName: z.string(),
  mergeable: z.string(),
  mergeStateStatus: z.string(),
  statusCheckRollup: z.unknown().optional(),
  title: z.string(),
  url: z.string(),
});

const RollupCheck = z.object({
  conclusion: z.string().nullable().optional(),
  status: z.string().optional(),
});

const FAILING_CONCLUSIONS = new Set(["FAILURE", "CANCELLED", "TIMED_OUT", "ERROR"]);
const IN_PROGRESS_STATUSES = new Set(["IN_PROGRESS", "QUEUED", "PENDING"]);

export function mapRollupToCheckState(statusCheckRollup: unknown): CheckState {
  if (!Array.isArray(statusCheckRollup) || statusCheckRollup.length === 0) {
    return "unknown";
  }

  const checks = statusCheckRollup.map((entry) => RollupCheck.parse(entry));

  const hasFailure = checks.some(
    (check) => check.conclusion != null && FAILING_CONCLUSIONS.has(check.conclusion),
  );
  if (hasFailure) return "failure";

  const hasPending = checks.some(
    (check) =>
      check.conclusion == null ||
      (check.status != null && IN_PROGRESS_STATUSES.has(check.status)),
  );
  if (hasPending) return "pending";

  return "success";
}

export async function ingestStack(
  spec: IngestStackSpec,
  runner: CommandRunner = defaultCommandRunner,
): Promise<StackModel> {
  const nodes: StackNode[] = [];

  for (const number of spec.prNumbers) {
    const args = [
      "pr",
      "view",
      String(number),
      "--json",
      "number,state,baseRefName,headRefName,mergeable,mergeStateStatus,statusCheckRollup,title,url",
      ...(spec.repo ? ["--repo", spec.repo] : []),
    ];
    const stdout = await runner.run("gh", args);
    const parsed = PrViewJson.parse(JSON.parse(stdout));

    nodes.push(
      StackNode.parse({
        number: parsed.number,
        state: parsed.state,
        base: parsed.baseRefName,
        head: parsed.headRefName,
        mergeable: parsed.mergeable,
        mergeStateStatus: parsed.mergeStateStatus,
        ciState: mapRollupToCheckState(parsed.statusCheckRollup),
        title: parsed.title,
        url: parsed.url,
      }),
    );
  }

  const edges: StackEdge[] = [];
  for (const child of nodes) {
    const parent = nodes.find((candidate) => candidate.head === child.base);
    if (parent) {
      edges.push({ parent: parent.number, child: child.number });
    }
  }

  const order = topoOrderBottomUp(
    nodes.map((node) => node.number),
    edges,
  );

  return StackModel.parse({ nodes, edges, order });
}

function topoOrderBottomUp(numbers: number[], edges: StackEdge[]): number[] {
  const inDegree = new Map<number, number>();
  const childrenOf = new Map<number, number[]>();

  for (const n of numbers) {
    inDegree.set(n, 0);
    childrenOf.set(n, []);
  }

  for (const edge of edges) {
    inDegree.set(edge.child, (inDegree.get(edge.child) ?? 0) + 1);
    childrenOf.get(edge.parent)?.push(edge.child);
  }

  const ready = numbers.filter((n) => (inDegree.get(n) ?? 0) === 0).sort((a, b) => a - b);
  const order: number[] = [];

  while (ready.length > 0) {
    const next = ready.shift();
    if (next === undefined) break;
    order.push(next);

    const children = (childrenOf.get(next) ?? []).slice().sort((a, b) => a - b);
    for (const child of children) {
      const remaining = (inDegree.get(child) ?? 0) - 1;
      inDegree.set(child, remaining);
      if (remaining === 0) {
        ready.push(child);
        ready.sort((a, b) => a - b);
      }
    }
  }

  return order;
}

export function detectDrift(stack: StackModel): DriftReport {
  const heads = new Set(stack.nodes.map((node) => node.head));

  // The stack's root base is the base of the bottom-most node in the stack's
  // bottom-up order (stack.order[0]) — the one PR that legitimately targets a
  // ref outside the stack (e.g. "main"). Any other node whose base doesn't
  // match another node's head is drifted onto an unexpected/orphaned base.
  const bottomNumbers = new Set(stack.order.slice(0, 1));
  const rootBases = new Set(
    stack.nodes
      .filter((node) => bottomNumbers.has(node.number))
      .map((node) => node.base)
      .filter((base) => !heads.has(base)),
  );

  const issues: DriftIssue[] = [];

  for (const node of stack.nodes) {
    if (node.mergeable === "CONFLICTING") {
      issues.push({
        number: node.number,
        kind: "not_mergeable",
        detail: `PR #${node.number} has mergeable=CONFLICTING`,
      });
    }

    if (node.mergeStateStatus === "DIRTY" || node.mergeStateStatus === "BLOCKED") {
      issues.push({
        number: node.number,
        kind: "conflicting",
        detail: `PR #${node.number} has mergeStateStatus=${node.mergeStateStatus}`,
      });
    }

    if (node.ciState === "failure") {
      issues.push({
        number: node.number,
        kind: "ci_failing",
        detail: `PR #${node.number} has failing CI`,
      });
    }

    if (node.ciState === "pending") {
      issues.push({
        number: node.number,
        kind: "ci_pending",
        detail: `PR #${node.number} has pending CI`,
      });
    }

    if (!heads.has(node.base) && !rootBases.has(node.base)) {
      issues.push({
        number: node.number,
        kind: "orphan_base",
        detail: `PR #${node.number} bases on "${node.base}" which is not part of the stack`,
      });
    }
  }

  return DriftReport.parse({ clean: issues.length === 0, issues });
}
