import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { scanFiles, scanText } from "./scanner.js";

describe("governance scanner", () => {
  it("flags deterministic governance risks in text", () => {
    const result = scanText(`
const api_key = "sk-1234567890";
const bad = "rm -rf /";
// @ts-ignore
const value: any = {};
fetch(userInput);
console.log("debug");
`, { file: "src/example.ts" });

    expect(result.ok).toBe(false);
    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ rule_id: "secret.api_key", severity: "error", line: 2 }),
      expect.objectContaining({ rule_id: "shell.rm_rf_root", severity: "error", line: 3 }),
      expect.objectContaining({ rule_id: "ts.ts_ignore", severity: "warning", line: 4 }),
      expect.objectContaining({ rule_id: "ts.no_explicit_any", severity: "warning", line: 5 }),
      expect.objectContaining({ rule_id: "backend.ssr_dirty_fetch", severity: "warning", line: 6 }),
      expect.objectContaining({ rule_id: "ts.console_spam", severity: "info", line: 7 }),
    ]));
  });

  it("flags frontend anti-slop patterns and can scan files", async () => {
    const dir = mkdtempSync(join(tmpdir(), "osstack-governance-"));
    await mkdir(join(dir, "src"), { recursive: true });
    const path = join(dir, "src", "App.tsx");
    await writeFile(path, `
export function App() {
  return <div style={{ color: "#a855f7" }}>Lorem ipsum 🚀</div>;
}
`);

    const result = await scanFiles([path]);

    expect(result.ok).toBe(false);
    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ rule_id: "frontend.lorem_ipsum", file: path }),
      expect.objectContaining({ rule_id: "frontend.emoji_icon", file: path }),
      expect.objectContaining({ rule_id: "frontend.template_purple", file: path }),
    ]));
  });
});
