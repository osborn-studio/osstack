import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ProbeGateInputError,
  loadProbeGatePolicy,
} from "./probe-gate.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function repo() {
  const path = await mkdtemp(join(tmpdir(), "osstack-probe-gate-"));
  temporaryDirectories.push(path);
  return path;
}

describe("probe gate filesystem inputs", () => {
  it("uses report defaults only when the default config is absent", async () => {
    const root = await repo();
    await expect(loadProbeGatePolicy(root)).resolves.toMatchObject({
      source: "built_in",
      policy: {
        schema_version: 1,
        enforcement: "report",
        budgets: { quick: 8, standard: 20, deep: 40 },
      },
    });
    await expect(
      loadProbeGatePolicy(root, "config/missing.yaml"),
    ).rejects.toBeInstanceOf(ProbeGateInputError);
  });

  it("loads a strict repository policy and rejects an invalid existing config", async () => {
    const root = await repo();
    await mkdir(join(root, ".osstack"), { recursive: true });
    await writeFile(
      join(root, ".osstack", "probe.yaml"),
      "schema_version: 1\nenforcement: block\nbudgets:\n  quick: 3\n  standard: 12\n  deep: 30\n",
      "utf8",
    );
    await expect(loadProbeGatePolicy(root)).resolves.toMatchObject({
      source: ".osstack/probe.yaml",
      policy: {
        enforcement: "block",
        budgets: { quick: 3, standard: 12, deep: 30 },
      },
    });

    await writeFile(
      join(root, ".osstack", "probe.yaml"),
      "schema_version: 2\nenforcement: silent\n",
      "utf8",
    );
    await expect(loadProbeGatePolicy(root)).rejects.toBeInstanceOf(
      ProbeGateInputError,
    );
  });
});
