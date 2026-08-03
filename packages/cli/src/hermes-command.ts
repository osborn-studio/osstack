interface HermesCommandRpcResponse {
  ok: boolean;
  result?: unknown;
  error?: { message: string };
}

export interface HermesCommandDeps {
  rpc: (method: string, params?: unknown) => Promise<unknown>;
  env?: Readonly<Record<string, string | undefined>>;
  openUrl?: (url: string) => void | Promise<void>;
  stdout?: (line: string) => void;
  stderr?: (line: string, detail?: string) => void;
}

async function openLocalUrl(url: string): Promise<void> {
  const { spawn } = await import("node:child_process");
  spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
}

export async function handleHermesCommand(
  args: string[],
  deps: HermesCommandDeps,
): Promise<number> {
  const env = deps.env ?? process.env;
  const openUrl = deps.openUrl ?? openLocalUrl;
  const stdout = deps.stdout ?? console.log;
  const stderr = deps.stderr ?? console.error;
  const sub = args[0];

  if (sub === "health") {
    const response = (await deps.rpc("hermes.health")) as HermesCommandRpcResponse;
    if (!response.ok) {
      stderr("osstack:", response.error?.message ?? "hermes.health failed");
      return 1;
    }
    stdout(JSON.stringify(response.result, null, 2));
    return 0;
  }

  if (sub === "dashboard") {
    const port = env["HERMES_WEBUI_PORT"] ?? "8787";
    const host = env["HERMES_WEBUI_HOST"] ?? "127.0.0.1";
    const url = `http://${host}:${port}`;
    stdout(`osstack: opening ${url}`);
    await openUrl(url);
    return 0;
  }

  if (sub === "register-cron") {
    // Print a few example `hermes cron` invocations the user can run manually.
    stdout(`# Example Hermes cron tasks that drive osstack from a schedule.
# Adapt to your workflow and run any of these via \`hermes cron add\`.

# 1) Nightly stats roll-up (e.g. 03:00 local).
hermes cron add --schedule "0 3 * * *" --name osstack-nightly-stats -- \\
  bash -lc 'osstack stats > ~/.osstack/logs/stats-$(date +%F).txt'

# 2) Daily run-history pruning (keep last 30 days of events).
hermes cron add --schedule "30 3 * * *" --name osstack-prune -- \\
  bash -lc 'sqlite3 ~/.osstack/state.db "DELETE FROM events WHERE created_at < strftime(\\'%s\\',\\'now\\',\\'-30 days\\');"'

# 3) Weekly skill-registry check (skill-registry lands in S6; placeholder for now).
# hermes cron add --schedule "0 4 * * 1" --name osstack-skills-check -- osstack skills check
`);
    return 0;
  }

  if (sub === "help" || sub === undefined) {
    stdout(`osstack hermes — bridge commands

  osstack hermes health           Show bridge config + reachability
  osstack hermes dashboard        Open the Hermes WebUI in a browser
  osstack hermes register-cron    Print example \`hermes cron\` snippets

Env:
  HERMES_BIN              Override hermes binary path
  HERMES_KANBAN_BOARD     Board slug for sync (sync is OFF unless set)
  HERMES_WEBUI_PORT/HOST  Where the WebUI listens (default 127.0.0.1:8787)
`);
    return 0;
  }

  stderr(`osstack: unknown hermes subcommand "${sub}"`);
  return 1;
}
