import { describe, expect, it, vi } from "vitest";
import { handleHermesCommand, type HermesCommandDeps } from "./hermes-command.js";

function commandDeps() {
  const rpc = vi.fn<HermesCommandDeps["rpc"]>(async () => ({
    ok: true,
    result: { reachable: true },
  }));
  const openUrl = vi.fn<NonNullable<HermesCommandDeps["openUrl"]>>(async () => undefined);
  const stdout = vi.fn<(line: string) => void>();
  const stderr = vi.fn<(line: string, detail?: string) => void>();
  return { deps: { rpc, openUrl, stdout, stderr }, rpc, openUrl, stdout, stderr };
}

describe("Hermes command module", () => {
  it("routes health through the daemon bridge RPC", async () => {
    const { deps, rpc, stdout } = commandDeps();

    expect(await handleHermesCommand(["health"], deps)).toBe(0);

    expect(rpc).toHaveBeenCalledWith("hermes.health");
    expect(stdout).toHaveBeenCalledWith(JSON.stringify({ reachable: true }, null, 2));
  });

  it("opens the configured local dashboard URL", async () => {
    const { deps, openUrl, stdout } = commandDeps();

    expect(await handleHermesCommand(["dashboard"], {
      ...deps,
      env: {
        HERMES_WEBUI_HOST: "localhost",
        HERMES_WEBUI_PORT: "9898",
      },
    })).toBe(0);

    expect(stdout).toHaveBeenCalledWith("osstack: opening http://localhost:9898");
    expect(openUrl).toHaveBeenCalledWith("http://localhost:9898");
  });

  it("prints bridge help without contacting the daemon", async () => {
    const { deps, rpc, stdout } = commandDeps();

    expect(await handleHermesCommand(["help"], deps)).toBe(0);

    expect(rpc).not.toHaveBeenCalled();
    expect(String(stdout.mock.calls[0]?.[0])).toContain("osstack hermes — bridge commands");
  });
});
