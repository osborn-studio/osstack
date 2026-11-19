import { createHash } from "node:crypto";

export function externalDecisionItemId(source: string, sourceId: string, identity: number | string | null): string {
  const digest = createHash("sha256").update(JSON.stringify([source, sourceId, identity])).digest("hex");
  return "decision:" + digest.slice(0, 32);
}
