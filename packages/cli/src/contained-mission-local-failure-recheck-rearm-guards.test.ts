import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("confines re-arm authority, status reads and the host command", () => {
  const packages = fileURLToPath(new URL("../../", import.meta.url));
  const prefix = "cli/contained-mission-", service = prefix + "local-failure-service.ts";
  const rearm = prefix + "local-failure-recheck-rearm.ts", view = prefix + "local-failure-recheck-view.ts";
  const rpc = prefix + "rpc.ts", answer = "cli/decisions/answer.ts";
  const rules: [string, string[]][] = [
    ["rearm_local_failure_recheck", [rpc, prefix + "command.ts", answer]],
    ["createRecheckRearm", [rearm, service]], ["readLocalFailureRecheckView", [view, service]],
    ["contained-mission-local-failure-recheck-rearm", [view, service, rearm]],
    ["contained-mission-local-failure-recheck-view", [view, service]],
    ["local_recheck_rearm_requested", [rearm, view]],
    ["runFacts", ["core/state/engineering-local-failure-recheck-store.ts", rearm, view]],
  ];
  for (const pkg of readdirSync(packages)) {
    const root = join(packages, pkg, "src");
    if (!existsSync(root)) continue;
    for (const file of readdirSync(root, { recursive: true, encoding: "utf8" })) {
      if (/\.test\.[^/]+$/.test(file) || !statSync(join(root, file)).isFile()) continue;
      const source = readFileSync(join(root, file), "utf8"), path = pkg + "/" + file;
      for (const [name, allowed] of rules) if (!allowed.includes(path)) expect(source, path).not.toContain(name);
      if (path === "cli/decisions/notices.ts") expect(source).not.toMatch(/rearm|local_recheck|verification_waiting/i);
      if (path === "cli/attention-webhook-delivery.ts") expect(source).not.toMatch(/rearm/i);
      if (path === answer) expect(source).not.toContain("mission.rearm_local_failure_recheck");
      if (path === rearm) {
        expect(source.match(/\bappendEvent\s*\(/g)).toHaveLength(1);
        expect(source).not.toMatch(/runRecheck|recoverRecheckRuns|contained-mission-local-failure-recheck-run|LocalFailureRecheckRunStore|hostProof|verifyRecheckGrant|replaceGrant|parseLocalFailureRevisionGrant|approveLocalFailureRepair|publishLocalFailureRepair|reconcileLocalFailurePush|resumeConfirmedLocalPublication|dispatchLocalFailureRepair|recoverLocalFailureDispatch|runDiagnosis|recoverDiagnoses|registerDiagnosis|fetch|process\.env|node:fs|setTimeout|setInterval/);
        expect(source).not.toMatch(/\b(?:INSERT(?:\s+OR\s+\w+)?\s+INTO|UPDATE(?:\s+OR\s+\w+)?\s+\S+\s+SET|DELETE\s+FROM)\b/i);
      }
      if (path === view) expect(source).not.toMatch(/appendEvent|\.(?:record|transition)\s*\(|\b(?:INSERT|UPDATE|DELETE|fetch)\b/i);
      if (["daemon.ts", "bin.ts", "cli-entry.ts"].includes(file)) expect(source).not.toMatch(/rearmRecheck|recheckView/);
      if (path === rpc) {
        const body = source.match(/case 'mission\.rearm_local_failure_recheck'([\s\S]*?)case '/);
        expect(body).not.toBeNull();
        expect(body![1]).not.toMatch(/host\.|runOnce|tick|publish|approve|grant|await /);
      }
    }
  }
});
