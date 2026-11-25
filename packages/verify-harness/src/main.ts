import { mkdir, open, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { loadInstalledVerificationProfile, prepareContainedProfileImage, runPreparedContainedProfile } from "@osstack/agents/contained-profile";
import { parseHarnessConfig } from "./config.js";
import { createPullRequestPort } from "./github-read.js";
import { runHarness, type HarnessPorts } from "./run.js";
import { createGitSource } from "./source.js";

export interface MainIo {
  fetchImpl: typeof fetch;
  now: () => Date;
  uuid: () => string;
  stdout: (line: string) => void;
  getuid: () => number;
  ports?: Partial<HarnessPorts>;
}

function parseArgs(argv: readonly string[]) {
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i]!;
    const value = argv[i + 1];
    if (!value || value.startsWith("-") || values.has(flag)) return;
    values.set(flag, value);
  }
  const paths = ["--config", "--drop", "--evidence", "--data"] as const;
  const integer = (value = "") => /^[1-9][0-9]*$/u.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : undefined;
  const repository_id = integer(values.get("--repository-id"));
  const pr = integer(values.get("--pr"));
  if (values.size !== 6 || !repository_id || !pr || paths.some(flag => !isAbsolute(values.get(flag) ?? "") || values.get(flag)!.includes("\0"))) return;
  return { repository_id, pr, configPath: values.get("--config")!, dropDir: values.get("--drop")!,
    evidenceDir: values.get("--evidence")!, data: values.get("--data")! };
}

async function readConfig(path: string) {
  const file = await open(path, "r");
  try {
    const limit = 262144;
    const info = await file.stat();
    if (!info.isFile() || info.size > limit) return { ok: false } as const;
    const buffer = Buffer.alloc(limit + 1);
    let length = 0;
    while (length <= limit) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > limit) return { ok: false } as const;
    return parseHarnessConfig(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, length))));
  } finally {
    await file.close();
  }
}

async function ensurePrivateDir(dir: string) {
  try { await mkdir(dir, { mode: 0o700 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST" || !(await stat(dir)).isDirectory()) throw error;
  }
}

async function execute(argv: readonly string[], io: MainIo) {
  const args = parseArgs(argv);
  if (!args) return { code: 2, body: { ok: false, reason: "usage" } };
  const config = await readConfig(args.configPath).catch(() => ({ ok: false } as const));
  if (!config.ok) return { code: 2, body: { ok: false, reason: "config_invalid" } };

  const { data, dropDir, evidenceDir, repository_id, pr } = args;
  for (const path of [dropDir, evidenceDir]) {
    if (!(await stat(path)).isDirectory()) throw Error("internal");
  }
  const reposDir = join(data, "repos");
  const journalRoot = join(data, "journal");
  await ensurePrivateDir(reposDir);
  await ensurePrivateDir(journalRoot);
  const body = await runHarness({ config: config.value, dropDir, evidenceDir, repository_id, pr, journalRoot,
    signal: new AbortController().signal }, {
    github: createPullRequestPort({ fetchImpl: io.fetchImpl }), fetchSource: createGitSource({ reposDir }),
    loadProfile: loadInstalledVerificationProfile, prepare: prepareContainedProfileImage, run: runPreparedContainedProfile,
    now: io.now, uuid: io.uuid, ownerUid: io.getuid, ...io.ports,
  });
  return { code: body.ok ? 0 : 1, body };
}

export async function main(argv: readonly string[], io: MainIo): Promise<number> {
  const result = await execute(argv, io).catch(() => ({ code: 1, body: { ok: false, reason: "internal" } }));
  io.stdout(JSON.stringify(result.body));
  return result.code;
}
