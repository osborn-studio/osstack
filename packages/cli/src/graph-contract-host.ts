import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from "node:fs";
import { mkdir, open } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { deliveryCheckReference } from "@osstack/core";
import { GraphBudget, GraphScope, workerCanonical } from "@osstack/protocol";
import type { LocalGraphRegistrationOptions } from "./graph-rpc.js";
import { persistDeliveryHostRecord } from "./delivery-contract-host.js";
import { osstackHome } from "./paths.js";

const digest = (bytes: string | Buffer) =>
  createHash("sha256").update(bytes).digest("hex");
/** Bound synchronous authority reads: no await between final check and Graph CAS. */
function readBounded(
  path: string,
  privateFile: boolean,
  optional = false,
): Buffer | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const before = fstatSync(fd);
    if (
      !before.isFile() ||
      before.size > 65536 ||
      (privateFile &&
        ((before.mode & 0o077) !== 0 || before.uid !== process.getuid?.()))
    )
      throw Error("GRAPH_HOST_FILE_INVALID");
    const buffer = Buffer.alloc(65537);
    let length = 0;
    while (length < buffer.length) {
      const count = readSync(
        fd,
        buffer,
        length,
        buffer.length - length,
        length,
      );
      if (!count) break;
      length += count;
    }
    const after = fstatSync(fd);
    const current = lstatSync(path);
    if (
      length > 65536 ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      current.isSymbolicLink() ||
      current.ino !== before.ino ||
      current.dev !== before.dev
    )
      throw Error("GRAPH_HOST_FILE_CHANGED");
    return buffer.subarray(0, length);
  } catch (error) {
    if (optional && (error as NodeJS.ErrnoException).code === "ENOENT")
      return undefined;
    throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
function overlayFingerprint(path: string): string {
  const bytes = readBounded(path, true, true);
  return bytes === undefined ? "missing" : `present:${digest(bytes)}`;
}
const hex = z.string().regex(/^[a-f0-9]{64}$/);
const graphPolicySchema = z
  .object({
    schema_version: z.literal(1),
    repo_path: z.string().refine(isAbsolute),
    scope: GraphScope,
    base_policy_digest: hex,
    review_policy_ref: z.string().min(1).max(256),
    limits: z.unknown(),
  })
  .strict();
function overlayPath(
  home: string,
  repository: string,
  revision: string,
): string {
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(revision))
    throw Error("GRAPH_CONTRACT_BASE_INVALID");
  const raw = execFileSync(
    "git",
    ["-C", repository, "show", `${revision}:.osstack/repo.yaml`],
    {
      encoding: "utf8",
      maxBuffer: 65536,
      timeout: 15000,
      env: {
        ...Object.fromEntries(
          Object.entries(process.env).filter(
            ([key]) => !key.startsWith("GIT_"),
          ),
        ),
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_NO_REPLACE_OBJECTS: "1",
        GIT_TERMINAL_PROMPT: "0",
      },
    },
  );
  const product = (parseYaml(raw) as { product?: unknown })?.product;
  const valid = (value: unknown): value is string =>
    typeof value === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
  const id = valid(product)
    ? product
    : valid(basename(repository))
      ? basename(repository)
      : `repo-${digest(repository).slice(0, 16)}`;
  return join(home, "repos", `${id}.yaml`);
}

