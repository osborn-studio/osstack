import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  blindExternalDiffsV1,
  runExternalParityCaseV1,
  validateExternalAdapterMatrixV1,
  type ExternalParityAdapterV1,
} from "./runner.js";
import { ParityProtocolV1 } from "./types.js";

const created: string[] = [];

afterEach(async () => {
  await Promise.all(created.splice(0).map((path) =>
    rm(path, { recursive: true, force: true })
  ));
});

describe("isolated parity runner", () => {
  it("requires a complete, budget-matched A/B model matrix", async () => {
    const protocol = ParityProtocolV1.parse(JSON.parse(await readFile(
      resolve(process.cwd(), "../../eval/neat-parity/protocol-v1.json"),
      "utf8",
    )));
    const frozen = ParityProtocolV1.parse({
      ...protocol,
      status: "frozen",
      primary_model_id: "primary-v1",
      secondary_model_id: "secondary-v1",
      hidden_bundle_sha256: "a".repeat(64),
    });
    const adapter = (
      arm: "A" | "B",
      family: "primary" | "secondary",
    ): ExternalParityAdapterV1 => ({
      schema_version: "1",
      adapter_id: `${arm}-${family}`,
      arm,
      model_family: family,
      model_id: family === "primary" ? "primary-v1" : "secondary-v1",
      executable: process.execPath,
      args: [],
      env_allowlist: [],
      budget: { ...frozen.budgets },
      isolation: {
        kind: "container_network_none",
        profile_sha256: "b".repeat(64),
        attested_by: "independent-runner",
      },
    });
    const adapters = [adapter("A", "primary"), adapter("B", "primary"), adapter("A", "secondary"), adapter("B", "secondary")];
    expect(validateExternalAdapterMatrixV1(adapters, frozen).size).toBe(4);
    expect(() => validateExternalAdapterMatrixV1(adapters.slice(1), frozen)).toThrow("missing external adapter");
    expect(() => validateExternalAdapterMatrixV1([
      { ...adapters[0]!, model_id: "substituted-model" },
      ...adapters.slice(1),
    ], frozen)).toThrow("model mismatch");
  });

  it("produces deterministic arm-free diff packets and a separate private key", () => {
    const run = (arm: "A" | "B") => ({
      arm,
      case_id: "hidden-001",
      run_id: `${arm}-hidden-001-primary-1`,
      repetition: 1,
      model_family: "primary" as const,
      detected_defect_ids: [],
      false_positive_ids: [],
      finding_keys: [],
      failure: false,
      tokens: 1,
      calls: 1,
      wall_clock_ms: 1,
    });
    const result = {
      schema_version: "1" as const,
      bundle_id: "hidden-v1",
      runs: [run("A"), run("B")],
      artifacts: ["A", "B"].map((arm) => ({
        run_id: `${arm}-hidden-001-primary-1`,
        coverage: [],
        rejection_counts: {},
        diff: `${arm} diff`,
      })),
    };
    const first = blindExternalDiffsV1(result, 20260718);
    const second = blindExternalDiffsV1(result, 20260718);
    expect(first).toEqual(second);
    expect(first.packet.pairs).toHaveLength(1);
    expect(JSON.stringify(first.packet)).not.toContain('"arm"');
    expect(first.key.pairs[0]).toEqual(expect.objectContaining({ left_arm: expect.any(String) }));
  });

  it("uses argv without a shell, strips ambient env, and requires B edit receipts", async () => {
    const root = await mkdtemp(join(tmpdir(), "osstack-neat-eval-runner-"));
    created.push(root);
    const rot = join(root, "rot");
    await mkdir(rot);
    await writeFile(join(rot, "AGENTS.md"), "rules\n");
    const baseline = join(root, "SKILL.md");
    await writeFile(baseline, "baseline\n");
    const adapter = join(root, "adapter.mjs");
    await writeFile(adapter, [
      "const output = {",
      '  schema_version: "1", findings: [{ finding_key: "narrative:AGENTS.md", dimension: "narrative", paths: ["AGENTS.md"] }],',
      '  coverage: [{ dimension: "narrative", status: "complete" }], rejection_counts: {},',
      '  tokens: 1, calls: 1, plan: "delete session history", diff: "patch",',
      "};",
      "process.stdout.write(JSON.stringify(output));",
      "",
    ].join("\n"));
    await chmod(adapter, 0o755);
    await expect(runExternalParityCaseV1({
      adapter: {
        schema_version: "1",
        adapter_id: "fake",
        arm: "B",
        model_family: "primary",
        model_id: "fake-model",
        executable: process.execPath,
        args: [adapter, "{request}"],
        env_allowlist: [],
        budget: {
          max_input_tokens: 10,
          max_output_tokens: 10,
          max_calls: 1,
          max_wall_clock_ms: 5_000,
        },
        isolation: {
          kind: "container_network_none",
          profile_sha256: "a".repeat(64),
          attested_by: "independent-runner",
        },
      },
      case_id: "case-001",
      rot_root: rot,
      baseline_path: baseline,
      repetition: 1,
    })).rejects.toThrow("approval receipt");
  });
});
