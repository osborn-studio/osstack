import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  DevelopmentCorpusV1,
  type ParityCorpusCaseV1,
  type ParityDefectCategoryV1,
  type ParityDefectV1,
} from "./types.js";

const KHAZIX_SOURCE = {
  source_url: "https://github.com/KKKKhazix/khazix-skills/blob/2b4a645cfdc894156ae347d897723562f719ce95/neat-freak/SKILL.md",
  source_commit: "2b4a645cfdc894156ae347d897723562f719ce95",
  source_sha256: "6c0ca2236d3518ccaad710f6db8e9c4aa7af67b685dc699ad347ae42186951e1",
  license: "MIT",
  derivation: "Anonymized defect taxonomy derived from the frozen v3 source workflow; no source prose copied.",
} as const;

export interface FrozenBaselineFileV1 {
  path: string;
  mode: "100644" | "100755";
  sha256: string;
  bytes: number;
}

export const KHAZIX_NEAT_FREAK_V3_RUNTIME_FILES: readonly FrozenBaselineFileV1[] = [
  {
    path: "SKILL.md",
    mode: "100644",
    sha256: "6c0ca2236d3518ccaad710f6db8e9c4aa7af67b685dc699ad347ae42186951e1",
    bytes: 15_454,
  },
  {
    path: "references/agent-paths.md",
    mode: "100644",
    sha256: "8210a3cc1211283f71f068de99fd17e62fb9ce269ca6e693879ce6c30e31aff6",
    bytes: 5_267,
  },
  {
    path: "references/governance.md",
    mode: "100644",
    sha256: "6bf4bbf171864f2c82a5f8b8cf441df043362e8790c69ddca38f207c38bb5f72",
    bytes: 4_296,
  },
  {
    path: "references/sync-matrix.md",
    mode: "100644",
    sha256: "5c771ba2695a0d0dc54ef636531d61c916ed7f0f39db39827bbb330268f7648d",
    bytes: 4_817,
  },
  {
    path: "references/verification.md",
    mode: "100644",
    sha256: "cd3f4bf5cdc59c3aa51db868801f7461563a4b4a58b72799a6753c1f863c4126",
    bytes: 4_042,
  },
  {
    path: "scripts/audit-inventory.sh",
    mode: "100755",
    sha256: "260315d659f19e63a12065f9cadd9b57f9c1ddc867457f6c0f6fd87c003a7325",
    bytes: 3_593,
  },
] as const;

const KHAZIX_BASELINE = {
  repository: "KKKKhazix/khazix-skills",
  commit: "2b4a645cfdc894156ae347d897723562f719ce95",
  path: "neat-freak",
  sha256: "e77e30e39e67f05d3159548605057d396794d1bde20bd59a070670e109c3d904",
  license: "MIT",
} as const;

const OSSTACK_SOURCE = {
  source_url: "https://github.com/gilosbornhello/osstack/blob/8314e997f66ef0718276f518d72e34c56ba0ca16/AGENTS.md",
  source_commit: "8314e997f66ef0718276f518d72e34c56ba0ca16",
  source_sha256: "7421eeb956b0b2ac9441fffb30a8f824aad808aa2bdb8dcc781f946fdedfa0cb",
  license: "MIT",
  derivation: "Sanitized reproduction of a naturally observed rulebook-contamination pattern; identifiers removed.",
} as const;

const repositories = [
  { repository_id: "platform-core", role: "core_platform" },
  { repository_id: "web-application", role: "app" },
  { repository_id: "sdk-client", role: "sdk" },
  { repository_id: "operations", role: "operations" },
  { repository_id: "documentation", role: "documentation" },
] as const;

const categories: ParityDefectCategoryV1[] = [
  "narrative_marker",
  "narrative_history",
  "contradiction",
  "drift",
  "memory_overlap",
  "volume_inversion",
  "cross_repository",
];

