import { open, writeFile, mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
export async function handleAttentionPlanning(
  args: string[],
  out: (s: string) => void
): Promise<number> {
  const flags = new Map<string, string>();
  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--json") continue;
    const key = args[i]!;
    const value = args[++i];
    if (
      !["--input", "--head", "--evidence", "--budget", "--repo"].includes(
        key
      ) ||
      !value ||
      value.startsWith("--") ||
      flags.has(key)
    )
      throw new Error("invalid_planning_arguments");
    flags.set(key, value);
  }
  const read = async (path: string) => {
    const file = await open(path, "r");
    try {
      const data = Buffer.alloc(1048577);
      const result = await file.read(data, 0, data.length, 0);
      if (result.bytesRead > 1048576) throw new Error("oversized_input");
      return JSON.parse(data.subarray(0, result.bytesRead).toString());
    } finally {
      await file.close();
    }
  };
  const input = flags.get("--input");
  if (!input) throw new Error("input_required");
  const data = await read(input);
  const planning = await import("@osstack/supervisor");
  let result: unknown;
  switch (args[0]) {
    case "contract":
      result = flags.has("--evidence")
        ? planning.verifyDeliveryContract(
            data,
            await read(flags.get("--evidence")!)
          )
        : flags.has("--head")
        ? planning.promoteScout(data, flags.get("--head")!)
        : planning.deliveryContract(data);
      break;
    case "routing-eval":
      result = planning.evaluateAttentionRouting(data);
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
        Date.now()
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
