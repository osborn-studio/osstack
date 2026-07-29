#!/usr/bin/env node
import {
  appendFixtureEvent,
  fixtureStatePath,
  readFixtureState,
  writeFixtureState,
} from "./fixture-state.mjs";

const path = fixtureStatePath();
const current = await readFixtureState(path);
await writeFixtureState(path, appendFixtureEvent({
  ...current,
  deployment: current.previous_deployment ?? "baseline",
  healthy: true,
}, "rollback"));
