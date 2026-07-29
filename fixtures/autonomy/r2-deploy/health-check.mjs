#!/usr/bin/env node
import {
  appendFixtureEvent,
  fixtureStatePath,
  readFixtureState,
  writeFixtureState,
} from "./fixture-state.mjs";

const path = fixtureStatePath();
const current = await readFixtureState(path);
const healthy = current.healthy === true;
await writeFixtureState(
  path,
  appendFixtureEvent(current, "health_check", { healthy }),
);
process.exitCode = healthy ? 0 : 1;
