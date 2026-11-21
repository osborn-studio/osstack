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

it("keeps the recheck run library unwired and its admission and journal private to the host", () => {
  const packages = fileURLToPath(new URL("../../", import.meta.url));
  for (const pkg of readdirSync(packages)) {
    const root = join(packages, pkg, "src");
    if (!existsSync(root)) continue;
    for (const file of readdirSync(root, { recursive: true, encoding: "utf8" })) {
      if (/\.test\.[^/]+$/.test(file)) continue;
      const path = join(root, file);
      if (!statSync(path).isFile()) continue;
      const source = readFileSync(path, "utf8");
      if (pkg === "cli" && file === "contained-mission-local-failure-recheck-run.ts") {
        expect(source, path).not.toContain("hostProof");
        continue;
      }
      const ports = pkg === "cli" && file === "contained-mission-local-failure-recheck-ports.ts";
      // The factory imports only the run port type.
      const runSource = ports ? source.replace('import type { RecheckRunPorts } from "./contained-mission-local-failure-recheck-run.js";', "") : source;
      expect(runSource, path).not.toMatch(/contained-mission-local-failure-recheck-run|\b(?:runRecheck|recoverRecheckRuns)\b/);
      if (pkg === "cli" || /(?:^|\/)(?:daemon|bin|cli-entry|[^/]+-rpc)\.[cm]?[jt]sx?$/.test(file)) {
        // The factory supplies the run store's hostProof method to the collector.
        const journalSource = ports ? source.replaceAll(/\b(?:LocalFailureRecheckRunStore|hostProof)\b/g, "") : source;
        expect(journalSource, path).not.toMatch(/verifyRecheckGrant|recheck-admission|LocalFailureRecheckRunStore|recheck-run-store/);
        // The collector is the designed consumer of the host proof port (docs/design/2026-11-19-host-recheck-run.md §7, row D4).
        if (pkg !== "cli" || file !== "contained-mission-local-failure-recheck-collect.ts")
          expect(journalSource, path).not.toContain("hostProof");
      }
    }
  }
});

it("keeps the recheck collector and Actions adapter unwired", () => {
  const packages = fileURLToPath(new URL("../../", import.meta.url));
  const modules = ["contained-mission-actions-attempt", "contained-mission-local-failure-recheck-collect"];
  const names = ["readActionsAttemptFact", "collectLocalFailureRecheck"];
  for (const pkg of readdirSync(packages)) {
    const root = join(packages, pkg, "src");
    if (!existsSync(root)) continue;
    for (const file of readdirSync(root, {recursive:true, encoding:"utf8"})) {
      if (!/\.[cm]?[jt]sx?$/.test(file) || /\.test\.[cm]?[jt]sx?$/.test(file)) continue;
      const source = readFileSync(join(root, file), "utf8");
      const ports = pkg === "cli" && file === "contained-mission-local-failure-recheck-ports.ts";
      // The factory calls the Actions adapter and imports only the collector deps type.
      const consumer = ports ? source.replace('import type { RecheckCollectorDeps } from "./contained-mission-local-failure-recheck-collect.js";', "") : source;
      for (const [i, module] of modules.entries()) {
        if (pkg === "cli" && (file === module + ".ts" || (ports && i === 0))) continue;
        expect(consumer, pkg + "/" + file).not.toContain(names[i]!);
        expect(consumer, pkg + "/" + file).not.toContain(module);
      }
    }
  }
});

it("keeps the recheck ports factories unwired across packages", () => {
  const packages = fileURLToPath(new URL("../../", import.meta.url));
  for (const pkg of readdirSync(packages)) {
    const root = join(packages, pkg, "src");
    if (!existsSync(root)) continue;
    for (const file of readdirSync(root, { recursive: true, encoding: "utf8" })) {
      if (/\.test\.[^/]+$/.test(file) || (pkg === "cli" && file === "contained-mission-local-failure-recheck-ports.ts")) continue;
      const path = join(root, file);
      if (statSync(path).isFile())
        expect(readFileSync(path, "utf8"), path).not.toMatch(/contained-mission-local-failure-recheck-ports|createRecheckRunPorts|createRecheckCollectorPorts/);
    }
  }
});

