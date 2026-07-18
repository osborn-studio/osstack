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
import { createProbeRenderBundle } from "@osstack/governance";
import { afterEach, describe, expect, it } from "vitest";
import {
  ProbeRenderWriteError,
  readProbeRenderDirectory,
  writeProbeRenderBundle,
} from "./probe-render.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function fixture() {
  const repo = await mkdtemp(join(tmpdir(), "osstack-probe-render-"));
  temporaryDirectories.push(repo);
  const bundle = createProbeRenderBundle({
    state: {
      session: {
        schema_version: "1",
        session_id: "probe_writer01",
        repo_id: "render-fixture",
        worktree_state: "not_git",
        input_refs: [],
        doc_types: ["tech"],
        question_pack_refs: [],
        selected_question_ids: [],
        unselected_required_question_ids: [],
        depth: "quick",
        question_budget: 1,
        questions_presented: 0,
        revision: 1,
        created_at_ms: 1,
        updated_at_ms: 1,
        state: "abandoned",
        abandoned_at_ms: 1,
        reason: "Fixture",
      },
      items: [],
    },
    events: [
      {
        schema_version: "1",
        event_id: "pe_writer001",
        session_id: "probe_writer01",
        revision: 1,
        type: "session_abandoned",
        actor: { type: "human", id: "owner" },
        idempotency_key: "fixture",
        occurred_at_ms: 1,
        payload: {},
      },
    ],
    exported_at_ms: 2,
    generator_version: "0.10.0",
    targets: ["ledger"],
  });
  return { repo, bundle };
}

describe("probe manifest-last filesystem writer", () => {
  it("writes and verifies a same-session portable artifact directory", async () => {
    const { repo, bundle } = await fixture();
    const result = await writeProbeRenderBundle({
      repo_root: repo,
      out_dir: "docs/probe/sessions/probe_writer01",
      bundle,
      protected_input_paths: [],
    });

    expect(result.out_dir).toBe(
      join(repo, "docs/probe/sessions/probe_writer01"),
    );
    await expect(
      readFile(join(result.out_dir, "render-manifest.json"), "utf8"),
    ).resolves.toBe(bundle.manifest_content);
    expect((await readProbeRenderDirectory(result.out_dir)).ledger).toEqual(
      bundle.ledger,
    );

    await expect(
      writeProbeRenderBundle({
        repo_root: repo,
        out_dir: "docs/probe/sessions/probe_writer01",
        bundle,
        protected_input_paths: [],
      }),
    ).resolves.toMatchObject({ out_dir: result.out_dir });
  });

  it("recovers an equal half-set after a crash before the manifest commit", async () => {
    const { repo, bundle } = await fixture();
    const input = {
      repo_root: repo,
      out_dir: "docs/probe/sessions/probe_writer01",
      bundle,
      protected_input_paths: [],
    };

    await expect(
      writeProbeRenderBundle({
        ...input,
        before_manifest: async () => {
          throw new Error("simulated crash");
        },
      }),
    ).rejects.toThrow("simulated crash");
    await expect(
      readFile(
        join(repo, input.out_dir, "render-manifest.json"),
        "utf8",
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });

    await expect(writeProbeRenderBundle(input)).resolves.toBeDefined();
    await expect(
      readProbeRenderDirectory(join(repo, input.out_dir)),
    ).resolves.toMatchObject({ ledger: bundle.ledger });
  });

  it("recovers a rerender when the old manifest observes the new file set", async () => {
    const { repo, bundle } = await fixture();
    const outDir = "docs/probe/sessions/probe_writer01";
    await writeProbeRenderBundle({
      repo_root: repo,
      out_dir: outDir,
      bundle,
      protected_input_paths: [],
    });
    const rerendered = createProbeRenderBundle({
      state: { session: bundle.ledger.session, items: bundle.ledger.items },
      events: bundle.ledger.events,
      exported_at_ms: 3,
      generator_version: "0.10.0",
      targets: ["ledger"],
    });
    const rerenderInput = {
      repo_root: repo,
      out_dir: outDir,
      bundle: rerendered,
      protected_input_paths: [],
    };

    await expect(
      writeProbeRenderBundle({
        ...rerenderInput,
        before_manifest: async () => {
          throw new Error("rerender crash");
        },
      }),
    ).rejects.toThrow("rerender crash");
    await expect(readProbeRenderDirectory(join(repo, outDir))).rejects.toThrow();
    await expect(writeProbeRenderBundle(rerenderInput)).resolves.toBeDefined();
    expect((await readProbeRenderDirectory(join(repo, outDir))).ledger).toEqual(
      rerendered.ledger,
    );
  });

  it("rejects manual edits, path escape, forbidden roots, and symlink escape", async () => {
    const { repo, bundle } = await fixture();
    const out = "docs/probe/sessions/probe_writer01";
    await writeProbeRenderBundle({
      repo_root: repo,
      out_dir: out,
      bundle,
      protected_input_paths: [],
    });
    await writeFile(join(repo, out, "ledger.md"), "manual edit\n", "utf8");
    await expect(
      writeProbeRenderBundle({
        repo_root: repo,
        out_dir: out,
        bundle,
        protected_input_paths: [],
      }),
    ).rejects.toBeInstanceOf(ProbeRenderWriteError);

    await expect(
      writeProbeRenderBundle({
        repo_root: repo,
        out_dir: "../escape",
        bundle,
        protected_input_paths: [],
      }),
    ).rejects.toBeInstanceOf(ProbeRenderWriteError);
    await expect(
      writeProbeRenderBundle({
        repo_root: repo,
        out_dir: ".osstack/probe",
        bundle,
        protected_input_paths: [],
      }),
    ).rejects.toBeInstanceOf(ProbeRenderWriteError);

    const outside = await mkdtemp(join(tmpdir(), "osstack-probe-outside-"));
    temporaryDirectories.push(outside);
    await mkdir(join(repo, "linked"), { recursive: true });
    await symlink(outside, join(repo, "linked", "outside"));
    await expect(
      writeProbeRenderBundle({
        repo_root: repo,
        out_dir: "linked/outside/render",
        bundle,
        protected_input_paths: [],
      }),
    ).rejects.toBeInstanceOf(ProbeRenderWriteError);
  });
});
