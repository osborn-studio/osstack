import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile, link, unlink, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AttentionSender } from "@osstack/core";
/** Atomic local receipt keyed by delivery ID. Retries cannot duplicate the artifact. */
export function localAttentionSender(home: string): AttentionSender {
  return async (message, signal) => {
    if (signal.aborted) throw new Error("aborted");
    const dir = join(home, "attention-notifications");
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const id = createHash("sha256").update(message.delivery_id).digest("hex");
    const target = join(dir, `${id}.json`);
    const temp = join(dir, `.${id}.${randomUUID()}.tmp`);
    const body = JSON.stringify({ ...message, transport: "local_spool" });
    await writeFile(temp, body, { flag: "wx", mode: 0o600 });
    try {
      if (signal.aborted) throw new Error("aborted");
      try {
        await link(temp, target);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        if ((await readFile(target, "utf8")) !== body)
          throw new Error("delivery_collision");
      }
    } finally {
      await unlink(temp).catch(() => {});
    }
  };
}
