import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const root = fileURLToPath(new URL("../../", import.meta.url));
const harness = "verify-harness";
const publisher = "verify-" + "publisher";
const publishKit = ["verification-" + "result-builder", "verification-" + "publish"];
const credentials = ["access" + "_tokens", "author" + "ization", "private" + "_key"];

async function sources(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
    return [];
  });
  const paths: string[] = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) paths.push(...await sources(path));
    else if (/\.[cm]?[jt]sx?$/u.test(entry.name)) paths.push(path);
  }
  return paths;
}

it("keeps package dependencies isolated and all transport and execution behind ports", async () => {
  const violations: string[] = [];
  for (const dir of await readdir(root, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const own = dir.name === harness;
    const manifest = await readFile(join(root, dir.name, "package.json"), "utf8");
    if (manifest.includes("@osstack/" + (own ? publisher : harness))) violations.push(dir.name + "/package.json");
    for (const path of await sources(join(root, dir.name, "src"))) {
      const source = await readFile(path, "utf8");
      const name = relative(root, path);
      if (!own) {
        if (source.includes("@osstack/" + harness) || source.includes("/" + harness + "/")) violations.push(name);
        continue;
      }
      if ([publisher, ...credentials].some(word => source.includes(word))) violations.push(name);
      if (path.endsWith(".test.ts")) continue;
      if (publishKit.some(word => source.includes(word))) violations.push(name);
      if (/\bfetch\s*\(|node:https?|node:net|process\.env|console\.|\b(?:POST|PATCH|PUT|DELETE)\b/u.test(source)
        || (name !== harness + "/src/source.ts" && source.includes("child_process"))
        || (name !== harness + "/src/github-read.ts" && source.includes("api.github.com"))
        || (![harness + "/src/github-read.ts", harness + "/src/source.ts"].includes(name) && source.includes("github.com/"))
        || (name !== harness + "/src/bin.ts" && /process\.(?:argv|stdout|exitCode|getuid)\b/u.test(source))
        || ([harness + "/src/main.ts", harness + "/src/bin.ts"].includes(name) && /protocol|remote/u.test(source)))
        violations.push(name);
    }
  }
  expect(violations).toEqual([]);
});
