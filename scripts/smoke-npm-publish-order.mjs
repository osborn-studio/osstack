#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  buildTopologicalPublishPlan,
  changesetsTagAnnouncement,
  npmPublishArgs,
  publishCliMode,
  publishPackagesSequentially,
  publishPlanPayload,
  publishWithRetry,
  isTransientPublishError,
  sanitizePublishError,
} from "./publish-packages-safely.mjs";

const execFileAsync = promisify(execFile);

const packages = [
  workspacePackage("@osstack/cli", [
    "@osstack/compliance",
    "@osstack/contracts",
    "@osstack/knowledge",
  ]),
  workspacePackage("@osstack/knowledge-cloud", ["@osstack/knowledge"]),
  workspacePackage("@osstack/contracts"),
  workspacePackage("@osstack/knowledge"),
  workspacePackage("@osstack/compliance"),
];

assert.deepEqual(
  buildTopologicalPublishPlan(packages).map((item) => item.name),
  [
    "@osstack/compliance",
    "@osstack/contracts",
    "@osstack/knowledge",
    "@osstack/cli",
    "@osstack/knowledge-cloud",
  ],
  "publish plan must be deterministic and dependency-first",
);

assert.throws(
  () => buildTopologicalPublishPlan([
    workspacePackage("@osstack/a", ["@osstack/b"]),
    workspacePackage("@osstack/b", ["@osstack/a"]),
  ]),
  /dependency cycle/u,
  "dependency cycles must fail before any publish",
);

const attempted = [];
const recorded = [];
await assert.rejects(
  publishPackagesSequentially(packages, {
    publishedVersions: new Set(),
    publish: async (item) => {
      attempted.push(item.name);
      if (item.name === "@osstack/contracts") {
        throw new Error("simulated trust failure");
      }
    },
    recordPublished: async (item) => {
      recorded.push(item.name);
    },
  }),
  /simulated trust failure/u,
);
assert.deepEqual(
  attempted,
  ["@osstack/compliance", "@osstack/contracts"],
  "the first publish failure must stop the train",
);
assert.deepEqual(
  recorded,
  ["@osstack/compliance"],
  "only successful publishes may emit tag/release events",
);
assert(!attempted.includes("@osstack/cli"), "a dependent CLI must never publish after a dependency failure");

const repaired = [];
await publishPackagesSequentially(packages, {
  publishedVersions: new Set([
    "@osstack/compliance@0.15.0",
    "@osstack/contracts@0.15.0",
    "@osstack/knowledge@0.15.0",
  ]),
  publish: async (item) => {
    repaired.push(item.name);
  },
  recordPublished: async () => {},
});
assert.deepEqual(
  repaired,
  ["@osstack/cli", "@osstack/knowledge-cloud"],
  "already-published dependencies must be skipped while their dependents remain eligible",
);

const sanitized = sanitizePublishError(
  "Authenticate at https://www.npmjs.com/auth/cli/private-session npm_exampletoken12345678901234567890 _authToken=legacy-secret Authorization: Bearer bearer-secret",
);
assert(!sanitized.includes("private-session"), "delegated-auth URLs must be redacted");
assert(!sanitized.includes("npm_exampletoken"), "npm tokens must be redacted");
assert(!sanitized.includes("legacy-secret"), "legacy npm auth tokens must be redacted");
assert(!sanitized.includes("bearer-secret"), "bearer credentials must be redacted");

assert.equal(
  changesetsTagAnnouncement(workspacePackage("@osstack/cli")),
  "New tag: @osstack/cli@0.15.0",
  "changesets/action@v1 must discover each successfully created monorepo tag",
);

const publishArgs = npmPublishArgs(workspacePackage("@osstack/cli"), "latest");
assert(!publishArgs.includes("--provenance"), "Trusted Publishing must not force provenance for a private source repository");
assert(publishArgs.includes("--no-git-checks"), "the guarded publisher must keep the release-worktree override");
assert.deepEqual(
  publishArgs.slice(-2),
  ["--registry", "https://registry.npmjs.org/"],
  "the guarded publisher must use the canonical registry",
);

