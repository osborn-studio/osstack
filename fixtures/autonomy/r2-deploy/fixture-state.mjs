import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

export function fixtureStatePath() {
  if (process.env.OSSTACK_SOAK_FIXTURE_ONLY !== "1") {
    throw new Error("fixture execution requires OSSTACK_SOAK_FIXTURE_ONLY=1");
  }
  const path = process.env.OSSTACK_SOAK_FIXTURE_STATE;
  if (path === undefined || !path.startsWith("/")) {
    throw new Error("OSSTACK_SOAK_FIXTURE_STATE must be an absolute path");
  }
  return path;
}

export async function readFixtureState(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    return {
      schema_version: 1,
      deployment: "baseline",
      healthy: true,
      events: [],
    };
  }
}

export async function writeFixtureState(path, state) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporary, path);
}

export function appendFixtureEvent(state, kind, details = {}) {
  return {
    ...state,
    events: [
      ...(Array.isArray(state.events) ? state.events : []),
      { kind, ...details },
    ],
  };
}
