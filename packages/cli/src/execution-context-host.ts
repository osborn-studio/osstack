import { createHash, randomUUID } from "node:crypto";
import { mkdir, open } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { AgentAdapter } from "@osstack/agents";
import type { ExecutionContextReceipt } from "./execution-context.js";

/** Host-owned receipt writer: immutable evidence, never a prompt/knowledge body. */
export async function persistExecutionContextReceipt(
  home: string,
  receipt: ExecutionContextReceipt,
) {
  if (!isAbsolute(home)) throw new Error("execution_context_home_required");
  const bytes = Buffer.from(JSON.stringify(receipt) + "\n");
  if (bytes.byteLength > 65536)
    throw new Error("execution_context_receipt_too_large");
  const digest = createHash("sha256").update(bytes).digest("hex");
  const directory = join(home, "execution-context-receipts");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `${digest}-${randomUUID()}.json`);
  const file = await open(path, "wx", 0o600);
  try {
    await file.writeFile(bytes);
    await file.sync();
  } finally {
    await file.close();
  }
  const parent = await open(directory, "r");
  try {
    await parent.sync();
  } finally {
    await parent.close();
  }
  // No reference escapes before the complete record and directory are synced. A failed write
  // leaves an unreferenced artifact, never a successful adapter boundary claim.
  return { path, digest };
}

export async function createHostExecutionContext(
  input: {
    adapters: readonly AgentAdapter[];
    workspacePath: string;
    configPath: string;
    contractDigest?: string;
    contractBrief?: string;
  },
  home: string,
) {
  const {
    loadExecutionContextConfig,
    createPinnedLocalContextLoader,
    createExecutionContextAdapters,
  } = await import("./execution-context.js");
  const config = await loadExecutionContextConfig(
    input.configPath,
    input.workspacePath,
  );
  const { createHostSourceContext } = await import("./source-context.js");
  const sources = createHostSourceContext(home);
  const knowledge = createPinnedLocalContextLoader(config);
  const methodContext = config.methods === undefined ? undefined : (await import("./method-context.js")).createMethodContext(config.methods);
  return createExecutionContextAdapters({
    adapters: input.adapters,
    workspacePath: input.workspacePath,
    mode: "local",
    ...(methodContext === undefined ? {} : { methodContext }),
    loadContext: async (task, scope) => [...await knowledge(task, scope), ...await sources.load(task, scope)],
    validateContext: sources.validate,
    validateContextSync: sources.validateSync,
    maxPromptBytes: config.max_prompt_bytes,
    maxKnowledgeBytes: config.max_knowledge_bytes,
    ...(input.contractDigest === undefined
      ? {}
      : { contractDigest: input.contractDigest }),
    ...(input.contractBrief === undefined
      ? {}
      : { contractBrief: input.contractBrief }),
    recordReceipt: (receipt) => persistExecutionContextReceipt(home, receipt),
  });
}
