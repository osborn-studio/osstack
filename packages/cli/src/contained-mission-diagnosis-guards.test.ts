import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { expect, it } from "vitest";
it("keeps diagnosis offline and single-writer", () => {
  const packages = fileURLToPath(new URL("../../", import.meta.url));
  for (const pkg of readdirSync(packages)) {
    const root = join(packages, pkg, "src");
    let files: string[];
    try {
      files = readdirSync(root, { recursive: true, encoding: "utf8" });
    } catch {
      continue;
    }
    for (const file of files.filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))) {
      const source = readFileSync(join(root, file), "utf8");
      if (!file.endsWith("engineering-diagnosis-store.ts"))
        expect(source, file).not.toMatch(/INSERT\s+INTO\s+engineering_(host_receipts|diagnosis_requests)/i);
      if (!file.endsWith("engineering-local-failure-dispatch-store.ts"))
        expect(source, file).not.toMatch(/INSERT\s+INTO\s+engineering_local_failure_dispatches/i);
      if (/(?:^|\/)(?:daemon|bin|cli-entry|[^/]+-rpc)\.ts$/.test(file))
        expect(source, file).not.toMatch(/contained-mission-local-failure-dispatch|engineering-local-failure-dispatch-store|LocalFailureDispatchStore|dispatchLocalFailureRepair|recoverLocalFailureDispatch|contained-mission-diagnosis|engineering-diagnosis-store|\b(?:DiagnosisStore|runDiagnosis|registerDiagnosis|recoverDiagnoses)\b/);
      if (file === "contained-mission-diagnosis.ts") expect(source).not.toMatch(/\b(?:authorize|registerDerived|fetch)\s*\(/);
      if (file.endsWith("instruction-boundary.ts")) expect(source).not.toMatch(/from [^\n]*(?:reader|reference|diagnosis)/);
    }
  }
});

it("keeps local failure publication closed outside its library", () => {
  const root = fileURLToPath(new URL(".", import.meta.url));
  const modules = ["contained-mission-local-failure-approval.ts", "contained-mission-local-failure-publish.ts"];
  for (const file of modules) expect(readFileSync(join(root, file), "utf8")).not.toContain("ci_repair");
  for (const file of readdirSync(root, { recursive: true, encoding: "utf8" }).filter(f => f.endsWith(".ts") && !f.endsWith(".test.ts"))) {
    let source = readFileSync(join(root, file), "utf8");
    if (file === "contained-mission-runner.ts") {
      expect(source).toContain("const { LOCAL_FAILURE_PUBLISH_STOPS } = await import('./contained-mission-local-failure-publish.js')");
      source = source.replace("const { LOCAL_FAILURE_PUBLISH_STOPS } = await import('./contained-mission-local-failure-publish.js')", "")
        .replace("localFailurePublication?:", "")
        .replace("!this.ports.localFailurePublication)", "")
        .replace("this.ports.localFailurePublication! :", "");
    }
    if (!modules.includes(file)) expect(source, file).not.toMatch(/contained-mission-local-failure-(?:approval|publish)\b/);
    expect(source, file).not.toContain("localFailurePublication");
  }
});
