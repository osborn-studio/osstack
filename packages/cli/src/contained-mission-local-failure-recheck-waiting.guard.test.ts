import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("keeps waiting notices unwired and the recheck ledger read-only", () => {
  const packages = fileURLToPath(new URL("../../", import.meta.url));
  for (const pkg of readdirSync(packages)) {
    const root = join(packages, pkg, "src");
    if (!existsSync(root)) continue;
    for (const file of readdirSync(root, { recursive: true, encoding: "utf8" })) {
      const path = join(root, file);
      if (/\.test\.[^/]+$/.test(file) || !statSync(path).isFile()) continue;
      const source = readFileSync(path, "utf8");
      if (pkg === "cli" && file === "contained-mission-local-failure-recheck-waiting.ts") {
        expect(source, path).not.toMatch(/process\.env|fetch\(|node:(?:child_process|net|http)/);
        expect(source, path).not.toMatch(/\b(?:INSERT(?:\s+OR\s+\w+)?\s+INTO|UPDATE(?:\s+OR\s+\w+)?|DELETE\s+FROM)\s+["`[]?engineering_local_failure_rechecks\b/i);
      } else {
        expect(source, path).not.toMatch(/contained-mission-local-failure-recheck-waiting|noticeWaitingRechecks/);
        if (pkg !== "cli" || file !== "contained-mission-local-failure-closeout.ts")
          expect(source, path).not.toContain("local_recheck_waiting_notice");
      }
    }
  }
});
