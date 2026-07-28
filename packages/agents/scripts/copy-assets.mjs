import { copyFile, mkdir } from "node:fs/promises";

await mkdir(new URL("../dist/adapters/", import.meta.url), { recursive: true });
await copyFile(
  new URL("../src/adapters/kimi-review-agent.md", import.meta.url),
  new URL("../dist/adapters/kimi-review-agent.md", import.meta.url),
);
