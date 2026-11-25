import { createPrivateKey, createSign } from "node:crypto";
import { constants, open } from "node:fs/promises";
import { isAbsolute } from "node:path";

export class AppKeyUnavailable extends Error {
  constructor() { super("key_unavailable"); }
}
export interface AppKeyDeps { readonly getuid?: () => number }

const limit = 16384;
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

export function createAppJwtSigner(keyPath: string, appId: number, deps: AppKeyDeps = {}) {
  return async (nowMs: number): Promise<string> => {
    try {
      if (!isAbsolute(keyPath)) throw new AppKeyUnavailable();
      const file = await open(keyPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const stat = await file.stat();
        const getuid = deps.getuid ?? process.getuid;
        if (!stat.isFile() || (stat.mode & 0o077) !== 0 || (getuid && stat.uid !== getuid()) || stat.size > limit) {
          throw new AppKeyUnavailable();
        }
        const bytes = Buffer.alloc(limit + 1);
        let size = 0;
        while (size <= limit) {
          const { bytesRead } = await file.read(bytes, size, bytes.length - size, null);
          if (!bytesRead) break;
          size += bytesRead;
        }
        if (size > limit) throw new AppKeyUnavailable();
        const key = createPrivateKey(bytes.subarray(0, size));
        if (key.asymmetricKeyType !== "rsa") throw new AppKeyUnavailable();
        const sec = Math.floor(nowMs / 1000);
        const claims = encode({ iat: sec - 60, exp: sec + 540, iss: String(appId) });
        const unsigned = encode({ alg: "RS256", typ: "JWT" }) + "." + claims;
        return unsigned + "." + createSign("RSA-SHA256").update(unsigned).sign(key, "base64url");
      } finally { await file.close(); }
    } catch { throw new AppKeyUnavailable(); }
  };
}
