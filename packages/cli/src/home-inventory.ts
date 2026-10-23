import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath, stat } from "node:fs/promises";
import { connect } from "node:net";
import { isAbsolute, join } from "node:path";
import { z } from "zod";

const HomeId = z.string().regex(/^home_[a-f0-9]{32}$/);
const Digest = z.string().regex(/^[a-f0-9]{64}$/);
const boundedText = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9.+_-]+$/);
export const DeploymentIdentitySchema = z
  .object({
    schema_version: z.literal(1),
    home_id: HomeId,
    generation: z.string().regex(/^instance_[a-f0-9]{32}$/),
    version: boundedText,
    protocol_version: z.number().int().positive(),
    database_schema: z.number().int().nonnegative(),
    started_at_ms: z.number().int().nonnegative(),
    deployment_kind: z.enum(["npm", "checkout", "unknown"]),
    build_digest: Digest.nullable(),
    build_evidence: z.enum(["host_manifest", "unavailable"]),
  })
  .strict()
  .refine(
    (value) =>
      (value.build_evidence === "unavailable") ===
      (value.build_digest === null),
  );
export type DeploymentIdentity = z.infer<typeof DeploymentIdentitySchema>;
const Manifest = z
  .object({
    schema_version: z.literal(1),
    homes: z
      .array(
        z
          .object({
            home_id: HomeId,
            socket: z.string().min(1).max(4096).refine(isAbsolute),
            enabled: z.boolean(),
            desired: z
              .object({
                version: boundedText,
                protocol_version: z.number().int().positive().optional(),
                database_schema: z.number().int().nonnegative().optional(),
                deployment_kind: z.enum(["npm", "checkout"]).optional(),
                build_digest: Digest.optional(),
              })
              .strict(),
          })
          .strict(),
      )
      .min(1)
      .max(32),
  })
  .strict()
  .refine(
    (value) =>
      new Set(value.homes.map((home) => home.home_id)).size ===
        value.homes.length &&
      new Set(value.homes.map((home) => home.socket)).size ===
        value.homes.length,
  );
type HomeEntry = z.infer<typeof Manifest>["homes"][number];
type Status =
  | "matched"
  | "drift"
  | "unknown"
  | "unreachable"
  | "identity_mismatch"
  | "unsafe_endpoint"
  | "disabled";
export interface HomeObservation {
  desired: HomeEntry;
  observed: DeploymentIdentity | null;
  observed_at_ms: number;
  status: Status;
  reason: string | null;
}

/** Only the authorized daemon startup calls this initializer. Inventory never does. */
export async function ensureDeploymentHomeId(home: string): Promise<string> {
  const path = join(home, "deployment-identity.json");
  try {
    const parent = await lstat(home);
    if (
      !parent.isDirectory() ||
      (process.getuid && parent.uid !== process.getuid())
    )
      throw new Error();
    try {
      const file = await open(
        path,
        constants.O_CREAT |
          constants.O_EXCL |
          constants.O_WRONLY |
          constants.O_NOFOLLOW,
        0o600,
      );
      try {
        await file.writeFile(
          JSON.stringify({
            schema_version: 1,
            home_id: `home_${randomBytes(16).toString("hex")}`,
          }),
        );
        await file.sync();
      } finally {
        await file.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const file = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const info = await file.stat();
      if (
        !info.isFile() ||
        info.size > 256 ||
        (process.getuid && info.uid !== process.getuid())
      )
        throw new Error();
      const buffer = Buffer.alloc(257);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      if (bytesRead > 256) throw new Error();
      return z
        .object({ schema_version: z.literal(1), home_id: HomeId })
        .strict()
        .parse(JSON.parse(buffer.subarray(0, bytesRead).toString())).home_id;
    } finally {
      await file.close();
    }
  } catch {
    throw new Error("identity_unavailable");
  }
}

/** Fixed read-only RPC, 64KiB total response bound before buffering. No DB or generic method port. */
export function readHomeIdentity(
  socketPath: string,
  timeoutMs = 3000,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    let bytes = Buffer.alloc(0);
    let settled = false;
    const finish = (error?: string, value?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      error ? reject(new Error(error)) : resolve(value);
    };
    const timer = setTimeout(
      () => finish("unreachable"),
      Math.min(3000, Math.max(1, timeoutMs)),
    );
    socket.on("error", () => finish("unreachable"));
    socket.on("close", () => finish("invalid_response"));
    socket.on("connect", () => {
      const body = Buffer.from(
        JSON.stringify({ id: 1, method: "deployment.identity" }),
      );
      const header = Buffer.alloc(4);
      header.writeUInt32BE(body.length);
      socket.write(Buffer.concat([header, body]));
    });
    socket.on("data", (chunk) => {
      if (bytes.length + chunk.length > 65536) {
        finish("invalid_response");
        return;
      }
      bytes = Buffer.concat([bytes, chunk]);
      if (bytes.length < 4) return;
      const size = bytes.readUInt32BE();
      if (size > 65532) {
        finish("invalid_response");
        return;
      }
      if (bytes.length < 4 + size) return;
      if (bytes.length !== 4 + size) {
        finish("invalid_response");
        return;
      }
      try {
        const response = z
          .object({
            id: z.literal(1),
            ok: z.literal(true),
            result: DeploymentIdentitySchema,
          })
          .strict()
          .parse(JSON.parse(bytes.subarray(4).toString()));
        finish(undefined, response.result);
      } catch {
        finish("invalid_response");
      }
    });
  });
}

