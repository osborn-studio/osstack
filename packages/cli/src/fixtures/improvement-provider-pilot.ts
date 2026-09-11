// Test-only live-pilot infrastructure; no provider or GitHub calls here.
import type { AgentAdapter } from "@osstack/agents";
import type { HermesEvent } from "@osstack/hermes-adapter";

/** Run serially within a Vitest fork. Keep artifacts even on failure. */
export async function withPilotState<Db extends { close(): void }, Result>(
  home: string,
  open: () => Db,
  run: (db: Db) => Promise<Result>,
  finalize: (failures: readonly unknown[]) => Promise<void>,
): Promise<Result> {
  const previousHome = process.env["OSSTACK_HOME"];
  const previousSocket = process.env["OSSTACK_SOCKET"];
  const errors: unknown[] = [];
  let db: Db | undefined;
  let result: Result | undefined;
  process.env["OSSTACK_HOME"] = home;
  delete process.env["OSSTACK_SOCKET"];
  try {
    try { db = open(); result = await run(db); } catch (error) { errors.push(error); }
    try { db?.close(); } catch (error) { errors.push(error); }
    try { await finalize([...errors]); } catch (error) { errors.push(error); }
  } finally {
    if (previousHome === undefined) delete process.env["OSSTACK_HOME"];
    else process.env["OSSTACK_HOME"] = previousHome;
    if (previousSocket === undefined) delete process.env["OSSTACK_SOCKET"];
    else process.env["OSSTACK_SOCKET"] = previousSocket;
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, "Pilot failed; primary and cleanup errors retained");
  return result as Result;
}

/** Preserve the one-shot adapter contract and original method receivers. */
export function observePilotAdapter(
  adapter: AgentAdapter,
  onInvoke: () => Promise<void>,
  onEvent: (event: HermesEvent) => Promise<void>,
): AgentAdapter {
  return {
    id: adapter.id, display_name: adapter.display_name, cost_tier: adapter.cost_tier,
    capabilities: () => adapter.capabilities(), isAvailable: () => adapter.isAvailable(),
    ...(adapter.runtimeIdentity === undefined ? {} : { runtimeIdentity: () => adapter.runtimeIdentity!() }),
    async *invoke(task, signal) {
      await onInvoke();
      for await (const event of adapter.invoke(task, signal)) {
        await onEvent(event);
        yield event;
      }
    },
  };
}
