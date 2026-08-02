#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const live = args.includes("--live");
const jsonOutput = args.includes("--json");
const corpusPath = resolve(
  repositoryRoot,
  flagValue(args, "--corpus") ?? "eval/kimi-review/corpus-v1.json",
);
const outputPath = resolve(
  repositoryRoot,
  flagValue(args, "--output")
    ?? "docs/reports/kimi-autonomy/phase-a-live-kimi-scorecard.json",
);

const corpus = validateCorpus(
  JSON.parse(await readFile(corpusPath, "utf8")),
);
const scorecard = live
  ? await runLiveCorpus(corpus)
  : runOfflineCorpus(corpus);

if (live) {
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(scorecard, null, 2)}\n`, "utf8");
}

if (jsonOutput) {
  process.stdout.write(`${JSON.stringify(scorecard, null, 2)}\n`);
} else {
  process.stdout.write([
    `mode=${scorecard.mode}`,
    `cases=${scorecard.case_count}`,
    `false_passes=${scorecard.false_pass_count}`,
    `false_alarms=${scorecard.false_alarm_count}`,
    `rule_misses=${scorecard.rule_miss_count}`,
    `gate=${scorecard.gate_pass ? "PASS" : "FAIL"}`,
    live ? `scorecard=${outputPath}` : "",
  ].filter(Boolean).join(" ") + "\n");
}

if (!scorecard.gate_pass) process.exitCode = 1;

function validateCorpus(value) {
  if (!isRecord(value)) throw new Error("corpus must be an object");
  if (value.schema_version !== 1) {
    throw new Error("corpus schema_version must equal 1");
  }
  if (typeof value.corpus_id !== "string" || value.corpus_id.length === 0) {
    throw new Error("corpus_id is required");
  }
  if (!Array.isArray(value.cases) || value.cases.length < 10) {
    throw new Error("Kimi review corpus must contain at least 10 cases");
  }
  const ids = new Set();
  const cases = value.cases.map((entry, index) => {
    if (!isRecord(entry)) throw new Error(`cases[${index}] must be an object`);
    const caseId = requiredString(entry.case_id, `cases[${index}].case_id`);
    if (ids.has(caseId)) throw new Error(`duplicate case_id: ${caseId}`);
    ids.add(caseId);
    const task = requiredString(entry.task, `${caseId}.task`);
    const diff = requiredString(entry.diff, `${caseId}.diff`);
    if (!diff.startsWith("diff --git ")) {
      throw new Error(`${caseId}.diff must be a unified Git diff`);
    }
    if (!Array.isArray(entry.evaluation_specs) || entry.evaluation_specs.length === 0) {
      throw new Error(`${caseId}.evaluation_specs must not be empty`);
    }
    const evaluationSpecs = entry.evaluation_specs.map((spec, specIndex) => {
      if (!isRecord(spec)) {
        throw new Error(`${caseId}.evaluation_specs[${specIndex}] must be an object`);
      }
      return {
        id: requiredString(spec.id, `${caseId}.evaluation_specs[${specIndex}].id`),
        description: requiredString(
          spec.description,
          `${caseId}.evaluation_specs[${specIndex}].description`,
        ),
        acceptance: requiredString(
          spec.acceptance,
          `${caseId}.evaluation_specs[${specIndex}].acceptance`,
        ),
      };
    });
    if (!["approved", "changes_requested", "blocked"].includes(entry.expected_verdict)) {
      throw new Error(`${caseId}.expected_verdict is invalid`);
    }
    if (
      !Array.isArray(entry.expected_finding_rules)
      || !entry.expected_finding_rules.every(
        (rule) => typeof rule === "string" && rule.length > 0,
      )
    ) {
      throw new Error(`${caseId}.expected_finding_rules must be string[]`);
    }
    if (
      entry.expected_verdict !== "approved"
      && entry.expected_finding_rules.length === 0
    ) {
      throw new Error(`${caseId} must declare a finding rule for its defect`);
    }
    return {
      case_id: caseId,
      task,
      diff,
      evaluation_specs: evaluationSpecs,
      expected_verdict: entry.expected_verdict,
      expected_finding_rules: [...entry.expected_finding_rules],
    };
  });
  return {
    schema_version: 1,
    corpus_id: value.corpus_id,
    cases,
  };
}

function runOfflineCorpus(corpusValue) {
  const results = corpusValue.cases.map((entry) => {
    const observed = deterministicOracle(entry.diff);
    return scoreCase(entry, {
      verdict: observed.verdict,
      finding_rules: observed.findingRules,
      runtime_identity: {
        adapter_id: "offline-deterministic-oracle",
        provider_id: "none",
        model_id: "none",
        evidence_source: "inferred",
      },
      usage: { status: "not_applicable" },
      result_digest: sha256(JSON.stringify(observed)),
    });
  });
  return aggregateScorecard(corpusValue, "offline", results, {
    adapter_readiness: "not_applicable",
    prompt_digest: sha256(corpusValue.cases.map((entry) => entry.diff).join("\n")),
  });
}

async function runLiveCorpus(corpusValue) {
  const agentsEntry = resolve(repositoryRoot, "packages/agents/dist/index.js");
  let KimiCodeAdapter;
  try {
    ({ KimiCodeAdapter } = await import(agentsEntry));
  } catch (error) {
    throw new Error(
      `built @osstack/agents is required; run pnpm --filter @osstack/agents build: ${String(error)}`,
    );
  }
  const adapter = new KimiCodeAdapter();
  const readiness = await adapter.readiness();
  if (readiness.state !== "kimi_available") {
    const blocked = corpusValue.cases.map((entry) => scoreCase(entry, {
      verdict: "inconclusive",
      finding_rules: [],
      runtime_identity: undefined,
      usage: { status: "unavailable" },
      error: readiness.reason,
      result_digest: sha256(readiness.reason),
    }));
    return aggregateScorecard(corpusValue, "live", blocked, {
      adapter_readiness: readiness.state,
      adapter_reason: readiness.reason,
      prompt_digest: sha256(corpusValue.cases.map(promptMaterial).join("\n")),
    });
  }

  const results = [];
  for (const [index, entry] of corpusValue.cases.entries()) {
    process.stderr.write(
      `[kimi-live ${index + 1}/${corpusValue.cases.length}] ${entry.case_id}\n`,
    );
    const result = scoreCase(entry, await invokeLiveCase(adapter, entry));
    results.push(result);
    process.stderr.write(
      `[kimi-live ${index + 1}/${corpusValue.cases.length}] observed=${result.observed_verdict} rules=${result.observed_finding_rules.join(",") || "none"}\n`,
    );
  }
  return aggregateScorecard(corpusValue, "live", results, {
    adapter_readiness: readiness.state,
    prompt_digest: sha256(corpusValue.cases.map(promptMaterial).join("\n")),
  });
}

async function invokeLiveCase(adapter, entry) {
  const runId = `kimi_eval_${entry.case_id.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
  const task = {
    run_id: runId,
    task_id: entry.case_id,
    session_id: "kimi-review-corpus-v1",
    capability_id: "kimi-code.code.review",
    prompt: "Review the bounded evaluation diff.",
    context: {
      kimi_review_input: {
        schema_version: 1,
        task: entry.task,
        evaluation_criteria: entry.evaluation_specs.map((spec) => ({
          id: spec.id,
          requirement: `${spec.description}\nAcceptance: ${spec.acceptance}`,
        })),
        changed_paths: changedPaths(entry.diff),
        diff: entry.diff,
        deterministic_results: [{
          command: "corpus-fixture-validation",
          exit_code: 0,
          summary: "Corpus schema and diff framing passed.",
        }],
        evidence_refs: changedPaths(entry.diff),
      },
    },
  };
  const events = [];
  try {
    for await (const event of adapter.invoke(
      task,
      new AbortController().signal,
    )) {
      events.push(event);
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      verdict: "inconclusive",
      finding_rules: [],
      runtime_identity: undefined,
      usage: { status: "unavailable" },
      error: detail,
      result_digest: sha256(detail),
    };
  }
  const done = [...events].reverse().find((event) => event.type === "done");
  const review = isRecord(done?.payload) && isRecord(done.payload.review)
    ? done.payload.review
    : undefined;
  if (review === undefined) {
    const errorEvent = [...events].reverse().find((event) => event.type === "error");
    const detail = isRecord(errorEvent?.payload)
      && typeof errorEvent.payload.message === "string"
      ? errorEvent.payload.message
      : "Kimi emitted no structured review";
    return {
      verdict: "inconclusive",
      finding_rules: [],
      runtime_identity: undefined,
      usage: { status: "unavailable" },
      error: detail,
      result_digest: sha256(JSON.stringify(events.map(eventDigestMaterial))),
    };
  }
  const findings = Array.isArray(review.findings)
    ? review.findings.filter(isRecord)
    : [];
  return {
    verdict: typeof review.verdict === "string"
      ? review.verdict
      : "inconclusive",
    finding_rules: findings
      .map((finding) => finding.rule_id)
      .filter((rule) => typeof rule === "string"),
    findings: findings.map((finding) => ({
      rule_id: stringOrUnknown(finding.rule_id),
      fingerprint: stringOrUnknown(finding.fingerprint),
      severity: stringOrUnknown(finding.severity),
      ...(typeof finding.file === "string" ? { file: finding.file } : {}),
      ...(typeof finding.line === "number" ? { line: finding.line } : {}),
    })),
    runtime_identity: isRecord(review.runtime_identity)
      ? review.runtime_identity
      : undefined,
    usage: { status: "unavailable" },
    result_digest: sha256(JSON.stringify(review)),
  };
}

