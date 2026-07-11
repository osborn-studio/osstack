// @osstack/conformance — kernel consumption conformance suite.
//
// This package is `private: true` and never published. Its entire purpose is
// to prove — from the position of an *external kernel consumer* — that the
// osstack kernel (@osstack/core + @osstack/loop + @osstack/agents) is usable
// WITHOUT the osstack CLI product package, and to pin the known kernel gaps
// (ADR-001 Gap D2) as explicit, executable expectations that must flip when
// they are closed.
//
// The runtime surface is intentionally minimal: the value lives in `src/*.test.ts`.

export const CONFORMANCE_VERSION = "0.0.0";
