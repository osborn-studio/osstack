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
  previous_deployment: current.deployment,
  deployment: "production",
  healthy: process.env.OSSTACK_SOAK_FIXTURE_FORCE_UNHEALTHY !== "1",
}, "deploy_production", {
  forced_unhealthy:
    process.env.OSSTACK_SOAK_FIXTURE_FORCE_UNHEALTHY === "1",
}));
