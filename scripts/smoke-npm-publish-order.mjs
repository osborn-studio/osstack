#!/usr/bin/env node
import assert from "node:assert/strict";
import {
  buildTopologicalPublishPlan,
  changesetsTagAnnouncement,
  publishPackagesSequentially,
  sanitizePublishError,
} from "./publish-packages-safely.mjs";

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

console.log(JSON.stringify({
  ok: true,
  kind: "npm-publish-order-smoke",
  cases: 6,
}, null, 2));

function workspacePackage(name, internalDependencies = []) {
  return {
    name,
    version: "0.15.0",
    directory: `packages/${name.slice("@osstack/".length)}`,
    internalDependencies,
  };
}
