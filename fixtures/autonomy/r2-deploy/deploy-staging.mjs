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
  deployment: "staging",
  healthy: true,
}, "deploy_staging"));
