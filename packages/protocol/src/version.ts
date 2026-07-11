// Protocol version — the single source of truth for the wire protocol major/minor.
//
// PROTOCOL_VERSION is the version THIS package emits. Per AGENT_COMMAND_PROTOCOL_V1
// (A-007), envelopes carry a `protocol_version` string matched by `ProtocolVersion`.
// A breaking change is a new MAJOR + a new frozen fixture corpus; minor additions
// (new optional fields/commands/error codes) stay backward compatible.

import { z } from "zod";

/** The protocol version this package produces. Bumped on every published change. */
export const PROTOCOL_VERSION = "1.0" as const;

/**
 * Accepts any minor of protocol major 1 (`1.0`, `1.1`, …), matching the
 * `^1\.[0-9]+$` pattern in the spec JSON Schemas. A consumer on 1.0 therefore
 * accepts a 1.1 producer's version string (forward compatible within the major).
 */
export const ProtocolVersion = z.string().regex(/^1\.[0-9]+$/, {
  message: "protocol_version must match ^1.[0-9]+$ (protocol major 1)",
});
export type ProtocolVersion = z.infer<typeof ProtocolVersion>;
