import { open, writeFile, mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
export async function handleAttentionPlanning(
  args: string[],
  out: (s: string) => void,
): Promise<number> {
  const flags = new Map<string, string>();
  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--json") continue;
    const key = args[i]!;
    const value = args[++i];
    if (
      ![
        "--input",
        "--head",
        "--evidence",
        "--budget",
        "--repo",
        "--mode",
      ].includes(key) ||
      !value ||
      value.startsWith("--") ||
      flags.has(key)
    )
      throw new Error("invalid_planning_arguments");
    flags.set(key, value);
  }
  const read = async (path: string) => {
    const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      const before = await file.stat();
      if (!before.isFile() || before.size > 1048576) throw new Error("invalid_input_file");
      const data = Buffer.alloc(1048577);
      let length = 0;
      while (length < data.length) { const result = await file.read(data, length, data.length - length, null); if (!result.bytesRead) break; length += result.bytesRead; }
      const after = await file.stat();
      if (length > 1048576) throw new Error("oversized_input");
      if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error("input_changed");
      return JSON.parse(data.subarray(0, length).toString());
    } finally {
      await file.close();
    }
  };
  const input = flags.get("--input");
  if (!input) throw new Error("input_required");
  const planning = await import("@osstack/supervisor");
  const mode = flags.get("--mode") ?? "supplied_predictions";
  if (flags.has("--mode") && args[0] !== "routing-eval")
    throw new Error("mode_only_valid_for_routing_eval");
  if (args[0] === "routing-eval") {
    if (!["supplied_predictions", "router_golden", "paired_holdout"].includes(mode))
      throw new Error("invalid_routing_eval_mode");
    if ([...flags.keys()].some((k) => !["--input", "--mode"].includes(k)))
      throw new Error("invalid_routing_eval_arguments");
    if (mode === "paired_holdout") {
      const { runControlledPairedRouting } = await import("./paired-routing-evaluation.js");
      const report = await runControlledPairedRouting(await read(input));
      out(JSON.stringify(report, null, 2).replace(/[\u007f-\u009f\p{Cf}\u2028\u2029]/gu,
        character => character.split("").map(unit => `\\u${unit.charCodeAt(0).toString(16).padStart(4, "0")}`).join("")));
      return report.status === "completed" ? 0 : 1;
    }
    if (mode === "router_golden") {
      let raw: unknown;
      try {
        raw = await read(input);
      } catch {
        const report = await planning.evaluateRoutingGolden(null);
        report.dataset_hash = null;
        report.errors = ["input_unreadable_or_invalid_json"];
        out(JSON.stringify(report, null, 2));
        return 1;
      }
      const { runProfileRoutingGolden } = await import(
        "./attention-routing-evaluation.js"
      );
      const report = await planning.evaluateRoutingGolden(
        raw,
        runProfileRoutingGolden,
      );
      out(JSON.stringify(report, null, 2));
      return report.status === "passed" ? 0 : 1;
    }
  }
  const data = await read(input);
  let result: unknown;
  switch (args[0]) {
    case "contract": {
      const plan = flags.has("--evidence")
        ? planning.verifyDeliveryContract(
            data,
            await read(flags.get("--evidence")!),
          )
        : flags.has("--head")
          ? planning.promoteScout(data, flags.get("--head")!)
          : planning.deliveryContract(data);
      result = {
        ...plan,
        qualification: "offline_supplied_data_only",
        execution_verified: false,
        runtime_contract_version: 2,
      };
      break;
    }
    case "routing-eval":
      result = {
        ...planning.evaluateAttentionRouting(data),
        mode: "supplied_predictions",
        qualification: "supplied_predictions_only",
        router_executed: false,
      };
      break;
    case "triage":
      result = planning.acceptAttentionTriage(data, 1, {
        category: "source_uncertain",
        explanation:
          "Use deterministic source facts; model output unavailable or invalid.",
      });
      break;
    case "context":
      result = planning.budgetAttentionContext(
        data,
        Number(flags.get("--budget") ?? 8000),
        Date.now(),
      );
      break;
    case "lesson": {
      if (!flags.has("--repo")) throw new Error("repo_required");
      const repo = await realpath(flags.get("--repo")!);
      const { renderLessonDraft } = await import("@osstack/loop");
      const content = renderLessonDraft(data);
      const directory = join(repo, "loop-lessons", "drafts");
      await mkdir(directory, { recursive: true });
      const path = join(directory, `attention-${randomUUID()}.md`);
      await writeFile(path, content, { flag: "wx" });
      result = { path, state: "draft", promoted: false };
      break;
    }
    default:
      throw new Error("unknown_planning_command");
  }
  out(JSON.stringify(result, null, 2));
  return 0;
}
