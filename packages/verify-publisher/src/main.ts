import { createAppJwtSigner } from "./app-key.js";
import { runCliWithGithub } from "./cli.js";
import { createPublisherGithub } from "./github-transport.js";

export interface MainIo {
  fetchImpl: typeof fetch;
  now: () => Date;
  uuid: () => string;
  stdout: (line: string) => void;
  getuid?: () => number;
}

function failure(reason: "usage" | "key_unavailable" | "internal", code: number) {
  return { line: JSON.stringify({ ok: false, reason, detail: null }), code };
}

async function run(argv: readonly string[], io: MainIo) {
  const index = argv.indexOf("--key");
  const keyPath = argv[index + 1];
  if (index < 1 || index !== argv.lastIndexOf("--key") || !keyPath || keyPath.startsWith("-")) {
    return failure("usage", 2);
  }

  let line: string | undefined;
  let keyUnavailable: (() => boolean) | undefined;
  const args = [...argv.slice(0, index), ...argv.slice(index + 2)];
  const code = await runCliWithGithub(args, {
    now: io.now,
    uuid: io.uuid,
    stdout: output => { line = output; },
    github: config => {
      const signJwt = createAppJwtSigner(keyPath, config.producer.app_id, io.getuid ? { getuid: io.getuid } : {});
      const transport = createPublisherGithub(config, { signJwt, fetchImpl: io.fetchImpl, now: () => io.now().getTime() });
      keyUnavailable = transport.keyUnavailable;
      return transport;
    },
  });
  if (keyUnavailable?.()) return failure("key_unavailable", 2);
  if (line === undefined) return failure("internal", 1);
  return { line, code };
}

export async function main(argv: readonly string[], io: MainIo): Promise<number> {
  const result = await run(argv, io).catch(() => failure("internal", 1));
  io.stdout(result.line);
  return result.code;
}
