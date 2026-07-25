import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeSha256 } from "@osstack/governance";
import { afterEach, describe, expect, it } from "vitest";
import {
  ProbeDynamicFileError,
  readProbeQuestionBatch,
  verifyProbeDynamicEvidence,
  verifyProbeRestatementEvidence,
} from "./probe-dynamic.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function repo() {
  const root = await mkdtemp(join(tmpdir(), "osstack-probe-dynamic-"));
  temporaryDirectories.push(root);
  await mkdir(join(root, "docs"), { recursive: true });
  return root;
}

describe("probe dynamic filesystem validation", () => {
  it("requires repository-contained evidence with a matching hash", async () => {
    const root = await repo();
    const content = Buffer.from("# Spec\nRollback is mandatory.\n", "utf8");
    await writeFile(join(root, "docs", "spec.md"), content);
    await expect(
      verifyProbeDynamicEvidence(root, {
        kind: "file",
        ref: "docs/spec.md",
        sha256: probeSha256(content),
      }),
    ).resolves.toEqual({ verifiable: true });
    await expect(
      verifyProbeDynamicEvidence(root, {
        kind: "file",
        ref: "docs/spec.md",
        sha256: "a".repeat(64),
      }),
    ).rejects.toThrow("hash mismatch");

    const outside = join(root, "..", `outside-${Date.now()}.md`);
    await writeFile(outside, "outside", "utf8");
    try {
      await symlink(outside, join(root, "docs", "escaped.md"));
      await expect(
        verifyProbeDynamicEvidence(root, {
          kind: "file",
          ref: "docs/escaped.md",
          sha256: probeSha256("outside"),
        }),
      ).rejects.toBeInstanceOf(ProbeDynamicFileError);
    } finally {
      await rm(outside, { force: true });
    }
  });

  it("loads only strict repository-bound question batches", async () => {
    const root = await repo();
    const fixture = new URL(
      "../../governance/fixtures/probe/valid/question-batch-v1.valid.json",
      import.meta.url,
    );
    await writeFile(
      join(root, "batch.json"),
      await readFile(fixture),
    );
    await expect(readProbeQuestionBatch(root, "batch.json")).resolves.toMatchObject({
      schema_version: "1",
      origin: "blindspot",
    });
    await expect(
      readProbeQuestionBatch(root, "../batch.json"),
    ).rejects.toBeInstanceOf(ProbeDynamicFileError);
  });

  it("binds every restatement evidence location to the supplied files", () => {
    const spec = Buffer.from("# Spec\nRollback is mandatory.\n", "utf8");
    const restatement = Buffer.from("# Restatement\nShip safely.\n", "utf8");
    const findings = [
      {
        schema_version: "1" as const,
        finding_id: "prf_12345678",
        kind: "omitted" as const,
        spec_evidence: {
          sha256: probeSha256(spec),
          path: "docs/spec.md",
          line: 2,
          anchor: "Rollback",
        },
        restatement_evidence: null,
        explanation: "Rollback needs owner confirmation.",
        proposed_question: "Which rollback guarantee must be preserved?",
        impact: 3 as const,
        irreversibility: 3 as const,
        uncertainty: 2 as const,
        destination_hint: "technical_design" as const,
      },
    ];
    expect(
      verifyProbeRestatementEvidence(
        findings,
        {
          label: "spec",
          content: spec,
          repo_relative_path: "docs/spec.md",
        },
        {
          label: "restatement",
          content: restatement,
          repo_relative_path: "docs/restatement.md",
        },
      ),
    ).toEqual([
      [
        expect.objectContaining({
          kind: "file",
          ref: "docs/spec.md",
          sha256: probeSha256(spec),
          line: 2,
        }),
      ],
    ]);
    expect(() =>
      verifyProbeRestatementEvidence(
        [
          {
            ...findings[0]!,
            spec_evidence: {
              ...findings[0]!.spec_evidence!,
              sha256: "0".repeat(64),
            },
          },
        ],
        {
          label: "spec",
          content: spec,
          repo_relative_path: "docs/spec.md",
        },
        { label: "restatement", content: restatement },
      ),
    ).toThrow("hash does not match");
  });
});
