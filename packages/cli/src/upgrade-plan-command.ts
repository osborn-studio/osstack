import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { inspectHomes } from "./home-inventory.js";
import { createUpgradePlan } from "./upgrade-plan.js";
import { UpgradeJournal } from "./upgrade-journal.js";
export const UPGRADE_PLAN_HELP = `homes plan-upgrade --request FILE --registry FILE --journal ABSOLUTE_PRIVATE_DIRECTORY
homes upgrade-status --digest SHA256 --group ID --journal ABSOLUTE_PRIVATE_DIRECTORY
The journal directory must already exist, be private and owned by you.
Planning reads explicitly registered existing daemons. It does not install, drain or restart them.
A plan grants no upgrade authority; real shared-installation upgrade qualification is pending.`;
async function json(path: string): Promise<unknown> {
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > 131072)
      throw Error("invalid_plan_file");
    const buffer = Buffer.alloc(131073);
    let count = 0;
    while (count < buffer.length) {
      const result = await handle.read(
        buffer,
        count,
        buffer.length - count,
        count,
      );
      if (!result.bytesRead) break;
      count += result.bytesRead;
    }
    const after = await handle.stat();
    if (
      count > 131072 ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs
    )
      throw Error("invalid_plan_file");
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        buffer.subarray(0, count),
      ),
    );
  } finally {
    await handle.close();
  }
}
export async function handleUpgradePlanCommand(
  args: string[],
  io: { stdout?: (text: string) => void; stderr?: (text: string) => void } = {},
): Promise<number> {
  const out = io.stdout ?? console.log;
  const err = io.stderr ?? console.error;
  // Escape terminal controls while preserving the underlying JSON values.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional terminal sanitization
  const emit = (value: unknown) =>
    out(
      JSON.stringify(value).replace(/[\u007f-\u009f\p{Cf}\u2028\u2029]/gu, (char) =>
        char
          .split("")
          .map(
            (unit) => "\\u" + unit.charCodeAt(0).toString(16).padStart(4, "0"),
          )
          .join(""),
      ),
    );
  if ((args.length === 1 && args[0] === "--help") || (args.length === 2 && ["plan-upgrade", "upgrade-status"].includes(args[0]!) && args[1] === "--help")) {
    out(UPGRADE_PLAN_HELP);
    return 0;
  }
  try {
    const command = args[0];
    const required =
      command === "plan-upgrade"
        ? ["--request", "--registry", "--journal"]
        : command === "upgrade-status"
          ? ["--digest", "--group", "--journal"]
          : [];
    if (!required.length) throw Error("invalid_upgrade_plan_command");
    const flags = new Map<string, string>();
    for (let index = 1; index < args.length; index++) {
      const key = args[index]!;
      const value = args[++index];
      if (
        !required.includes(key) ||
        flags.has(key) ||
        !value ||
        value.startsWith("--") ||
        value.length > 4096
      )
        throw Error("invalid_upgrade_plan_arguments");
      flags.set(key, value);
    }
    if (flags.size !== required.length || !isAbsolute(flags.get("--journal")!))
      throw Error("invalid_upgrade_plan_arguments");
    const journal = new UpgradeJournal(flags.get("--journal")!);
    if (command === "upgrade-status") {
      emit(await journal.status(flags.get("--digest")!, flags.get("--group")!));
      return 0;
    }
    const request = await json(flags.get("--request")!);
    const inventory = await inspectHomes(await json(flags.get("--registry")!));
    const frozen = createUpgradePlan(request, inventory.homes);
    await journal.create(frozen);
    emit({
      digest: frozen.digest,
      plan: frozen.plan,
      qualification: "qualification_pending",
      execution_started: false,
    });
    return 0;
  } catch {
    err(
      "upgrade_plan_unavailable: verify explicit inputs, private journal, and current home observations",
    );
    return 1;
  }
}