assert.equal(publishCliMode(["node", "publish-packages-safely.mjs"]), "publish");
assert.equal(publishCliMode(["node", "publish-packages-safely.mjs", "--plan"]), "plan");
assert.throws(
  () => publishCliMode(["node", "publish-packages-safely.mjs", "--plan", "--json"]),
  /unknown arguments/u,
  "extra plan arguments must fail before any publish",
);

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const planEnv = { ...process.env };
delete planEnv.OSSTACK_NPM_DIST_TAG;
const planRun = await execFileAsync(process.execPath, [
  fileURLToPath(new URL("./publish-packages-safely.mjs", import.meta.url)),
  "--plan",
], { cwd: repoRoot, env: planEnv, timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
const planned = JSON.parse(planRun.stdout);
assert.equal(planned.ok, true);
assert.equal(planned.kind, "safe-sequential-npm-publish-plan");
assert.equal(planned.dist_tag, "latest");
assert.equal(planned.registry, "https://registry.npmjs.org/");
assert.equal(planned.public_packages, planned.plan.length);
assert.ok(planned.plan.length > 0, "the workspace plan must list the public packages");
const plannedPackages = planned.plan.map((item) => ({
  name: item.name,
  version: item.version,
  directory: item.directory,
  access: item.access,
  internalDependencies: item.internalDependencies,
}));
assert.deepEqual(
  planned.plan.map((item) => item.name),
  buildTopologicalPublishPlan(plannedPackages).map((item) => item.name),
  "--plan must print buildTopologicalPublishPlan order",
);
assert.deepEqual(
  planned,
  publishPlanPayload(plannedPackages, planned.dist_tag),
  "--plan JSON must match publishPlanPayload",
);
const orderByName = new Map(planned.plan.map((item) => [item.name, item.order]));
for (const item of planned.plan) {
  assert.equal(item.order, planned.plan.indexOf(item) + 1);
  assert.deepEqual(
    item.publish_argv,
    npmPublishArgs(item, planned.dist_tag),
    `${item.name} must use npmPublishArgs`,
  );
  for (const dependency of item.internalDependencies) {
    const dependencyOrder = orderByName.get(dependency);
    assert.ok(
      dependencyOrder !== undefined && dependencyOrder < item.order,
      `${item.name} must follow ${dependency}`,
    );
  }
}
assert.ok(orderByName.has("@osstack/cli"), "the public CLI must be in the plan");
assert.equal(orderByName.has("@osstack/supervisor"), false, "private packages must stay out of the plan");

await assert.rejects(
  execFileAsync(process.execPath, [
    fileURLToPath(new URL("./publish-packages-safely.mjs", import.meta.url)),
    "--publish",
  ], { cwd: repoRoot, env: planEnv, timeout: 30_000 }),
  /unknown arguments/u,
);

console.log(JSON.stringify({
  ok: true,
  kind: "npm-publish-order-smoke",
  cases: 8,
}, null, 2));

function workspacePackage(name, internalDependencies = []) {
  return {
    name,
    version: "0.15.0",
    directory: `packages/${name.slice("@osstack/".length)}`,
    internalDependencies,
  };
}

{
  const item = { name: "@osstack/graph", version: "0.23.0" };
  const waits = [];
  let calls = 0;
  const result = await publishWithRetry(item, {
    delays: [1, 2],
    publish: async () => {
      calls += 1;
      if (calls === 1) throw new Error("publish failed for @osstack/graph@0.23.0: 404 Not Found - PUT https://registry.npmjs.org/@osstack%2fgraph - Not found");
    },
    hasVersion: async () => false,
    wait: async (ms) => { waits.push(ms); },
  });
  assert.deepEqual(result, { attempts: 2 }, "a transient Trusted Publishing 404 must be retried");
  assert.deepEqual(waits, [1]);

  const landed = await publishWithRetry(item, {
    delays: [1],
    publish: async () => { throw new Error("E404 404 Not Found - PUT"); },
    hasVersion: async () => true,
    wait: async () => {},
  });
  assert.equal(landed.alreadyPublished, true, "a PUT that landed despite a client error must not be republished");

  let permanent = 0;
  await assert.rejects(publishWithRetry(item, {
    delays: [1, 2],
    publish: async () => { permanent += 1; throw new Error("E403 You cannot publish over the previously published versions"); },
    hasVersion: async () => false,
    wait: async () => {},
  }), /E403/u);
  assert.equal(permanent, 1, "non-transient failures must not be retried");

  let exhausted = 0;
  await assert.rejects(publishWithRetry(item, {
    delays: [1, 2],
    publish: async () => { exhausted += 1; throw new Error("404 Not Found - PUT"); },
    hasVersion: async () => false,
    wait: async () => {},
  }), /404/u);
  assert.equal(exhausted, 3, "retries are bounded by the delay schedule");
  assert(!isTransientPublishError("E403 forbidden"));
}
