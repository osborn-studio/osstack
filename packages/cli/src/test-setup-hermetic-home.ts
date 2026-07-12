// R2.1 test hermeticity guard.
//
// Points OSSTACK_HOME at a fresh throwaway directory BEFORE any test module in
// this package loads. vitest imports setupFiles ahead of the test file (and its
// top-level code), so by the time any suite calls osstackHome() / openStateDb()
// / main() the home already resolves under the system tmpdir. This makes it
// structurally impossible for a test that forgets to override the home to read
// or migrate the developer's real ~/.osstack/state.db.
//
// Tests that intentionally exercise a custom home still set their own
// OSSTACK_HOME inside beforeEach/beforeAll; those run after this file and win.
//
// OSSTACK_SOCKET is intentionally left untouched: resolveSocketPath() derives it
// from OSSTACK_HOME (see src/paths.ts), so pinning the home pins the socket too.
// The assignment is unconditional so an external OSSTACK_HOME export (e.g. left
// over in a shell) can never leak the real home into the suite.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const hermeticHome = mkdtempSync(join(tmpdir(), "osstack-vitest-home-"));
process.env["OSSTACK_HOME"] = hermeticHome;
