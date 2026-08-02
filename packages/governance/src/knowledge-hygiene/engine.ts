import { basename, relative, resolve, sep } from "node:path";
import { realpath } from "node:fs/promises";
import {
  buildKnowledgeHygieneChangeSet,
  type BuildKnowledgeHygieneChangeSetInputV1,
} from "./change-set.js";
import {
  loadKnowledgeHygieneConfig,
  type KnowledgeHygieneConfigV1,
  type LoadKnowledgeHygieneConfigInput,
  type LoadedKnowledgeHygieneConfig,
} from "./config.js";
import {
  inspectInstructionSource,
  type InspectInstructionSourceInputV1,
  type InstructionSourceObservationV1,
} from "./instruction-source.js";
import {
  inventoryKnowledgeSurfaces,
  type InventoryKnowledgeSurfacesInputV1,
} from "./repository-reader.js";
import {
  evaluateKnowledgeHygieneRules,
  filterSuppressedKnowledgeHygieneFindings,
  type InspectKnowledgeReferencesInputV1,
  inspectKnowledgeReferences,
  type KnowledgeHygieneReferenceObservationV1,
  KNOWLEDGE_HYGIENE_RULES_V1,
  type KnowledgeHygieneRuleV1,
} from "./rules/index.js";
import {
  KnowledgeHygieneCheckInputV1,
  KnowledgeHygieneReportV1,
  KnowledgeSurfaceMetricV1,
  type KnowledgeHygieneChangeSetV1,
  type KnowledgeHygieneFindingV1,
  type KnowledgeHygieneReportV1 as KnowledgeHygieneReport,
  type KnowledgeSurfaceInventoryEntryV1,
  KnowledgeSurfaceInventoryV1,
} from "./types.js";
import {
  CLAUDE_CODE_MEMORY_ADAPTER_V1,
  CODEX_LOCAL_MEMORY_ADAPTER_V1,
  runKnowledgeSurfaceAdapter,
  type KnowledgeSurfaceAdapterRunResultV1,
  type KnowledgeSurfaceAdapterV1,
} from "./adapters/index.js";
import {
  inspectProbeKnowledgeHygiene,
  type InspectProbeKnowledgeHygieneInputV1,
  type ProbeKnowledgeHygieneInspectionV1,
} from "./adapters/probe-artifacts.js";

export interface KnowledgeHygieneEnginePortsV1 {
  now?: () => Date;
  repo_identity?: (repoRoot: string) => string | Promise<string>;
  resolve_repo_root?: (repoRoot: string) => Promise<string>;
  load_config?: (
    input: LoadKnowledgeHygieneConfigInput,
  ) => Promise<LoadedKnowledgeHygieneConfig>;
  build_change_set?: (
    input: BuildKnowledgeHygieneChangeSetInputV1,
  ) => Promise<KnowledgeHygieneChangeSetV1>;
  inventory?: (
    input: InventoryKnowledgeSurfacesInputV1,
  ) => Promise<KnowledgeSurfaceInventoryV1>;
  inspect_instruction?: (
    input: InspectInstructionSourceInputV1,
  ) => Promise<InstructionSourceObservationV1>;
  inspect_references?: (
    input: InspectKnowledgeReferencesInputV1,
  ) => Promise<KnowledgeHygieneReferenceObservationV1[]>;
  rules?: readonly KnowledgeHygieneRuleV1[];
  adapters?: readonly KnowledgeSurfaceAdapterV1[];
  home_directory?: () => string | undefined;
  inspect_probe_artifacts?: (
    input: InspectProbeKnowledgeHygieneInputV1,
  ) => Promise<ProbeKnowledgeHygieneInspectionV1>;
}

const severityOrder = { error: 0, warning: 1, info: 2 } as const;

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sortFindings(
  findings: readonly KnowledgeHygieneFindingV1[],
): KnowledgeHygieneFindingV1[] {
  return [...findings].sort(
    (left, right) =>
      severityOrder[left.severity] - severityOrder[right.severity] ||
      compareText(left.rule_id, right.rule_id) ||
      compareText(left.location.path, right.location.path) ||
      compareText(left.location.anchor ?? "", right.location.anchor ?? "") ||
      compareText(left.fingerprint, right.fingerprint),
  );
}

function selectedRules(
  input: KnowledgeHygieneCheckInputV1,
  rules: readonly KnowledgeHygieneRuleV1[],
): readonly KnowledgeHygieneRuleV1[] {
  if (input.checks) {
    const selected = new Set(input.checks);
    return rules.filter((rule) => selected.has(rule.id));
  }
  if (input.skip_checks) {
    const skipped = new Set(input.skip_checks);
    return rules.filter((rule) => !skipped.has(rule.id));
  }
  return rules;
}