function digest(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function comparePortablePaths(left: FrozenBaselineFileV1, right: FrozenBaselineFileV1): number {
  return left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
}

function baselineBundleDigest(files: readonly FrozenBaselineFileV1[]): string {
  return digest(JSON.stringify([...files].sort(comparePortablePaths)));
}

export async function hashFrozenBaselineBundleV1(root: string): Promise<{
  bundle_sha256: string;
  files: FrozenBaselineFileV1[];
}> {
  const authority = await realpath(root);
  if (!(await lstat(authority)).isDirectory()) {
    throw new Error("frozen baseline must be a directory");
  }
  const files: FrozenBaselineFileV1[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const name of (await readdir(directory)).sort()) {
      const absolute = join(directory, name);
      const stats = await lstat(absolute);
      const portable = relative(authority, absolute).split("\\").join("/");
      if (stats.isSymbolicLink() || (!stats.isDirectory() && !stats.isFile())) {
        throw new Error(`baseline bundle contains unsupported entry: ${portable}`);
      }
      if (stats.isDirectory()) {
        await visit(absolute);
        continue;
      }
      files.push({
        path: portable,
        mode: stats.mode & 0o111 ? "100755" : "100644",
        sha256: digest(await readFile(absolute)),
        bytes: stats.size,
      });
    }
  };
  await visit(authority);
  files.sort(comparePortablePaths);
  return { bundle_sha256: baselineBundleDigest(files), files };
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

export async function fetchFrozenBaselineV1(
  output: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const destination = resolve(output);
  try {
    await lstat(destination);
    throw new Error(`baseline output already exists: ${destination}`);
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  const temporary = await mkdtemp(join(dirname(destination), ".osstack-neat-v3-"));
  try {
    for (const entry of KHAZIX_NEAT_FREAK_V3_RUNTIME_FILES) {
      const target = resolve(temporary, entry.path);
      const fromAuthority = relative(temporary, target);
      if (
        fromAuthority === ""
        || fromAuthority === ".."
        || fromAuthority.startsWith(`..${sep}`)
        || isAbsolute(fromAuthority)
      ) {
        throw new Error(`baseline file escapes output authority: ${entry.path}`);
      }
      const url = `https://raw.githubusercontent.com/${KHAZIX_BASELINE.repository}/${KHAZIX_BASELINE.commit}/${KHAZIX_BASELINE.path}/${entry.path}`;
      const response = await fetchImpl(url, {
        headers: { "user-agent": "osstack-neat-eval/1" },
        redirect: "error",
      });
      if (!response.ok) {
        throw new Error(`baseline download failed for ${entry.path}: HTTP ${response.status}`);
      }
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length !== entry.bytes || digest(bytes) !== entry.sha256) {
        throw new Error(`downloaded baseline file does not match manifest: ${entry.path}`);
      }
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await writeFile(target, bytes, { mode: entry.mode === "100755" ? 0o755 : 0o644 });
    }
    await verifyFrozenBaselineV1(temporary);
    await rename(temporary, destination);
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
}

function defect(caseIndex: number, defectIndex: number): ParityDefectV1 {
  const category = categories[(caseIndex * 4 + defectIndex) % categories.length]!;
  const natural = caseIndex < 10;
  const identity = digest(JSON.stringify([20260718, caseIndex, defectIndex, category]));
  const common = {
    defect_id: `nd_${identity.slice(0, 16)}`,
    category,
    origin: natural ? "natural_derived" as const : "controlled_seed" as const,
    provenance: natural
      ? (caseIndex % 2 === 0 ? OSSTACK_SOURCE : KHAZIX_SOURCE)
      : {
          ...KHAZIX_SOURCE,
          derivation: "Deterministic controlled seed derived from the frozen methodology taxonomy.",
        },
  };
  switch (category) {
    case "narrative_marker":
      return {
        ...common,
        paths: ["AGENTS.md"],
        expected_rule_ids: ["rulebook.embedded_memory_context"],
        expected_dimensions: ["narrative"],
        acceptable_remedies: ["delete marker-delimited session context", "move durable claims to docs"],
        impact_scope: ["instruction"],
      };
    case "narrative_history":
      return {
        ...common,
        paths: ["AGENTS.md"],
        expected_rule_ids: ["rulebook.narrative_contamination"],
        expected_dimensions: ["narrative"],
        acceptable_remedies: ["move release narrative to changelog", "delete superseded session history"],
        impact_scope: ["instruction"],
      };
    case "contradiction":
      return {
        ...common,
        paths: ["AGENTS.md"],
        expected_rule_ids: ["semantic.contradiction"],
        expected_dimensions: ["contradiction"],
        acceptable_remedies: ["retain one authoritative routing rule after owner decision"],
        impact_scope: ["instruction", "implementation"],
      };
    case "drift":
      return {
        ...common,
        paths: ["AGENTS.md", "CLAUDE.md"],
        expected_rule_ids: ["semantic.drift"],
        expected_dimensions: ["drift"],
        acceptable_remedies: ["synchronize the declared mirror with the canonical rulebook"],
        impact_scope: ["instruction"],
      };
    case "memory_overlap":
      return {
        ...common,
        paths: ["memory/project.md", "memory/feedback.md"],
        expected_rule_ids: ["semantic.memory_overlap"],
        expected_dimensions: ["memory_overlap"],
        acceptable_remedies: ["merge duplicate claims and preserve one indexed reference"],
        impact_scope: ["memory"],
      };
    case "volume_inversion":
      return {
        ...common,
        paths: ["memory/MEMORY.md", "docs/architecture.md"],
        expected_rule_ids: ["semantic.memory_overlap"],
        expected_dimensions: ["memory_overlap"],
        acceptable_remedies: ["graduate stable mechanism claims into docs and shrink memory"],
        impact_scope: ["memory", "documentation"],
      };
    case "cross_repository":
      return {
        ...common,
        paths: ["package.json", "docs/integration.md"],
        expected_rule_ids: ["semantic.cross_repository_impact"],
        expected_dimensions: ["cross_repository"],
        acceptable_remedies: ["update downstream integration contract", "declare and review dependency edge"],
        impact_scope: ["dependency", "documentation"],
      };
  }
}

export function buildDevelopmentCorpusV1(): DevelopmentCorpusV1 {
  const cases: ParityCorpusCaseV1[] = Array.from({ length: 30 }, (_value, index) => ({
    case_id: `case-${String(index + 1).padStart(3, "0")}`,
    repository_id: repositories[index % repositories.length]!.repository_id,
    split: index < 20 ? "train" : "dev",
    defects: Array.from({ length: 4 }, (_item, defectIndex) =>
      defect(index, defectIndex)
    ),
  }));
  const allDefects = cases.flatMap((entry) => entry.defects);
  return DevelopmentCorpusV1.parse({
    schema_version: "1",
    corpus_id: "osstack-neat-parity-development-v1",
    generator_version: "1",
    seed: 20260718,
    repositories,
    cases,
    summary: {
      cases: 30,
      defects: 120,
      natural_derived_defects: allDefects.filter((entry) =>
        entry.origin === "natural_derived"
      ).length,
      controlled_seed_defects: allDefects.filter((entry) =>
        entry.origin === "controlled_seed"
      ).length,
    },
    hidden_protocol: {
      external_bundle_required: true,
      minimum_cases: 30,
      minimum_defects: 120,
      labels_visible_to_builder: false,
    },
    baseline: KHAZIX_BASELINE,
  });
}

function cleanFiles(caseEntry: ParityCorpusCaseV1): Record<string, string> {
  return {
    "AGENTS.md": [
      `# ${caseEntry.repository_id}`,
      "",
      "Source modules MUST live under src/.",
      "Run pnpm test before merging.",
      "Secrets MUST remain outside the repository.",
      "",
    ].join("\n"),
    "CLAUDE.md": [
      `# ${caseEntry.repository_id}`,
      "",
      "Source modules MUST live under src/.",
      "Run pnpm test before merging.",
      "Secrets MUST remain outside the repository.",
      "",
    ].join("\n"),
    "README.md": `# ${caseEntry.repository_id}\n\nSee docs/architecture.md.\n`,
    "docs/architecture.md": "# Architecture\n\nThe service exposes a stable client boundary.\n",
    "docs/integration.md": "# Integration\n\nConsumers use the documented stable client.\n",
    "docs/runbook.md": "# Runbook\n\nRun pnpm test before deployment.\n",
    "memory/MEMORY.md": "# Memory\n\n- Architecture: docs/architecture.md\n",
    "memory/reference.md": "The canonical architecture is documented in docs/architecture.md.\n",
    "package.json": `${JSON.stringify({
      name: `@parity/${caseEntry.repository_id}`,
      version: "1.0.0",
      scripts: { test: "node --test" },
    }, null, 2)}\n`,
    ".osstack/neat.yaml": [
      "version: 2",
      "instructions:",
      "  canonical: AGENTS.md",
      "  mirrors:",
      "    - path: CLAUDE.md",
      "      mode: import",
      "semantic:",
      "  enabled: false",
      "",
    ].join("\n"),
  };
}

function applyDefect(
  files: Record<string, string>,
  defectEntry: ParityDefectV1,
): void {
  switch (defectEntry.category) {
    case "narrative_marker":
      files["AGENTS.md"] += [
        "<claude-mem-context>",
        "Session summary: implementation completed after several retries.",
        "</claude-mem-context>",
        "",
      ].join("\n");
      break;
    case "narrative_history":
      files["AGENTS.md"] += "2026-07-18: the migration shipped and the review thread was closed.\n";
      break;
    case "contradiction":
      files["AGENTS.md"] += [
        "All API routing MUST be implemented in src/routes/.",
        "API routing MUST never be implemented in src/routes/.",
        "",
      ].join("\n");
      break;
    case "drift":
      files["CLAUDE.md"] = files["CLAUDE.md"]!.replace(
        "Run pnpm test before merging.",
        "Skip pnpm test when a change only touches runtime code.",
      );
      break;
    case "memory_overlap": {
      const duplicate = "The stable client retries idempotent requests exactly twice before surfacing a typed failure.\n";
      files["memory/project.md"] = duplicate;
      files["memory/feedback.md"] = duplicate;
      break;
    }
    case "volume_inversion":
      files["memory/MEMORY.md"] += Array.from(
        { length: 80 },
        (_value, index) => `- Runtime mechanism detail ${index + 1}: the stable client boundary must remain documented.`,
      ).join("\n");
      files["memory/MEMORY.md"] += "\n";
      break;
    case "cross_repository": {
      const parsed = JSON.parse(files["package.json"]!) as Record<string, unknown>;
      parsed["dependencies"] = { "@parity/upstream-contract": "2.0.0" };
      files["package.json"] = `${JSON.stringify(parsed, null, 2)}\n`;
      files["docs/integration.md"] = "# Integration\n\nConsumers still use upstream-contract v1 request fields.\n";
      files["peer/upstream-contract.md"] = "# Upstream v2\n\nVersion 2 requires the request_id field.\n";
      break;
    }
  }
}

export interface CorpusSecretFindingV1 {
  path: string;
  detector: string;
}

const secretDetectors = [
  { id: "private_key", pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u },
  { id: "aws_access_key", pattern: /\bAKIA[0-9A-Z]{16}\b/u },
  { id: "bearer_token", pattern: /\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/u },
  { id: "github_token", pattern: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/u },
] as const;

export function scanCorpusSecretsV1(
  files: Readonly<Record<string, string>>,
): CorpusSecretFindingV1[] {
  return Object.entries(files).flatMap(([path, content]) =>
    secretDetectors.flatMap((detector) =>
      detector.pattern.test(content) ? [{ path, detector: detector.id }] : []
    )
  );
}

async function writeTree(
  root: string,
  files: Readonly<Record<string, string>>,
): Promise<Array<{ path: string; sha256: string }>> {
  const written = [];
  for (const [path, content] of Object.entries(files).sort(([left], [right]) =>
    left.localeCompare(right)
  )) {
    const absolute = join(root, path);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, content, "utf8");
    written.push({ path, sha256: digest(content) });
  }
  return written;
}

export async function materializeDevelopmentCorpusV1(root: string): Promise<{
  manifest_sha256: string;
  tree_sha256: string;
  files_written: number;
}> {
  const corpus = buildDevelopmentCorpusV1();
  const manifest = `${JSON.stringify(corpus, null, 2)}\n`;
  const tree: Array<{ path: string; sha256: string }> = [];
  for (const caseEntry of corpus.cases) {
    const clean = cleanFiles(caseEntry);
    const rot = { ...clean };
    for (const defectEntry of caseEntry.defects) applyDefect(rot, defectEntry);
    const secretFindings = [
      ...scanCorpusSecretsV1(clean),
      ...scanCorpusSecretsV1(rot),
    ];
    if (secretFindings.length > 0) {
      throw new Error(`corpus secret scan failed: ${JSON.stringify(secretFindings)}`);
    }
    const caseRoot = join(root, "cases", caseEntry.case_id);
    const cleanTree = await writeTree(join(caseRoot, "clean"), clean);
    const rotTree = await writeTree(join(caseRoot, "rot"), rot);
    tree.push(...cleanTree.map((entry) => ({
      path: `cases/${caseEntry.case_id}/clean/${entry.path}`,
      sha256: entry.sha256,
    })));
    tree.push(...rotTree.map((entry) => ({
      path: `cases/${caseEntry.case_id}/rot/${entry.path}`,
      sha256: entry.sha256,
    })));
    const caseManifest = `${JSON.stringify(caseEntry, null, 2)}\n`;
    await writeFile(join(caseRoot, "case.json"), caseManifest, "utf8");
    tree.push({
      path: `cases/${caseEntry.case_id}/case.json`,
      sha256: digest(caseManifest),
    });
  }
  await writeFile(join(root, "manifest.json"), manifest, "utf8");
  tree.push({ path: "manifest.json", sha256: digest(manifest) });
  tree.sort((left, right) => left.path.localeCompare(right.path));
  return {
    manifest_sha256: digest(manifest),
    tree_sha256: digest(JSON.stringify(tree)),
    files_written: tree.length,
  };
}

export async function verifyFrozenBaselineV1(path: string): Promise<void> {
  const observed = await hashFrozenBaselineBundleV1(path);
  const actual = observed.bundle_sha256;
  const expected = buildDevelopmentCorpusV1().baseline.sha256;
  if (actual !== expected) {
    throw new Error(`frozen baseline hash mismatch: expected ${expected}, received ${actual}`);
  }
  if (
    JSON.stringify(observed.files)
    !== JSON.stringify([...KHAZIX_NEAT_FREAK_V3_RUNTIME_FILES].sort(comparePortablePaths))
  ) {
    throw new Error("frozen baseline manifest mismatch");
  }
}
