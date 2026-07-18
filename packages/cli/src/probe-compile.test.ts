import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ProbeCompileFileError,
  createProbeCompilerEnvironment,
  readProbeCompilationBatch,
  verifyProbeCompilationDelta,
  writeProbeCompilationDelta,
} from "./probe-compile.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function repo() {
  const root = await mkdtemp(join(tmpdir(), "osstack-probe-compile-"));
  temporaryDirectories.push(root);
  await mkdir(join(root, "packages", "core"), { recursive: true });
  await writeFile(
    join(root, "packages", "core", "package.json"),
    JSON.stringify({ scripts: { test: "vitest run" } }),
    "utf8",
  );
  return root;
}

function delta() {
  return {
    schema_version: "1" as const,
    session_id: "probe_12345678",
    exported_revision: 2,
    generated_at_ms: 3,
    spec_ref: "docs/probe/evaluations/probe_12345678-r2.json",
    evaluations: [],
    compilations: [
      {
        item_id: "pi_12345678",
        template_id: "manual-acceptance.v1" as const,
        compilation: {
          state: "manual_required" as const,
          reason: "Human review is required.",
        },
        manual_acceptance: "A human confirms the artifact.",
        evaluation_ids: [],
      },
    ],
  };
}

describe("probe compiler filesystem boundary", () => {
  it("recognizes only existing package scripts and contained artifact paths", async () => {
    const root = await repo();
    const environment = createProbeCompilerEnvironment(root);
    await expect(
      environment.verify_package_script("packages/core", "test"),
    ).resolves.toBeUndefined();
    await expect(
      environment.verify_package_script("packages/core", "release"),
    ).rejects.toThrow("not registered");
    await expect(
      environment.verify_artifact_path("docs/result.json"),
    ).resolves.toBeUndefined();
    await expect(
      environment.verify_artifact_path("../outside.json"),
    ).rejects.toBeInstanceOf(ProbeCompileFileError);
  });

  it("loads strict requests and writes immutable canonical deltas", async () => {
    const root = await repo();
    const batch = {
      schema_version: "1",
      requests: [
        {
          item_id: "pi_12345678",
          template_id: "manual-acceptance.v1",
          params: { acceptance: "Human review.", reason: "Visual quality." },
        },
      ],
    };
    await writeFile(join(root, "requests.json"), JSON.stringify(batch), "utf8");
    await expect(
      readProbeCompilationBatch(root, "requests.json"),
    ).resolves.toMatchObject(batch);

    const written = await writeProbeCompilationDelta(
      root,
      delta().spec_ref,
      delta(),
      ["requests.json"],
    );
    expect(written.created).toBe(true);
    await expect(
      verifyProbeCompilationDelta(root, written.portable_path, written.sha256),
    ).resolves.toEqual(delta());
    await expect(
      writeProbeCompilationDelta(root, delta().spec_ref, delta(), ["requests.json"]),
    ).resolves.toMatchObject({ created: false, sha256: written.sha256 });

    await writeFile(
      join(root, delta().spec_ref),
      `${await readFile(join(root, delta().spec_ref), "utf8")} `,
      "utf8",
    );
    await expect(
      verifyProbeCompilationDelta(root, written.portable_path, written.sha256),
    ).rejects.toThrow("modified");
  });
});
