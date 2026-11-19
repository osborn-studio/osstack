import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
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
      expect(source.replace(file === "contained-mission-runner.ts" ? "async resumeConfirmedLocalPublication(" : "", ""), file)
        .not.toContain("resumeConfirmedLocalPublication");
      const reader = pkg === "cli" && file === "contained-mission-local-failure-closeout.ts";
      if (!reader) expect(source, file).not.toMatch(/\breadLocalFailureCloseout\b|contained-mission-local-failure-closeout/);
      if (!reader && !(pkg === "core" && ["bridge/verification-intake.ts", "bridge/verification-gate.ts"].includes(file)))
        expect(source, file).not.toMatch(/\bevaluateVerificationGate\b|["'][^"']*verification-gate(?:\.js)?["']/);
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

it("keeps published-head writes in the chain store and repair confirmation in the publisher", () => {
  const packages = fileURLToPath(new URL("../../", import.meta.url));
  const callers: string[] = [];
  for (const pkg of ["cli", "core"]) {
    const root = join(packages, pkg, "src");
    for (const file of readdirSync(root, { recursive: true, encoding: "utf8" })) {
      if (!file.endsWith(".ts") || /\.(?:test|testkit)\.ts$/.test(file)) continue;
      const source = readFileSync(join(root, file), "utf8");
      if (pkg === "core" && file === "state/engineering-revision-chain-store.ts") {
        expect(source.replace(/^\s*confirmLocalRepairPush\(/m, ""), file).not.toMatch(/\bconfirmLocalRepairPush\b/);
        continue;
      }
      expect(source, file).not.toMatch(/UPDATE\s+engineering_revision_chains\s+SET\b(?:(?!\bWHERE\b)[^;`])*?\bpublished_head\s*=/i);
      expect(source, file).not.toMatch(/\b(?:patch\.published_head\s*=(?!=)|update\s*\([^,]+,\s*\{[^}]*\bpublished_head\s*:)/);
      if (/\bconfirmLocalRepairPush\b/.test(source)) callers.push(pkg + "/" + file);
    }
  }
  expect(callers).toEqual(["cli/contained-mission-local-failure-publish.ts"]);
});

it("keeps recheck grant verification out of the CLI and daemon or RPC entry points", () => {
  const packages = fileURLToPath(new URL("../../", import.meta.url));
  for (const pkg of readdirSync(packages)) {
    const root = join(packages, pkg, "src");
    if (!existsSync(root)) continue;
    for (const file of readdirSync(root, { recursive: true, encoding: "utf8" })) {
      if (/\.test\.[^/]+$/.test(file)) continue;
      if (pkg !== "cli" && !/(?:^|\/)(?:daemon|bin|cli-entry|[^/]+-rpc)\.ts$/.test(file)) continue;
      const path = join(root, file);
      if (statSync(path).isFile()) expect(readFileSync(path, "utf8"), path).not.toMatch(/verifyRecheckGrant|recheck-admission/);
    }
  }
});

it("keeps the recheck run store out of CLI and daemon entry points", () => {
  const packages = fileURLToPath(new URL("../../", import.meta.url));
  for (const pkg of readdirSync(packages)) {
    const root = join(packages,pkg,"src");
    if (!existsSync(root)) continue;
    for (const file of readdirSync(root,{ recursive: true, encoding: "utf8" })) {
      if (!/\.[cm]?[jt]sx?$/.test(file) || /\.test\.[cm]?[jt]sx?$/.test(file)) continue;
      if (pkg === "cli" || /(?:^|\/)(?:daemon|bin|cli-entry|[^/]+-rpc)\.ts$/.test(file))
        expect(readFileSync(join(root,file),"utf8"),pkg+"/"+file).not.toMatch(/LocalFailureRecheckRunStore|recheck-run-store|hostProof/);
    }
  }
});
