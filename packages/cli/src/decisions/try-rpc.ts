import type Database from "better-sqlite3";
import { DecisionProbes, type DecisionProbe, type EngineeringPrincipal } from "@osstack/core";
import { DecisionsTryCreateParams, DecisionsTryStatusParams, DecisionsTryResult } from "@osstack/protocol";

function view(probe: DecisionProbe, now: number, created?: boolean): DecisionsTryResult {
  const { probe_id, state, revision, created_at, expires_at, answer, continued_at } = probe;
  return DecisionsTryResult.parse({
    probe_id, state: state === "pending" && now >= expires_at ? "expired" : state,
    revision, created_at, expires_at, answer, continued_at, ...(created === undefined ? {} : { created }),
  });
}

export function tryDecisionRpc(
  method: "decisions.try_create" | "decisions.try_status" | "decisions.try_continue",
  input: unknown, db: Database.Database, authenticate: ((credential: unknown) => EngineeringPrincipal) | undefined,
  draining: boolean,
): DecisionsTryResult {
  if (draining && method !== "decisions.try_status") throw Error("draining");
  const credential = input && typeof input === "object" && "credential" in input ? input.credential : undefined;
  let actor: EngineeringPrincipal;
  try {
    if (!authenticate) throw Error();
    actor = authenticate(credential);
  } catch { throw Error("permission_denied"); }
  const now = Date.now();
  const store = new DecisionProbes(db);
  if (method === "decisions.try_create") {
    if (!DecisionsTryCreateParams.safeParse(input).success) throw Error("bad_request");
    const { probe, created } = store.create({ now, created_by: actor.principal_id });
    return view(probe, now, created);
  }
  const parsed = DecisionsTryStatusParams.safeParse(input);
  if (!parsed.success) throw Error("bad_request");
  const { probe_id } = parsed.data;
  if (method === "decisions.try_continue") {
    const result = store.continue(probe_id, now);
    if (result.code !== "continued") throw Error(result.code);
    return view(result.probe, now);
  }
  const probe = store.status(probe_id, now);
  if (!probe) throw Error("not_found");
  return view(probe, now);
}
