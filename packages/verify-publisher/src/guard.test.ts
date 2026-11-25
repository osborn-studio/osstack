import { readFile, readdir } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const root = fileURLToPath(new URL("../../", import.meta.url));
const ours = "verify-publisher";
async function sources(dir: string): Promise<string[]> {
  const files: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (["dist", "node_modules"].includes(e.name)) continue;
    const path = join(dir, e.name);
    if (e.isDirectory()) files.push(...await sources(path));
    else if (e.isFile() && e.name.endsWith(".ts")) files.push(path);
  }
  return files;
}

it("isolates the cloud package and keeps check-run writes out of host source", async () => {
  const violations: string[] = [];
  const writers = new Set(["cli/src/contained-mission-bridge.ts"]);
  // This host guard test names the publisher's transport file to bound where installation tokens are minted.
  const namers = new Set(["cli/src/contained-mission-verification-identity.guard.test.ts"]);
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(root, entry.name);
    const manifest = await readFile(join(dir, "package.json"), "utf8").catch((e: NodeJS.ErrnoException) => {
      if (e.code !== "ENOENT") throw e;
      return "";
    });
    if (entry.name !== ours && manifest.includes("@osstack/" + ours)) violations.push(entry.name + "/package.json");
    const paths = await sources(join(dir, "src")).catch((e: NodeJS.ErrnoException) => {
      if (e.code !== "ENOENT") throw e;
      return [];
    });
    for (const path of paths) {
      const source = await readFile(path, "utf8");
      const name = relative(root, path);
      if (entry.name !== ours && !namers.has(name) && source.includes(ours)) violations.push(name);
      if (path.endsWith(".test.ts") || name.split("/").slice(0, -1).includes("testkit")) continue;
      if (!writers.has(name) && source.split("\n").some(l => l.includes("check-runs") && /\b(?:POST|PATCH|PUT|DELETE)\b/u.test(l))) violations.push(name);
      if (entry.name !== ours) continue;
      const allowed = ["@osstack/core/verification-publish", "zod", "node:fs/promises", "node:path", "node:crypto"];
      for (const match of source.matchAll(/(?:\bfrom\s*|\bimport\s*(?:\(\s*)?|\brequire\s*\(\s*)["']([^"']+)["']/gu)) {
        if (!/^\.\.?\//u.test(match[1]!) && !allowed.includes(match[1]!)) violations.push(name + " import " + match[1]);
      }
      if (/\bfetch\s*\(|child_process|node:http|process\.env|PATCH|DELETE|PUT/u.test(source)) violations.push(name);
      const file = basename(path);
      if (file !== "github-transport.ts" && /api\.github\.com|authorization/u.test(source)) violations.push(name);
      if (file !== "app-key.ts" && /createPrivateKey|createSign|O_NOFOLLOW/u.test(source)) violations.push(name);
      if (source.includes("console.")) violations.push(name);
      if (file === "github-transport.ts") {
        const methods = [...source.matchAll(/\bmethod:\s*("[A-Z]+")/gu)].map(m => m[1]).sort();
        expect(methods).toEqual(['"GET"', '"POST"', '"POST"']);
        expect(source.match(/\bmethod\s*:/gu)).toHaveLength(methods.length);
      }
      if (basename(path) === "publish.ts") expect(source.match(/\bcreateCheckRun\s*\(/gu)).toHaveLength(1);
    }
  }
  expect(violations).toEqual([]);
});