/** Explicit local host authority; registration data alone cannot invent checks or budgets. */
export function createGraphContractHostResolvers(
  homePath: string,
): LocalGraphRegistrationOptions {
  if (!isAbsolute(homePath)) throw Error("GRAPH_HOST_HOME_REQUIRED");
  const home = realpathSync(homePath);
  return {
    resolveDeliveryContractPolicy: async ({
      repositoryPath,
      scope,
      contract,
    }) => {
      if (realpathSync(osstackHome()) !== home)
        throw Error("GRAPH_HOST_HOME_CHANGED");
      if (
        !isAbsolute(repositoryPath) ||
        realpathSync(repositoryPath) !== repositoryPath
      )
        throw Error("GRAPH_CONTRACT_REPOSITORY_INVALID");
      const path = join(home, "graph-policy.json");
      const bytes = readBounded(path, true)!;
      const config = graphPolicySchema.parse(
        JSON.parse(bytes.toString("utf8")),
      );
      const budget = GraphBudget.parse({
        ...(config.limits as object),
        schemaVersion: 1,
      });
      const { schemaVersion: _version, ...limits } = budget;
      if (
        config.repo_path !== repositoryPath ||
        workerCanonical(config.scope) !== workerCanonical(scope)
      )
        throw Error("GRAPH_CONTRACT_SCOPE_MISMATCH");
      const overlay = overlayPath(home, repositoryPath, contract.base_head);
      const overlayDigest = overlayFingerprint(overlay);
      const policyFileDigest = digest(bytes);
      const assertCurrent = () => {
        if (
          realpathSync(homePath) !== home ||
          realpathSync(osstackHome()) !== home ||
          realpathSync(repositoryPath) !== repositoryPath ||
          digest(readBounded(path, true)!) !== policyFileDigest ||
          overlayFingerprint(overlay) !== overlayDigest
        )
          throw Error("GRAPH_CONTRACT_POLICY_CHANGED");
      };
      // Reuse actual committed-base policy/overlay admission. This is a lazy Graph-only load.
      const { createDeliverCommandDeps } = await import("./bin.js");
      const policy = await createDeliverCommandDeps().deliveryContractPolicy!(
        repositoryPath,
        contract.base_head,
      );
      assertCurrent();
      if (
        policy.policyDigest !== config.base_policy_digest ||
        contract.policy_digest !== policy.policyDigest ||
        contract.review_policy_ref !== config.review_policy_ref ||
        contract.required_checks.some(
          (check) =>
            !policy.verifyCommands.some(
              (command) =>
                deliveryCheckReference(command) === check.registry_ref,
            ),
        )
      )
        throw Error("GRAPH_CONTRACT_POLICY_MISMATCH");
      return {
        policy: {
          policyDigest: policy.policyDigest,
          reviewPolicyRef: config.review_policy_ref,
          limits,
        },
        assertCurrent,
      };
    },
    resolveExecutionContext: async ({
      configPath,
      repositoryPath,
      scope,
      frozen,
    }) => {
      if (scope.tenantId !== "default")
        throw Error("GRAPH_CONTEXT_SCOPE_UNSUPPORTED");
      const repository = realpathSync(repositoryPath);
      const path = realpathSync(resolve(repository, configPath));
      const local = relative(repository, path);
      if (local.startsWith("..") || isAbsolute(local))
        throw Error("GRAPH_CONTEXT_SOURCE_ESCAPE");
      const configDigest = digest(readBounded(path, false)!);
      const {
        loadExecutionContextConfig,
        createPinnedLocalContextLoader,
        createExecutionContextAdapters,
      } = await import("./execution-context.js");
      const config = await loadExecutionContextConfig(configPath, repository);
      const assertCurrent = () => {
        if (
          realpathSync(repositoryPath) !== repository ||
          realpathSync(resolve(repository, configPath)) !== path ||
          digest(readBounded(path, false)!) !== configDigest
        )
          throw Error("GRAPH_CONTEXT_CONFIG_CHANGED");
      };
      assertCurrent();
      const receiptRoot = join(home, "graph-context-receipts", randomUUID());
      await mkdir(receiptRoot, { recursive: true, mode: 0o700 });
      assertCurrent();
      return {
        configDigest,
        receiptRoot,
        assertCurrent,
        create: async (input) => {
          assertCurrent();
          if (
            input.workspacePath !== repository ||
            input.frozen.digest !== frozen.digest
          )
            throw Error("GRAPH_CONTEXT_SCOPE_MISMATCH");
          const wrapped = createExecutionContextAdapters({
            adapters: [input.adapter],
            workspacePath: repository,
            mode: "local",
            loadContext: createPinnedLocalContextLoader(config),
            maxPromptBytes: config.max_prompt_bytes,
            maxKnowledgeBytes: config.max_knowledge_bytes,
            contractDigest: frozen.digest,
            contractBrief: frozen.brief,
            recordReceipt: async (receipt) => {
              assertCurrent();
              const ref = await persistDeliveryHostRecord(receiptRoot, receipt);
              assertCurrent();
              for (const target of [
                ref.path,
                receiptRoot,
                join(home, "graph-context-receipts"),
              ]) {
                const handle = await open(
                  target,
                  constants.O_RDONLY | constants.O_NOFOLLOW,
                );
                try {
                  await handle.sync();
                } finally {
                  await handle.close();
                }
                assertCurrent();
              }
              return ref;
            },
          });
          return {
            adapter: wrapped.adapters[0]!,
            receiptRefs: wrapped.receiptRefs,
          };
        },
      };
    },
  };
}