function scoreCase(entry, observed) {
  const observedRules = new Set(observed.finding_rules);
  const missingRules = entry.expected_finding_rules.filter(
    (rule) => !observedRules.has(rule),
  );
  return {
    case_id: entry.case_id,
    expected_verdict: entry.expected_verdict,
    expected_finding_rules: entry.expected_finding_rules,
    observed_verdict: observed.verdict,
    observed_finding_rules: [...observedRules].sort(),
    false_pass: entry.expected_verdict !== "approved"
      && observed.verdict === "approved",
    false_alarm: entry.expected_verdict === "approved"
      && observed.verdict !== "approved",
    missing_finding_rules: missingRules,
    runtime_identity: observed.runtime_identity,
    usage: observed.usage,
    result_digest: observed.result_digest,
    ...(observed.findings === undefined ? {} : { findings: observed.findings }),
    ...(observed.error === undefined ? {} : { error: observed.error }),
  };
}

function aggregateScorecard(corpusValue, mode, results, metadata) {
  const falsePasses = results.filter((result) => result.false_pass);
  const falseAlarms = results.filter((result) => result.false_alarm);
  const ruleMisses = results.filter(
    (result) => result.missing_finding_rules.length > 0,
  );
  const providerFailures = results.filter(
    (result) => result.observed_verdict === "inconclusive",
  );
  const identityMismatches = mode === "live"
    ? results.filter((result) => (
        result.runtime_identity?.adapter_id !== "kimi-code"
        || result.runtime_identity?.provider_id !== "kimi"
        || typeof result.runtime_identity?.model_id !== "string"
      ))
    : [];
  return {
    schema_version: 1,
    kind: "osstack.kimi_review_scorecard",
    generated_at: new Date().toISOString(),
    mode,
    corpus_id: corpusValue.corpus_id,
    corpus_sha256: sha256(JSON.stringify(corpusValue)),
    case_count: results.length,
    false_pass_count: falsePasses.length,
    false_alarm_count: falseAlarms.length,
    rule_miss_count: ruleMisses.length,
    provider_failure_count: providerFailures.length,
    identity_mismatch_count: identityMismatches.length,
    gate_pass: falsePasses.length === 0
      && ruleMisses.length === 0
      && providerFailures.length === 0
      && identityMismatches.length === 0,
    false_pass_case_ids: falsePasses.map((result) => result.case_id),
    false_alarm_case_ids: falseAlarms.map((result) => result.case_id),
    rule_miss_case_ids: ruleMisses.map((result) => result.case_id),
    provider_failure_case_ids: providerFailures.map((result) => result.case_id),
    identity_mismatch_case_ids: identityMismatches.map(
      (result) => result.case_id,
    ),
    ...metadata,
    results,
  };
}

