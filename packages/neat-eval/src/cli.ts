#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  CorpusLockV1,
  CustodyReceiptV1,
  HiddenExecutionBundleV1,
  ParityProtocolV1,
} from "./types.js";
import {
  buildDevelopmentCorpusV1,
  materializeDevelopmentCorpusV1,
  verifyFrozenBaselineV1,
} from "./corpus.js";
import {
  loadExternalAdapterV1,
  blindExternalDiffsV1,
  parseExternalParityMatrixResultV1,
  runExternalParityMatrixV1,
  runMechanicalControlV1,
  type ExternalParityAdapterV1,
  validateExternalAdapterMatrixV1,
} from "./runner.js";
import {
  scoreParityEvaluationV1,
  type ParityEvaluationInputV1,
} from "./scorer.js";

function digest(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function option(args: readonly string[], name: string): string | undefined {
  const indexes = args.flatMap((value, index) => value === name ? [index] : []);
  if (indexes.length > 1) throw new Error(`duplicate option ${name}`);
  const index = indexes[0];
  if (index === undefined) return undefined;
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

function required(args: readonly string[], name: string): string {
  const value = option(args, name);
  if (value === undefined) throw new Error(`${name} is required`);
  return value;
}

function options(args: readonly string[], name: string): string[] {
  return args.flatMap((value, index) => {
    if (value !== name) return [];
    const next = args[index + 1];
    if (next === undefined || next.startsWith("--")) throw new Error(`${name} requires a value`);
    return [next];
  });
}

async function privateWrite(path: string, value: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, value, { encoding: "utf8", mode: 0o600 });
}

async function fetchBaseline(output: string): Promise<void> {
  const corpus = buildDevelopmentCorpusV1();
  const url = `https://raw.githubusercontent.com/${corpus.baseline.repository}/${corpus.baseline.commit}/${corpus.baseline.path}`;
  const response = await fetch(url, {
    headers: { "user-agent": "osstack-neat-eval/1" },
    redirect: "error",
  });
  if (!response.ok) throw new Error(`baseline download failed: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (digest(bytes) !== corpus.baseline.sha256) {
    throw new Error("downloaded baseline does not match the frozen SHA-256");
  }
  await privateWrite(output, bytes.toString("utf8"));
}

async function verifyCorpusLock(lockPath: string): Promise<{
  valid: boolean;
  observed: ReturnType<typeof CorpusLockV1.parse>;
}> {
  const expected = CorpusLockV1.parse(JSON.parse(await readFile(lockPath, "utf8")));
  const root = await mkdtemp(join(tmpdir(), "osstack-neat-parity-lock-"));
  try {
    const generated = await materializeDevelopmentCorpusV1(root);
    const observed = CorpusLockV1.parse({
      schema_version: "1",
      corpus_id: buildDevelopmentCorpusV1().corpus_id,
      manifest_sha256: generated.manifest_sha256,
      generated_tree_sha256: generated.tree_sha256,
      cases: 30,
      defects: 120,
      baseline_sha256: buildDevelopmentCorpusV1().baseline.sha256,
    });
    return {
      valid: JSON.stringify(expected) === JSON.stringify(observed),
      observed,
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function doctor(args: readonly string[]): Promise<number> {
  const protocolPath = resolve(required(args, "--protocol"));
  const lockPath = resolve(required(args, "--corpus-lock"));
  const baselinePath = resolve(required(args, "--baseline"));
  const hiddenBundle = option(args, "--hidden-bundle");
  const custodyPath = option(args, "--custody-receipt");
  const protocolBytes = await readFile(protocolPath, "utf8");
  const protocolResult = ParityProtocolV1.safeParse(JSON.parse(protocolBytes));
  const protocol = protocolResult.success ? protocolResult.data : undefined;
  const checks: Array<{ check: string; passed: boolean; detail: string }> = [];
  checks.push({
    check: "protocol_schema",
    passed: protocol !== undefined,
    detail: protocolResult.success
      ? `sha256=${digest(protocolBytes)}`
      : protocolResult.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "),
  });
  checks.push({
    check: "models_frozen",
    passed: protocol?.status === "frozen"
      && protocol.primary_model_id !== null
      && protocol.secondary_model_id !== null,
    detail: "complete provider model ids are required before the first hidden run",
  });
  const lock = await verifyCorpusLock(lockPath);
  checks.push({
    check: "development_corpus_lock",
    passed: lock.valid,
    detail: `${lock.observed.cases} cases/${lock.observed.defects} defects`,
  });
  let baselineValid = false;
  if (existsSync(baselinePath)) {
    try {
      await verifyFrozenBaselineV1(baselinePath);
      baselineValid = true;
    } catch {
      baselineValid = false;
    }
  }
  checks.push({
    check: "frozen_A_baseline",
    passed: baselineValid,
    detail: baselinePath,
  });
  const hiddenPath = hiddenBundle === undefined ? undefined : resolve(hiddenBundle);
  let hiddenValid = false;
  let hiddenCustodian: string | undefined;
  if (
    hiddenPath !== undefined
    && existsSync(hiddenPath)
    && protocol?.hidden_bundle_sha256 !== null
    && protocol?.hidden_bundle_sha256 !== undefined
  ) {
    try {
      const bytes = await readFile(hiddenPath);
      const parsed = HiddenExecutionBundleV1.safeParse(JSON.parse(bytes.toString("utf8")));
      hiddenValid = digest(bytes) === protocol.hidden_bundle_sha256 && parsed.success;
      if (parsed.success) hiddenCustodian = parsed.data.custodian_id;
    } catch {
      hiddenValid = false;
    }
  }
  checks.push({
    check: "external_hidden_bundle",
    passed: hiddenValid,
    detail: hiddenPath ?? "not provided",
  });
  let custodyValid = false;
  let custodyBuilder: string | undefined;
  if (custodyPath !== undefined && existsSync(resolve(custodyPath))) {
    try {
      const parsed = CustodyReceiptV1.safeParse(JSON.parse(await readFile(resolve(custodyPath), "utf8")));
      custodyValid = parsed.success
        && protocol?.hidden_bundle_sha256 === parsed.data.bundle_sha256
        && hiddenCustodian === parsed.data.custodian_id;
      if (parsed.success) custodyBuilder = parsed.data.builder_id;
    } catch {
      custodyValid = false;
    }
  }
  checks.push({
    check: "independent_custody",
    passed: custodyValid,
    detail: custodyPath ?? "not provided",
  });
  const adapterPaths = options(args, "--adapter").map((path) => resolve(path));
  const adapters: ExternalParityAdapterV1[] = [];
  for (const path of adapterPaths) {
    try {
      adapters.push(await loadExternalAdapterV1(path));
    } catch {
      // Invalid adapters remain absent so the matrix gate fails closed.
    }
  }
  let adapterMatrixValid = false;
  if (protocol !== undefined) {
    try {
      validateExternalAdapterMatrixV1(adapters, protocol);
      adapterMatrixValid = adapters.every((adapter) =>
        custodyBuilder !== undefined && adapter.isolation.attested_by !== custodyBuilder
      );
    } catch {
      adapterMatrixValid = false;
    }
  }
  checks.push({
    check: "isolated_adapter_matrix",
    passed: adapterMatrixValid,
    detail: `${adapters.length}/4 adapters; attestations must be independent of builder`,
  });
  checks.push({
    check: "production_semantic_provider",
    passed: typeof process.env["ANTHROPIC_API_KEY"] === "string"
      && process.env["ANTHROPIC_API_KEY"]!.length > 0
      && typeof process.env["OSSTACK_NEAT_ANTHROPIC_MODEL"] === "string"
      && process.env["OSSTACK_NEAT_ANTHROPIC_MODEL"]!.length > 0,
    detail: "ANTHROPIC_API_KEY and OSSTACK_NEAT_ANTHROPIC_MODEL are required; logged-in general agents are not accepted as SemanticJudgePort",
  });
  const output = {
    schema_version: "1",
    status: checks.every((check) => check.passed) ? "go" : "no_go",
    checks,
  };
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  return output.status === "go" ? 0 : 3;
}

function help(): string {
  return `osstack-neat-eval — fail-closed neat semantic parity evaluator

Usage:
  osstack-neat-eval corpus materialize --output <directory>
  osstack-neat-eval corpus check --lock <corpus-lock.json>
  osstack-neat-eval baseline fetch --output <SKILL.md>
  osstack-neat-eval baseline verify --path <SKILL.md>
  osstack-neat-eval run-external --bundle <execution-bundle.json> --protocol <json>
    --custody-receipt <json> --baseline <SKILL.md>
    --adapter <adapter.json> [--adapter ... x4] --output <json>
  osstack-neat-eval blind-diffs --input <external-runs.json> --protocol <json>
    --packet-output <json> --key-output <private-json>
  osstack-neat-eval run-c --corpus-root <directory> --cli <dist/bin.js> --output <json>
  osstack-neat-eval score --input <hidden-evaluation.json> --protocol <json>
    --custody-receipt <json> --output <score.json>
  osstack-neat-eval doctor --protocol <json> --corpus-lock <json> --baseline <SKILL.md>
    [--hidden-bundle <path> --custody-receipt <path> --adapter <adapter.json> x4]

Exit 3 means evidence is incomplete or a parity gate failed.`;
}

async function main(args: readonly string[]): Promise<number> {
  const command = args[0];
  if (command === undefined || command === "--help" || command === "help") {
    process.stdout.write(`${help()}\n`);
    return 0;
  }
  if (command === "corpus" && args[1] === "materialize") {
    const output = resolve(required(args.slice(2), "--output"));
    await mkdir(output, { recursive: true, mode: 0o700 });
    const result = await materializeDevelopmentCorpusV1(output);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  }
  if (command === "corpus" && args[1] === "check") {
    const result = await verifyCorpusLock(resolve(required(args.slice(2), "--lock")));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return result.valid ? 0 : 3;
  }
  if (command === "baseline" && args[1] === "fetch") {
    await fetchBaseline(resolve(required(args.slice(2), "--output")));
    return 0;
  }
  if (command === "baseline" && args[1] === "verify") {
    await verifyFrozenBaselineV1(resolve(required(args.slice(2), "--path")));
    return 0;
  }
  if (command === "run-c") {
    const rest = args.slice(1);
    const corpusRoot = resolve(required(rest, "--corpus-root"));
    const output = resolve(required(rest, "--output"));
    const run = await runMechanicalControlV1({
      corpus: buildDevelopmentCorpusV1(),
      materialized_root: corpusRoot,
      cli_entry: resolve(required(rest, "--cli")),
    });
    await privateWrite(output, `${JSON.stringify(run, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify({
      reproducible: run.reproducible,
      result_sha256: run.result_sha256,
      runs: run.runs.length,
      output,
    }, null, 2)}\n`);
    return run.reproducible ? 0 : 3;
  }
  if (command === "run-external") {
    const rest = args.slice(1);
    const bundlePath = resolve(required(rest, "--bundle"));
    const bundleBytes = await readFile(bundlePath);
    const bundle = HiddenExecutionBundleV1.parse(JSON.parse(bundleBytes.toString("utf8")));
    const protocol = ParityProtocolV1.parse(JSON.parse(
      await readFile(resolve(required(rest, "--protocol")), "utf8"),
    ));
    if (protocol.status !== "frozen") throw new Error("protocol must be frozen before external runs");
    if (digest(bundleBytes) !== protocol.hidden_bundle_sha256) {
      throw new Error("hidden bundle does not match frozen protocol commitment");
    }
    const receipt = CustodyReceiptV1.parse(JSON.parse(
      await readFile(resolve(required(rest, "--custody-receipt")), "utf8"),
    ));
    if (
      receipt.bundle_sha256 !== protocol.hidden_bundle_sha256
      || receipt.custodian_id !== bundle.custodian_id
    ) {
      throw new Error("custody receipt does not authorize the frozen hidden bundle");
    }
    const baselinePath = resolve(required(rest, "--baseline"));
    await verifyFrozenBaselineV1(baselinePath);
    const adapterPaths = options(rest, "--adapter");
    const adapters = await Promise.all(adapterPaths.map((path) => loadExternalAdapterV1(resolve(path))));
    if (adapters.some((adapter) => adapter.isolation.attested_by === receipt.builder_id)) {
      throw new Error("builder cannot attest external adapter isolation");
    }
    const result = await runExternalParityMatrixV1({
      bundle,
      bundle_path: bundlePath,
      baseline_path: baselinePath,
      adapters,
      protocol,
    });
    const output = resolve(required(rest, "--output"));
    await privateWrite(output, `${JSON.stringify(result, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify({
      schema_version: "1",
      bundle_id: result.bundle_id,
      runs: result.runs.length,
      failures: result.runs.filter((run) => run.failure).length,
      output,
    }, null, 2)}\n`);
    return result.runs.some((run) => run.failure) ? 3 : 0;
  }
  if (command === "blind-diffs") {
    const rest = args.slice(1);
    const protocol = ParityProtocolV1.parse(JSON.parse(
      await readFile(resolve(required(rest, "--protocol")), "utf8"),
    ));
    const result = parseExternalParityMatrixResultV1(JSON.parse(
      await readFile(resolve(required(rest, "--input")), "utf8"),
    ));
    const blinded = blindExternalDiffsV1(result, protocol.random_seed);
    await privateWrite(
      resolve(required(rest, "--packet-output")),
      `${JSON.stringify(blinded.packet, null, 2)}\n`,
    );
    await privateWrite(
      resolve(required(rest, "--key-output")),
      `${JSON.stringify(blinded.key, null, 2)}\n`,
    );
    process.stdout.write(`${JSON.stringify({
      schema_version: "1",
      pairs: blinded.packet.pairs.length,
      packet_sha256: digest(JSON.stringify(blinded.packet)),
      key_sha256: digest(JSON.stringify(blinded.key)),
    }, null, 2)}\n`);
    return 0;
  }
  if (command === "score") {
    const rest = args.slice(1);
    const protocolBytes = await readFile(resolve(required(rest, "--protocol")), "utf8");
    const protocol = ParityProtocolV1.parse(JSON.parse(protocolBytes));
    if (protocol.status !== "frozen") throw new Error("protocol must be frozen before scoring");
    const receipt = CustodyReceiptV1.parse(JSON.parse(
      await readFile(resolve(required(rest, "--custody-receipt")), "utf8"),
    ));
    const input = JSON.parse(
      await readFile(resolve(required(rest, "--input")), "utf8"),
    ) as ParityEvaluationInputV1;
    if (
      input.protocol_sha256 !== digest(protocolBytes)
      || input.corpus_commitment_sha256 !== receipt.labels_sha256
      || receipt.bundle_sha256 !== protocol.hidden_bundle_sha256
      || input.custody_receipt.builder_id !== receipt.builder_id
      || input.custody_receipt.custodian_id !== receipt.custodian_id
      || input.custody_receipt.injected_at !== receipt.injected_at
    ) {
      throw new Error("evaluation input is not bound to the frozen protocol and custody receipt");
    }
    const score = scoreParityEvaluationV1(input);
    await privateWrite(
      resolve(required(rest, "--output")),
      `${JSON.stringify(score, null, 2)}\n`,
    );
    process.stdout.write(`${JSON.stringify(score, null, 2)}\n`);
    return score.status === "passed" ? 0 : 3;
  }
  if (command === "doctor") return await doctor(args.slice(1));
  throw new Error(`unknown command: ${args.join(" ")}`);
}

main(process.argv.slice(2)).then((code) => {
  process.exitCode = code;
}).catch((error) => {
  process.stderr.write(`osstack-neat-eval: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 2;
});