it("confines the local-failure assembly and switch to the contained Mission factory", () => {
  const packages = fileURLToPath(new URL("../../", import.meta.url));
  for (const pkg of readdirSync(packages)) {
    const root = join(packages, pkg, "src");
    if (!existsSync(root)) continue;
    for (const file of readdirSync(root, { recursive: true, encoding: "utf8" })) {
      const path = join(root, file);
      if (/\.test\.[^/]+$/.test(file) || !statSync(path).isFile()) continue;
      const source = readFileSync(path, "utf8");
      if (pkg === "cli" && file === "contained-mission-rpc.ts") {
        const runtime = /await\s+import\(\s*['"]\.\/contained-mission-local-failure-service\.js['"]\s*\)/g;
        const type = /localFailure\?:\s*import\(\s*['"]\.\/contained-mission-local-failure-service\.js['"]\s*\)\.LocalFailureRouteHandle/g;
        expect(source.match(runtime)).toHaveLength(1);
        expect(source.match(type)).toHaveLength(1);
        expect(source.replace(runtime, "").replace(type, "")).not.toContain("contained-mission-local-failure-service.js");
        continue;
      }
      if (pkg === "cli" && file === "contained-mission-local-failure-service.ts") {
        // The next node adds its one module here.
        expect(source.match(/\bimport\b/g)).toHaveLength(1);
        expect(source).toMatch(/^import\s+[^;'"]+\s+from\s+['"]\.\/contained-mission-local-failure-scan\.js['"];?$/m);
      } else expect(source, path).not.toMatch(/contained-mission-local-failure-service|createLocalFailureRouteService/);
      if (pkg !== "cli" || file !== "contained-mission-local-failure-switch.ts")
        expect(source, path).not.toMatch(/contained-mission-local-failure-switch|parseLocalFailureRouteSwitch|assertLocalFailureRouteStartable/);
    }
  }
});

it("gives the read, record and register steps one caller", () => {
  const packages = fileURLToPath(new URL("../../", import.meta.url));
  const definitions = [
    ["contained-mission-verification-reader.ts", /\b(?:readVerificationResults|readVerificationContractText)\b/],
    ["contained-mission-verification-read-transport.ts", /\bcreateVerificationRest\b/],
    ["contained-mission-verification-installation.ts", /\bcreateVerificationInstallationProof\b/],
    ["contained-mission-verification-producer-config.ts", /\bloadVerificationProducerConfig\b/],
  ] as const;
  for (const pkg of readdirSync(packages)) {
    const root = join(packages, pkg, "src");
    if (!existsSync(root)) continue;
    for (const file of readdirSync(root, { recursive: true, encoding: "utf8" })) {
      if (!/\.[cm]?[jt]sx?$/.test(file) || /\.test\.[cm]?[jt]sx?$/.test(file)) continue;
      const path = join(root, file), source = readFileSync(path, "utf8");
      if (pkg === "cli" && file === "contained-mission-local-failure-scan.ts") {
        expect(source, path).not.toMatch(/\b(?:runDiagnosis|recoverDiagnoses|dispatchLocalFailureRepair|recoverLocalFailureDispatch|approveLocalFailureRepair|publishLocalFailureRepair|reconcileLocalFailurePush|resumeConfirmedLocalPublication|runRecheck|recoverRecheckRuns|collectLocalFailureRecheck|prepareContainedProfileImage|runPreparedContainedProfile)\b/);
        continue;
      }
      if (pkg !== "cli" || file !== "contained-mission-local-failure-service.ts")
        expect(source, path).not.toMatch(/contained-mission-local-failure-scan|\b(?:scanLocalFailureChain|LocalFailureScanService|createLocalFailureScan)\b/);
      for (const [definition, names] of definitions)
        if (pkg !== "cli" || file !== definition) expect(source, path).not.toMatch(names);
      if (pkg === "cli" && file !== "contained-mission-diagnosis.ts") expect(source, path).not.toMatch(/\bregisterDiagnosis\b/);
      if (pkg === "cli" && /\bVerificationSourceStore\b/.test(source)) expect(source, path).not.toMatch(/\.record\s*\(/);
    }
  }
});
