import { lstat, mkdir, open, rename, rm, unlink, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { VerificationHarnessRecord } from "@osstack/core/verification-publish";
import { z } from "zod";
import type { StoppedResult } from "./record.js";

export interface HarnessRequest {
  version: 1;
  repository_id: number;
  pr: number;
  skill_id: string;
  head_sha: string;
  base_sha: string;
  record: VerificationHarnessRecord;
}
const uuid = z.string().uuid();
const writeError = () => new Error("request_write_failed");

export async function writeRequestFile(dropDir: string, request: HarnessRequest): Promise<string> {
  try {
    const id = request.record.invocation_id;
    if (!isAbsolute(dropDir) || !uuid.safeParse(id).success) throw writeError();
    const text = JSON.stringify(request);
    if (Buffer.byteLength(text) > 262144) throw writeError();
    const file = id + ".json";
    const final = join(dropDir, file);
    // A single exclusive staging name serializes writers for this invocation through rename.
    const temporary = join(dropDir, "." + id + ".tmp");
    const handle = await open(temporary, "wx", 0o600);
    let renamed = false;
    try {
      try {
        const exists = await lstat(final).then(() => true, (error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
          return false;
        });
        if (exists) throw writeError();
        await handle.writeFile(text);
        // The operator's set-group-ID drop directory supplies the group. Keep the owner and group.
        await handle.chmod(0o640);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, final);
      renamed = true;
      const dir = await open(dropDir, "r");
      try { await dir.sync(); } finally { await dir.close(); }
      return file;
    } finally {
      if (!renamed) await unlink(temporary);
    }
  } catch {
    throw writeError();
  }
}

export async function writeEvidence(evidenceDir: string, invocationId: string,
  parts: Pick<StoppedResult, "stdout" | "stderr" | "stopReceipt">): Promise<void> {
  try {
    if (!isAbsolute(evidenceDir) || !uuid.safeParse(invocationId).success) throw writeError();
    const dir = join(evidenceDir, invocationId);
    await mkdir(dir, { mode: 0o700 });
    const options = { mode: 0o600, flag: "wx" };
    try {
      await writeFile(join(dir, "stdout"), parts.stdout.bytes, options);
      await writeFile(join(dir, "stderr"), parts.stderr.bytes, options);
      await writeFile(join(dir, "stop-receipt.json"), JSON.stringify(parts.stopReceipt), options);
    } catch (error) {
      await rm(dir, { recursive: true, force: true });
      throw error;
    }
  } catch {
    throw writeError();
  }
}