function buildChangeSetInput(
  input: KnowledgeHygieneCheckInputV1,
  configSha256: string | undefined,
): BuildKnowledgeHygieneChangeSetInputV1 | undefined {
  const common = {
    repo_root: input.repo_root,
    ...(configSha256 === undefined ? {} : { config_sha256: configSha256 }),
  };
  if (input.mode === "all") return undefined;
  if (input.mode === "worktree") return { ...common, mode: "worktree" };
  if (input.mode === "range") {
    if (!input.base_ref || !input.head_ref) {
      throw new Error("validated range input is missing refs");
    }
    return {
      ...common,
      mode: "range",
      base_ref: input.base_ref,
      head_ref: input.head_ref,
    };
  }
  if (!input.base_ref) {
    throw new Error("validated base_to_worktree input is missing base_ref");
  }
  return { ...common, mode: "base_to_worktree", base_ref: input.base_ref };
}

async function instructionObservations(
  repoRoot: string,
  loadedConfig: LoadedKnowledgeHygieneConfig,
  inspect: NonNullable<KnowledgeHygieneEnginePortsV1["inspect_instruction"]>,
): Promise<InstructionSourceObservationV1[]> {
  const config = loadedConfig.mode === "configured"
    ? loadedConfig.config
    : undefined;
  if (!config?.instructions) {
    return [await inspect({
      repo_root: repoRoot,
      canonical_path: "AGENTS.md",
      mirror_path: "CLAUDE.md",
      mirror_mode: "import_or_symlink",
    })];
  }

  const observations: InstructionSourceObservationV1[] = [];
  for (const mirror of config.instructions.mirrors) {
    observations.push(await inspect({
      repo_root: repoRoot,
      canonical_path: config.instructions.canonical,
      mirror_path: mirror.path,
      mirror_mode: mirror.mode,
    }));
  }
  return observations;
}

function toMetric(
  surface: KnowledgeSurfaceInventoryEntryV1,
): KnowledgeSurfaceMetricV1 {
  return KnowledgeSurfaceMetricV1.parse({
    surface: surface.surface,
    path: surface.path,
    kind: surface.kind,
    exists: surface.exists,
    ...(surface.bytes === undefined ? {} : { bytes: surface.bytes }),
    ...(surface.lines === undefined ? {} : { lines: surface.lines }),
    ...(surface.sha256 === undefined ? {} : { sha256: surface.sha256 }),
    ...(surface.adapter === undefined ? {} : { adapter: surface.adapter }),
  });
}

function configuredAdapterInput(
  adapter: KnowledgeSurfaceAdapterV1,
  repoRoot: string,
  input: KnowledgeHygieneCheckInputV1,
  config: KnowledgeHygieneConfigV1 | undefined,
  homeDirectory: () => string | undefined,
) {
  const cli = input.adapters?.find((candidate) => candidate.id === adapter.id);
  const configured = adapter.id === "claude-code"
    ? config?.adapters?.claude_code
    : adapter.id === "codex-local"
    ? config?.adapters?.codex_local
    : undefined;
  const enabled = cli !== undefined || configured?.enabled === true;
  const memoryDirectory = cli?.memory_dir ?? configured?.memory_dir;
  const home = enabled && memoryDirectory?.startsWith("~/")
    ? homeDirectory()
    : undefined;
  return {
    repo_root: repoRoot,
    enabled,
    options: {
      ...(memoryDirectory === undefined
        ? {}
        : { memory_directory: memoryDirectory }),
      ...(home === undefined ? {} : { home_directory: home }),
    },
  };
}

function mergeInventories(
  repository: KnowledgeSurfaceInventoryV1,
  adapterRuns: readonly KnowledgeSurfaceAdapterRunResultV1[],
): KnowledgeSurfaceInventoryV1 {
  const available = adapterRuns.filter(
    (run): run is Extract<
      KnowledgeSurfaceAdapterRunResultV1,
      { status: "available" }
    > => run.status === "available",
  );
  return KnowledgeSurfaceInventoryV1.parse({
    surfaces: [
      ...repository.surfaces,
      ...available.flatMap((run) => run.inventory.surfaces),
    ],
    completeness: {
      complete: repository.completeness.complete
        && available.every((run) => run.inventory.completeness.complete),
      skipped_files: repository.completeness.skipped_files
        + available.reduce(
          (total, run) => total + run.inventory.completeness.skipped_files,
          0,
        ),
      reasons: [
        ...repository.completeness.reasons,
        ...available.flatMap((run) => run.inventory.completeness.reasons.map(
          (reason) => `${run.adapter_id}: ${reason}`,
        )),
      ],
    },
  });
}

function portableConfigPath(repoRoot: string, configPath: string): string {
  return relative(repoRoot, configPath).split(sep).join("/");
}

