import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, realpath, link, unlink } from "node:fs/promises";
import {
  dirname,
  isAbsolute,
  join,
  relative,
  basename,
  resolve,
} from "node:path";
import { promisify } from "node:util";
import {
  assertFrozenDeliveryContract,
  deliveryCheckReference,
  deliveryContractDigest,
  freezeDeliveryContract,
} from "@osstack/core";
import { z } from "zod";
import type { DeliverCommandDeps } from "./deliver-command.js";
import {
  deliveryBytesDigest,
  readDeliveryHostRecord,
} from "./delivery-contract-host.js";

const exec = promisify(execFile);
const safeId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/);
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const pathSchema = z
  .string()
  .min(1)
  .max(1024)
  .refine(
    (p) =>
      !p.startsWith("-") &&
      !isAbsolute(p) &&
      !p.includes("\\") &&
      [...p].every((c) => c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127) &&
      p.split("/").every((c) => c !== "." && c !== ".." && c !== ""),
  );
const inspectSchema = z
  .object({
    repo: z.string().min(1).max(4096),
    goal: z.string().min(1).max(16000),
    paths: z.array(pathSchema).min(1).max(16),
    profile: safeId,
    requestId: safeId,
  })
  .strict();
type InspectInput = z.infer<typeof inspectSchema>;
type Policy = NonNullable<DeliverCommandDeps["deliveryContractPolicy"]>;
interface ScoutHostOptions {
  home: string;
  policy: Policy;
  deliver?: (
    args: string[],
    emitJson: (value: unknown) => void,
  ) => Promise<number>;
}
interface ScoutRecord {
  schemaVersion: 1;
  kind: "scout";
  tools: ["git_committed_blob_read"];
  requestId: string;
  profile: string;
  contract: ReturnType<typeof freezeDeliveryContract>;
  facts: Array<{
    path: string;
    blob: string;
    bytes: number;
    sha256: string;
    text: string;
  }>;
  qualification: "committed_source_investigation_not_code_delivery";
}
/** Fixed read operations only. No model, shell, mutable file read, checkout, filter or check command is exposed. */
async function gitRead(
  repo: string,
  args: string[],
  maxBuffer = 262144,
): Promise<Buffer> {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "SYSTEMROOT", "TMPDIR"])
    if (process.env[key]) environment[key] = process.env[key];
  const result = await exec(
    "git",
    [
      "--no-replace-objects",
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "core.fsmonitor=false",
      ...args,
    ],
    {
      cwd: repo,
      timeout: 5000,
      maxBuffer,
      encoding: "buffer",
      env: {
        ...environment,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_TERMINAL_PROMPT: "0",
        GIT_OPTIONAL_LOCKS: "0",
      },
    },
  );
  return result.stdout;
}
async function headOf(repo: string): Promise<string> {
  const head = (await gitRead(repo, ["rev-parse", "--verify", "HEAD^{commit}"]))
    .toString()
    .trim();
  if (!/^[a-f0-9]{40,64}$/.test(head)) throw Error("scout_invalid_head");
  return head;
}
async function privateDirectory(path: string): Promise<string> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const canonical = await realpath(path);
  const info = await lstat(path);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (info.mode & 0o077) !== 0 ||
    (process.getuid && info.uid !== process.getuid())
  )
    throw Error("scout_private_state_required");
  return canonical;
}
async function createOnly(path: string, body: string): Promise<void> {
  const temporary = join(dirname(path), `.scout-${randomUUID()}.tmp`);
  const file = await open(
    temporary,
    constants.O_CREAT |
      constants.O_EXCL |
      constants.O_WRONLY |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await file.writeFile(body);
    await file.sync();
    await link(temporary, path);
    const directory = await open(dirname(path), constants.O_RDONLY);
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    await file.close();
    await unlink(temporary);
  }
}
async function prospectivePath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const parent = dirname(path);
    if (parent === path) throw error;
    return join(await prospectivePath(parent), basename(path));
  }
}
function outsideRepository(repo: string, target: string): void {
  const rel = relative(repo, target);
  if (
    rel === "" ||
    (!rel.startsWith("../") && rel !== ".." && !isAbsolute(rel))
  )
    throw Error("scout_state_must_be_outside_repository");
}
export function createScoutHost(options: ScoutHostOptions) {
  const stateRoot = async () => {
    if (!isAbsolute(options.home)) throw Error("scout_absolute_home_required");
    const home = await privateDirectory(options.home);
    return privateDirectory(join(home, "scout"));
  };
  const store = async (value: unknown) => {
    const root = await stateRoot();
    const body = JSON.stringify(value) + "\n";
    const digest = deliveryBytesDigest(body);
    const path = join(root, `${digest}.json`);
    try {
      await createOnly(path, body);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      await readDeliveryHostRecord(root, { path, digest });
    }
    return { path, digest };
  };
  const read = async (digest: string): Promise<ScoutRecord> => {
    digestSchema.parse(digest);
    const root = await stateRoot();
    const raw = (await readDeliveryHostRecord(root, {
      path: join(root, `${digest}.json`),
      digest,
    })) as ScoutRecord;
    if (
      raw.schemaVersion !== 1 ||
      raw.kind !== "scout" ||
      raw.qualification !==
        "committed_source_investigation_not_code_delivery" ||
      raw.tools?.length !== 1 ||
      raw.tools[0] !== "git_committed_blob_read"
    )
      throw Error("scout_record_invalid");
    const frozen = assertFrozenDeliveryContract(raw.contract);
    if (frozen.contract.mode !== "scout") throw Error("scout_record_invalid");
    safeId.parse(raw.profile);
    return raw;
  };
  return {
    async inspect(value: InspectInput) {
      const input = inspectSchema.parse(value);
      const repo = await realpath(input.repo);
      if (
        (await realpath(
          (
            await gitRead(repo, ["rev-parse", "--show-toplevel"])
          )
            .toString()
            .trim(),
        )) !== repo
      )
        throw Error("scout_repository_root_required");
      outsideRepository(repo, await prospectivePath(resolve(options.home)));
      const root = await stateRoot();
      outsideRepository(repo, root);
      const head = await headOf(repo);
      const policy = await options.policy(repo, head);
      if (policy.budgetRef !== `policy:${policy.policyDigest}`)
        throw Error("scout_policy_invalid");
      const paths = [...new Set(input.paths)].sort();
      const facts: ScoutRecord["facts"] = [];
      let bytes = 0;
      for (const path of paths) {
        const entry = (
          await gitRead(repo, ["ls-tree", "-z", head, "--", path])
        ).toString();
        const match =
          /^(100644|100755) blob ([a-f0-9]{40,64})\t([^\0]+)\0$/.exec(entry);
        if (!match || match[3] !== path)
          throw Error("scout_regular_committed_file_required");
        const blob = match[2]!;
        const size = Number(
          (await gitRead(repo, ["cat-file", "-s", blob])).toString().trim(),
        );
        bytes += size;
        if (
          !Number.isSafeInteger(size) ||
          size < 0 ||
          size > 65536 ||
          bytes > 262144
        )
          throw Error("scout_source_budget_exceeded");
        const content = await gitRead(repo, ["cat-file", "blob", blob], 65537);
        if (content.length !== size || content.includes(0))
          throw Error("scout_source_invalid");
        const text = content.toString("utf8");
        if (!Buffer.from(text).equals(content))
          throw Error("scout_utf8_required");
        facts.push({
          path,
          blob,
          bytes: size,
          sha256: deliveryBytesDigest(content),
          text,
        });
      }
      if ((await headOf(repo)) !== head) throw Error("scout_head_changed");
      const currentPolicy = await options.policy(repo, head);
      if (
        deliveryContractDigest(currentPolicy) !== deliveryContractDigest(policy)
      )
        throw Error("scout_policy_changed");
      const contract = freezeDeliveryContract({
        schema_version: 2,
        contract_id: `scout-${input.requestId}`,
        task_id: `scout-${input.requestId}`,
        canonical_repo: repo,
        mode: "scout",
        base_head: head,
        goal: input.goal,
        required_checks: policy.verifyCommands.map((command, index) => ({
          id: `host-${index}`,
          registry_ref: deliveryCheckReference(command),
        })),
        review_policy_ref: `profile:${input.profile}`,
        requested_completion: "local_verified",
        allowed_paths: paths,
        requested_actions: ["verify"],
        budget_ref: policy.budgetRef,
        policy_digest: policy.policyDigest,
        publication_scope: { mode: "none" },
        merge_authority: { mode: "none" },
      });
      const record: ScoutRecord = {
        schemaVersion: 1,
        kind: "scout",
        tools: ["git_committed_blob_read"],
        requestId: input.requestId,
        profile: input.profile,
        contract,
        facts,
        qualification: "committed_source_investigation_not_code_delivery",
      };
      const saved = await store(record);
      const requestPath = join(
        root,
        `inspect-${deliveryContractDigest([repo, input.requestId])}.json`,
      );
      try {
        await createOnly(
          requestPath,
          JSON.stringify({ digest: saved.digest }) + "\n",
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const file = await open(
          requestPath,
          constants.O_RDONLY | constants.O_NOFOLLOW,
        );
        try {
          const stat = await file.stat();
          if (
            !stat.isFile() ||
            stat.size > 128 ||
            JSON.parse(
              (
                await file.read({
                  buffer: Buffer.alloc(129),
                  length: 129,
                  position: 0,
                })
              ).buffer
                .toString("utf8")
                .replace(/\0+$/, ""),
            ).digest !== saved.digest
          )
            throw Error("scout_request_conflict");
        } finally {
          await file.close();
        }
      }
      return { ...record, ...saved };
    },
    async promote(value: { digest: string; requestId: string }) {
      const input = z
        .object({ digest: digestSchema, requestId: safeId })
        .strict()
        .parse(value);
      if (!options.deliver) throw Error("scout_delivery_host_required");
      const parent = await read(input.digest);
      const repo = await realpath(parent.contract.contract.canonical_repo);
      const head = await headOf(repo);
      const policy = await options.policy(repo, head);
      const frozen = freezeDeliveryContract({
        ...parent.contract.contract,
        contract_id: `implement-${deliveryContractDigest([input.digest, input.requestId]).slice(0, 48)}`,
        task_id: `implement-${deliveryContractDigest([input.digest, input.requestId]).slice(0, 48)}`,
        parent_contract_id: parent.contract.contract.contract_id,
        mode: "implement",
        base_head: head,
        policy_digest: policy.policyDigest,
        budget_ref: policy.budgetRef,
        required_checks: policy.verifyCommands.map((command, index) => ({
          id: `host-${index}`,
          registry_ref: deliveryCheckReference(command),
        })),
        requested_actions: ["build", "verify"],
      });
      const contractFile = await store(frozen.contract);
      const root = await stateRoot();
      const claim = join(
        root,
        `promotion-${deliveryContractDigest([repo, input.digest])}.json`,
      );
      try {
        await createOnly(
          claim,
          JSON.stringify({
            state: "started",
            requestId: input.requestId,
            parent: input.digest,
            contractDigest: frozen.digest,
            baseHead: head,
          }) + "\n",
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST")
          throw Error("scout_promotion_already_claimed_reconcile");
        throw error;
      }
      // This performs all normal fresh profile/risk/policy/worktree/check/review admission. Old scout facts grant nothing.
      let deliveryResult: unknown;
      const exitCode = await options.deliver(
        [
          "--workspace",
          repo,
          "--autonomy",
          "guarded-local",
          "--profile",
          parent.profile,
          "--contract",
          contractFile.path,
          "--max-iter",
          String(
            Math.min(
              policy.budget.max_builder_iterations,
              policy.budget.max_review_rounds,
            ),
          ),
          "--json",
        ],
        (value) => {
          deliveryResult = value;
        },
      );
      if (exitCode === 0) {
        const summary = z
          .object({
            delivery_contract: z
              .object({
                digest: digestSchema,
                achieved_completion: z.literal("local_verified"),
              })
              .passthrough(),
          })
          .passthrough()
          .parse(deliveryResult);
        if (summary.delivery_contract.digest !== frozen.digest)
          throw Error("scout_delivery_result_mismatch");
      }
      const result = {
        ...(deliveryResult === undefined
          ? {}
          : { deliveryResultDigest: deliveryContractDigest(deliveryResult) }),
        state: exitCode === 0 ? ("completed" as const) : ("failed" as const),
        exitCode,
        parentDigest: input.digest,
        contractDigest: frozen.digest,
        claim,
      };
      const receipt = await store(result);
      await createOnly(
        join(root, `promotion-result-${input.digest}.json`),
        JSON.stringify(receipt) + "\n",
      );
      return {
        ...result,
        ...receipt,
        ...(deliveryResult === undefined ? {} : { deliveryResult }),
      };
    },
  };
}
function terminalJson(value: unknown): string {
  return JSON.stringify(value, null, 2).replace(/[\u007f-\u009f\u2028\u2029\p{Cf}]/gu, character =>
    character.split("").map(unit => `\\u${unit.charCodeAt(0).toString(16).padStart(4, "0")}`).join(""),
  );
}
async function handleScoutCommandUnchecked(
  args: string[],
  options: ScoutHostOptions,
  stdout: (line: string) => void = console.log,
): Promise<number> {
  if (args.includes("--help") || args[0] === "help") {
    stdout(
      "osstack scout inspect --repo PATH --goal TEXT --path FILE [--path FILE] --profile NAME --request-id ID\nosstack scout promote --scout DIGEST --request-id ID\nInspect reads bounded committed files only. Promote explicitly starts fresh guarded-local delivery; it never inherits approval or publishes.",
    );
    return 0;
  }
  const flags = new Map<string, string>();
  const paths: string[] = [];
  for (let i = 1; i < args.length; i++) {
    const key = args[i]!;
    if (key === "--json") continue;
    const value = args[++i];
    if (!value || value.startsWith("--"))
      throw Error("scout_invalid_arguments");
    if (key === "--path") {
      paths.push(value);
      continue;
    }
    if (
      !["--repo", "--goal", "--profile", "--request-id", "--scout"].includes(
        key,
      ) ||
      flags.has(key)
    )
      throw Error("scout_invalid_arguments");
    flags.set(key, value);
  }
  const host = createScoutHost(options);
  if (args[0] === "inspect") {
    if (flags.has("--scout")) throw Error("scout_invalid_arguments");
    const result = await host.inspect({
      repo: flags.get("--repo")!,
      goal: flags.get("--goal")!,
      paths,
      profile: flags.get("--profile")!,
      requestId: flags.get("--request-id")!,
    });
    stdout(terminalJson(result));
    return 0;
  }
  if (args[0] === "promote") {
    if (
      paths.length ||
      ["--repo", "--goal", "--profile"].some((key) => flags.has(key))
    )
      throw Error("scout_invalid_arguments");
    const result = await host.promote({
      digest: flags.get("--scout")!,
      requestId: flags.get("--request-id")!,
    });
    stdout(terminalJson(result));
    return result.exitCode;
  }
  throw Error("scout_subcommand_required");
}

/** CLI errors must not echo repository-controlled paths, subprocess output or text. */
export async function handleScoutCommand(
  args: string[],
  options: ScoutHostOptions,
  stdout: (line: string) => void = console.log,
): Promise<number> {
  try {
    return await handleScoutCommandUnchecked(args, options, stdout);
  } catch (error) {
    const code = error instanceof Error && /^scout_[a-z_]{1,80}$/.test(error.message)
      ? error.message : "scout_request_failed";
    throw new Error(code);
  }
}