/** Local same-UID socket/file ownership is a trust boundary, not network authentication. */
export async function inspectHomes(
  raw: unknown,
): Promise<{
  schema_version: 1;
  mode: "readonly_inventory";
  complete: boolean;
  homes: HomeObservation[];
  limitations: string[];
}> {
  const parsed = Manifest.safeParse(raw);
  if (!parsed.success) throw new Error("invalid_manifest");
  const rows: HomeObservation[] = parsed.data.homes.map((desired) => ({
    desired,
    observed: null,
    observed_at_ms: Date.now(),
    status: "disabled",
    reason: null,
  }));
  const canonicalSockets = new Set<string>();
  for (const row of rows) {
    if (!row.desired.enabled) continue;
    const canonical = await realpath(row.desired.socket).catch(() => null);
    if (canonical !== null) {
      if (canonicalSockets.has(canonical)) throw new Error("duplicate_socket");
      canonicalSockets.add(canonical);
    }
  }
  let next = 0;
  const worker = async () => {
    while (next < rows.length) {
      const row = rows[next++]!;
      if (!row.desired.enabled) continue;
      try {
        const canonical = await realpath(row.desired.socket);
        const info = await stat(row.desired.socket);
        if (
          !info.isSocket() ||
          (process.getuid && info.uid !== process.getuid())
        ) {
          row.status = "unsafe_endpoint";
          row.reason = "canonical_same_uid_socket_required";
          continue;
        }
        let observed: DeploymentIdentity;
        try {
          observed = DeploymentIdentitySchema.parse(
            await readHomeIdentity(row.desired.socket),
          );
        } catch (error) {
          row.status =
            error instanceof Error && error.message === "unreachable"
              ? "unreachable"
              : "unknown";
          row.reason = "identity_unavailable";
          continue;
        }
        if ((await realpath(row.desired.socket)) !== canonical) {
          row.status = "unsafe_endpoint";
          row.reason = "endpoint_changed";
          continue;
        }
        row.observed_at_ms = Date.now();
        if (observed.home_id !== row.desired.home_id) {
          row.status = "identity_mismatch";
          row.reason = "pinned_home_mismatch";
          continue;
        }
        row.observed = observed;
        const desired = row.desired.desired;
        const unknown =
          (desired.build_digest !== undefined &&
            observed.build_digest === null) ||
          (desired.deployment_kind !== undefined &&
            observed.deployment_kind === "unknown");
        const drift =
          desired.version !== observed.version ||
          (desired.protocol_version !== undefined &&
            desired.protocol_version !== observed.protocol_version) ||
          (desired.database_schema !== undefined &&
            desired.database_schema !== observed.database_schema) ||
          (desired.build_digest !== undefined &&
            observed.build_digest !== null &&
            desired.build_digest !== observed.build_digest) ||
          (desired.deployment_kind !== undefined &&
            observed.deployment_kind !== "unknown" &&
            desired.deployment_kind !== observed.deployment_kind);
        row.status = drift ? "drift" : unknown ? "unknown" : "matched";
        row.reason = unknown ? "deployment_evidence_unavailable" : null;
      } catch {
        row.status = "unreachable";
        row.reason = "endpoint_unavailable";
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, rows.length) }, worker));
  return {
    schema_version: 1,
    mode: "readonly_inventory",
    complete: rows.every(
      (row) => row.status === "matched" || row.status === "disabled",
    ),
    homes: rows,
    limitations: [
      "Local same-UID sockets with canonical alias deduplication only; no network or peer-credential attestation.",
      "No database opened, daemon started, software installed or deployment modified.",
      "Matched applies only to declared desired fields; missing build/deployment evidence is never inferred.",
      "Snapshot only; generation is reported for comparison, not an upgrade authorization.",
    ],
  };
}

export async function handleHomesCommand(
  args: string[],
  out: (value: string) => void = console.log,
): Promise<number> {
  if (args.length === 1 && args[0] === "--help") {
    out(
      "homes inspect --manifest FILE [--json]\nRead only explicitly pinned local home identities; never upgrades or opens databases.",
    );
    return 0;
  }
  if (
    args[0] !== "inspect" ||
    args[1] !== "--manifest" ||
    !args[2] ||
    (args.length !== 3 && !(args.length === 4 && args[3] === "--json"))
  )
    throw new Error("invalid_homes_arguments");
  const file = await open(args[2], constants.O_RDONLY | constants.O_NONBLOCK);
  let raw: unknown;
  try {
    const info = await file.stat();
    if (!info.isFile()) throw new Error("invalid_manifest");
    const buffer = Buffer.alloc(65537);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 65536) throw new Error("manifest_too_large");
    raw = JSON.parse(buffer.subarray(0, bytesRead).toString());
  } finally {
    await file.close();
  }
  const result = await inspectHomes(raw);
  out(JSON.stringify(result, null, 2));
  return result.complete ? 0 : 1;
}
