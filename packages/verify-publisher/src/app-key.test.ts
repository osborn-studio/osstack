import { createVerify, generateKeyPairSync } from "node:crypto";
import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { AppKeyUnavailable, createAppJwtSigner, type AppKeyDeps } from "./app-key.js";

const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pem = pair.privateKey.export({ format: "pem", type: "pkcs8" }).toString();
let dir: string, path: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "publisher-key-"));
  path = join(dir, "key");
  await writeFile(path, pem, { mode: 0o600 });
  await chmod(path, 0o600);
});
afterEach(() => rm(dir, { recursive: true, force: true }));

it("signs the app claims with RS256", async () => {
  const sign = createAppJwtSigner(path, 201);
  const [header, payload, signature] = (await sign(1234567890)).split(".");
  const decode = (part: string) => JSON.parse(Buffer.from(part, "base64url").toString());
  expect(decode(header!)).toEqual({ alg: "RS256", typ: "JWT" });
  expect(decode(payload!)).toEqual({ iat: 1234567 - 60, exp: 1234567 + 540, iss: "201" });
  expect(createVerify("RSA-SHA256").update(header + "." + payload).verify(pair.publicKey, signature!, "base64url")).toBe(true);
  await chmod(path, 0o640);
  await expect(sign(1234567890)).rejects.toThrow("key_unavailable");
});

it.each(["relative", "missing", "0640", "0604", "owner", "symlink", "directory", "oversize", "invalid", "EC"])(
  "refuses %s", async kind => {
    let target = path;
    let deps: AppKeyDeps = {};
    switch (kind) {
      case "relative": target = "key"; break;
      case "missing": target = join(dir, "missing"); break;
      case "0640": await chmod(path, 0o640); break;
      case "0604": await chmod(path, 0o604); break;
      case "owner": deps = { getuid: () => process.getuid!() + 1 }; break;
      case "symlink": target = join(dir, "link"); await symlink(path, target); break;
      case "directory": target = dir; break;
      case "oversize": await writeFile(path, pem.padEnd(16385)); break;
      case "invalid": await writeFile(path, "invalid"); break;
      case "EC": await writeFile(path, generateKeyPairSync("ec", { namedCurve: "prime256v1" })
        .privateKey.export({ format: "pem", type: "pkcs8" })); break;
    }
    const result = createAppJwtSigner(target, 201, deps)(0);
    await expect(result).rejects.toBeInstanceOf(AppKeyUnavailable);
    await expect(result).rejects.toHaveProperty("message", "key_unavailable");
  });

it("hides the path and key on failure", async () => {
  await writeFile(path, pem.replace("BEGIN PRIVATE KEY", "INVALID"));
  const error = await createAppJwtSigner(path, 201)(0).catch((e: Error) => e);
  expect(error).toBeInstanceOf(AppKeyUnavailable);
  expect(error).not.toHaveProperty("cause");
  for (const text of [path, ...pem.trim().split("\n")]) {
    expect((error as Error).message).not.toContain(text);
    expect((error as Error).stack).not.toContain(text);
  }
});