function deterministicOracle(diff) {
  const rules = [];
  const tests = [
    ["security.auth_constant_allow", /^\+\s*return true;/m],
    ["correctness.missing_null_guard", /^\+\s*return user\.profile\.name;/m],
    ["correctness.off_by_one", /^\+.*<=\s*items\.length/m],
    ["test.assertion_removed", /^-\s*expect\(result\)\.toBe\(false\);/m],
    ["security.hardcoded_credential", /^\+export const apiToken = "/m],
    ["security.sql_interpolation", /^\+.*db\.query\(`.*\$\{email\}/m],
    ["security.shell_injection", /^\+exec\(`.*\$\{target\}/m],
    ["security.path_traversal", /^\+\s*return join\(root, requested\);/m],
    ["release.proof_fail_open", /^\+\s*console\.warn\("invalid release proof"\);/m],
  ];
  for (const [rule, pattern] of tests) {
    if (pattern.test(diff)) rules.push(rule);
  }
  const blocking = rules.some((rule) => (
    rule === "security.hardcoded_credential"
    || rule === "release.proof_fail_open"
  ));
  return {
    verdict: rules.length === 0
      ? "approved"
      : blocking
        ? "blocked"
        : "changes_requested",
    findingRules: rules,
  };
}

function changedPaths(diff) {
  return [...new Set(
    [...diff.matchAll(/^\+\+\+ b\/(.+)$/gm)].map((match) => match[1]),
  )].sort();
}

function promptMaterial(entry) {
  return JSON.stringify({
    task: entry.task,
    diff: entry.diff,
    evaluation_specs: entry.evaluation_specs,
  });
}

function eventDigestMaterial(event) {
  return {
    type: event.type,
    terminal: event.terminal,
    payload: isRecord(event.payload)
      ? {
          status: event.payload.status,
          code: event.payload.code,
        }
      : undefined,
  };
}

function flagValue(values, name) {
  const index = values.indexOf(name);
  return index >= 0 ? values[index + 1] : undefined;
}

function requiredString(value, path) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${path} is required`);
  }
  return value;
}

function stringOrUnknown(value) {
  return typeof value === "string" ? value : "unknown";
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