export async function checkKnowledgeHygiene(
  rawInput: KnowledgeHygieneCheckInputV1,
  ports: KnowledgeHygieneEnginePortsV1 = {},
): Promise<KnowledgeHygieneReport> {
  const input = KnowledgeHygieneCheckInputV1.parse(rawInput);
  const resolveRepoRoot = ports.resolve_repo_root ?? (async (path: string) =>
    realpath(resolve(path)));
  const loadConfig = ports.load_config ?? loadKnowledgeHygieneConfig;
  const buildChangeSet = ports.build_change_set ?? buildKnowledgeHygieneChangeSet;
  const inventory = ports.inventory ?? inventoryKnowledgeSurfaces;
  const inspect = ports.inspect_instruction ?? inspectInstructionSource;
  const inspectReferences = ports.inspect_references ?? inspectKnowledgeReferences;
  const now = ports.now ?? (() => new Date());
  const checkedAt = now();
  const adapters = ports.adapters ?? [
    CLAUDE_CODE_MEMORY_ADAPTER_V1,
    CODEX_LOCAL_MEMORY_ADAPTER_V1,
  ];
  const homeDirectory = ports.home_directory
    ?? (() => process.env["HOME"]);

  let repoRoot = await resolveRepoRoot(input.repo_root);
  const loadedConfig = await loadConfig({
    repo_root: repoRoot,
    ...(input.config_path === undefined
      ? {}
      : { config_path: input.config_path }),
  });
  const config = loadedConfig.mode === "configured"
    ? loadedConfig.config
    : undefined;
  const configSha256 = loadedConfig.mode === "configured"
    ? loadedConfig.sha256
    : undefined;
  const changeSetInput = buildChangeSetInput(input, configSha256);
  const changeSet = changeSetInput === undefined
    ? undefined
    : await buildChangeSet(changeSetInput);
  if (changeSet) repoRoot = changeSet.repo_root;

  const [repositoryInventory, observations, adapterRuns] = await Promise.all([
    inventory({
      repo_root: repoRoot,
      ...(config === undefined ? {} : { config }),
    }),
    instructionObservations(repoRoot, loadedConfig, inspect),
    Promise.all(adapters.map((adapter) => runKnowledgeSurfaceAdapter(
      adapter,
      configuredAdapterInput(
        adapter,
        repoRoot,
        input,
        config,
        homeDirectory,
      ),
    ))),
  ]);
  const surfaceInventory = mergeInventories(repositoryInventory, adapterRuns);
  const repoIdentity = await (ports.repo_identity?.(repoRoot)
    ?? basename(repoRoot));
  const [referenceObservations, probeInspection] = await Promise.all([
    inspectReferences({
      repo_root: repoRoot,
      inventory: surfaceInventory,
    }),
    (ports.inspect_probe_artifacts ?? inspectProbeKnowledgeHygiene)({
      repo_root: repoRoot,
      now_ms: checkedAt.getTime(),
    }),
  ]);
  const activeRules = selectedRules(
    input,
    ports.rules ?? KNOWLEDGE_HYGIENE_RULES_V1,
  );
  const activeRuleIds = new Set(activeRules.map((rule) => rule.id));
  const evaluated = evaluateKnowledgeHygieneRules(
    {
      repo_identity: repoIdentity,
      config,
      inventory: surfaceInventory,
      instruction_observations: observations,
      reference_observations: referenceObservations,
      change_set: changeSet,
    },
    activeRules,
  );
  const filtered = filterSuppressedKnowledgeHygieneFindings([
    ...evaluated,
    ...probeInspection.findings.filter((finding) =>
      activeRuleIds.has(finding.rule_id),
    ),
  ], config);
  const findings = sortFindings(filtered.active);
  const reportInput = {
    mode: input.mode,
    ...(changeSet === undefined
      ? {}
      : {
          base_ref: changeSet.base_ref,
          base_sha: changeSet.base_sha,
          ...(changeSet.head_ref === undefined
            ? {}
            : { head_ref: changeSet.head_ref }),
          ...(changeSet.head_sha === undefined
            ? {}
            : { head_sha: changeSet.head_sha }),
          diff_id: changeSet.diff_id,
        }),
    ...(loadedConfig.mode === "zero_config"
      ? {}
      : {
          config_path: portableConfigPath(repoRoot, loadedConfig.path),
          config_sha256: loadedConfig.sha256,
        }),
  };

  return KnowledgeHygieneReportV1.parse({
    schema_version: "1",
    generated_at: checkedAt.toISOString(),
    repo: { root: repoRoot, repo_id: repoIdentity },
    input: reportInput,
    completeness: surfaceInventory.completeness,
    summary: {
      error: findings.filter((finding) => finding.severity === "error").length,
      warning: findings.filter((finding) => finding.severity === "warning").length,
      info: findings.filter((finding) => finding.severity === "info").length,
      suppressed: filtered.suppressed.length,
    },
    findings,
    metrics: surfaceInventory.surfaces.map(toMetric),
    ...(adapterRuns.every((run) => run.status === "disabled")
      ? {}
      : {
          adapters: adapterRuns.flatMap((run) => run.status === "disabled"
            ? []
            : [{
                id: run.adapter_id,
                version: run.adapter_version,
                status: run.status,
                source: run.detection.evidence_source.ref,
              }]),
        }),
  });
}
