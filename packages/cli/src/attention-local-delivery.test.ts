import { mkdtemp, rm, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { localAttentionSender } from "./attention-local-delivery.js";
it("publishes one atomic local receipt across duplicate and concurrent delivery attempts", async () => {
  const root = await mkdtemp(join(tmpdir(), "attention-delivery-"));
  try {
    const sender = localAttentionSender(root);
    const msg = {
      delivery_id: "item:1",
      scope_id: "scope",
      item_id: "item",
      question: "Choose?",
      state: "open",
    };
    await Promise.all([
      sender(msg, new AbortController().signal),
      sender(msg, new AbortController().signal),
    ]);
    const files = await readdir(join(root, "attention-notifications"));
    expect(files).toHaveLength(1);
    expect(
      JSON.parse(
        await readFile(join(root, "attention-notifications", files[0]!), "utf8")
      ).delivery_id
    ).toBe("item:1");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
