import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, posix, relative, resolve, sep } from "node:path";
import type { KnowledgeSurfaceInventoryV1 } from "../types.js";
import {
  createRuleFinding,
  findingEvidence,
  type KnowledgeHygieneReferenceObservationV1,
  type KnowledgeHygieneRuleV1,
} from "./rule-types.js";

interface ExtractedReferenceV1 {
  kind: KnowledgeHygieneReferenceObservationV1["kind"];
  source_path: string;
  line: number;
  target: string;
  resolved_path: string;
}

export interface InspectKnowledgeReferencesInputV1 {
  repo_root: string;
  inventory: KnowledgeSurfaceInventoryV1;
}

function plainRelativeTarget(
  rawTarget: string,
  sourcePath: string,
  kind: ExtractedReferenceV1["kind"],
): { target: string; resolved_path: string } | undefined {
  if (
    rawTarget.length === 0 ||
    /\s/.test(rawTarget) ||
    rawTarget.includes("\\") ||
    rawTarget.includes("$") ||
    rawTarget.includes("{") ||
    rawTarget.includes("}") ||
    rawTarget.includes("?") ||
    rawTarget.startsWith("#") ||
    rawTarget.startsWith("/") ||
    rawTarget.startsWith("<") ||
    /^[A-Za-z][A-Za-z0-9+.-]*:/.test(rawTarget)
  ) return undefined;

  const pathPart = rawTarget.split("#", 1)[0];
  if (!pathPart) return undefined;
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathPart);
  } catch {
    return undefined;
  }
  const resolvedPath = kind === "instruction_import"
    ? posix.normalize(decoded)
    : posix.normalize(posix.join(posix.dirname(sourcePath), decoded));
  if (
    posix.isAbsolute(resolvedPath) ||
    resolvedPath === ".." ||
    resolvedPath.startsWith("../")
  ) return undefined;
  return { target: rawTarget, resolved_path: resolvedPath };
}

function extractReferences(
  inventory: KnowledgeSurfaceInventoryV1,
): ExtractedReferenceV1[] {
  const references: ExtractedReferenceV1[] = [];
  const seen = new Set<string>();
  const addReference = (reference: ExtractedReferenceV1): void => {
    const key = [
      reference.kind,
      reference.source_path,
      reference.resolved_path,
    ].join("\0");
    if (seen.has(key)) return;
    seen.add(key);
    references.push(reference);
  };
  for (const surface of inventory.surfaces) {
    if (surface.kind !== "file" || surface.content === undefined) continue;
    const lines = surface.content.replace(/\r\n?/g, "\n").split("\n");
    let inFence = false;
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? "";
      if (/^\s*(?:```|~~~)/.test(line)) {
        inFence = !inFence;
        continue;
      }
      if (inFence) continue;

      const linkPattern = /(?<!!)\[[^\]\n]+\]\(([^)\n]+)\)/gu;
      for (const match of line.matchAll(linkPattern)) {
        const rawTarget = match[1];
        if (!rawTarget) continue;
        const target = plainRelativeTarget(
          rawTarget,
          surface.path,
          "markdown_link",
        );
        if (!target) continue;
        addReference({
          kind: "markdown_link",
          source_path: surface.path,
          line: index + 1,
          ...target,
        });
      }

      if (surface.surface === "instruction") {
        const importMatch = line.trim().match(/^@([^\s]+)$/);
        const rawTarget = importMatch?.[1];
        if (rawTarget) {
          const target = plainRelativeTarget(
            rawTarget,
            surface.path,
            "instruction_import",
          );
          if (target) {
            addReference({
              kind: "instruction_import",
              source_path: surface.path,
              line: index + 1,
              ...target,
            });
          }
        }
      }
    }
  }
  return references;
}

function isInsideRoot(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return (
    pathFromRoot === "" ||
    (!pathFromRoot.startsWith(`..${sep}`) &&
      pathFromRoot !== ".." &&
      !isAbsolute(pathFromRoot))
  );
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  return typeof error.code === "string" ? error.code : undefined;
}

export async function inspectKnowledgeReferences(
  input: InspectKnowledgeReferencesInputV1,
): Promise<KnowledgeHygieneReferenceObservationV1[]> {
  const repoRoot = await realpath(resolve(input.repo_root));
  const extracted = extractReferences(input.inventory);
  const observations: KnowledgeHygieneReferenceObservationV1[] = [];
  for (const reference of extracted) {
    const absoluteTarget = resolve(repoRoot, reference.resolved_path);
    if (!isInsideRoot(repoRoot, absoluteTarget)) continue;
    try {
      const metadata = await lstat(absoluteTarget);
      if (metadata.isSymbolicLink()) {
        try {
          const resolvedTarget = await realpath(absoluteTarget);
          const safe = isInsideRoot(repoRoot, resolvedTarget);
          observations.push({
            ...reference,
            exists: safe,
            ...(safe ? {} : { unsafe_symlink: true }),
          });
        } catch {
          observations.push({ ...reference, exists: false, unsafe_symlink: true });
        }
      } else {
        observations.push({ ...reference, exists: true });
      }
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
      observations.push({ ...reference, exists: false });
    }
  }
  return observations;
}

function referenceRule(
  kind: KnowledgeHygieneReferenceObservationV1["kind"],
): KnowledgeHygieneRuleV1 {
  const markdown = kind === "markdown_link";
  return {
    id: markdown
      ? "reference.markdown_target_missing"
      : "reference.instruction_import_missing",
    version: "1",
    default_severity: markdown ? "warning" : "error",
    evaluate(input) {
      return input.reference_observations.flatMap((observation) => {
        if (observation.kind !== kind || observation.exists) return [];
        const source = input.inventory.surfaces.find(
          (surface) => surface.path === observation.source_path,
        );
        return [createRuleFinding(this, input, {
          path: observation.source_path,
          line: observation.line,
          anchor: `target:${observation.resolved_path}`,
          surface: source?.surface ?? (markdown ? "documentation" : "instruction"),
          severity: markdown ? "warning" : "error",
          confidence: "high",
          observed: {
            target: observation.target,
            resolved_path: observation.resolved_path,
            exists: false,
            ...(observation.unsafe_symlink ? { unsafe_symlink: true } : {}),
          },
          expected: { exists: true },
          rationale: markdown
            ? "A plain relative Markdown link points to a missing repository target."
            : "An instruction import points to a missing repository target.",
          evidence_refs: findingEvidence(source),
          remediation: { mode: "agent_edit" },
        })];
      });
    },
  };
}

export const REFERENCE_RULES_V1 = Object.freeze([
  referenceRule("markdown_link"),
  referenceRule("instruction_import"),
] satisfies readonly KnowledgeHygieneRuleV1[]);
