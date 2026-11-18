import { compileMissionGlob, matchMissionProtectedPath, missionPathRejection } from "@osstack/governance";

export const LOCAL_FAILURE_PROTECTED_GLOBS = Object.freeze([
  "**/*.test.*",
  "**/*.spec.*",
  "**/*_test.*",
  "**/test_*.py",
  "**/tests/**",
  "**/test/**",
  "**/__tests__/**",
  "**/SKILL.md",
  "**/skills/**",
  "**/*-skill/**",
  "loop-engineering/**",
  "**/verification-profiles/**",
]);

const localProtectedPaths = LOCAL_FAILURE_PROTECTED_GLOBS.map((glob) =>
  compileMissionGlob(glob, { caseInsensitive: true }),
);

/** Check inherited scope entries at admission and concrete paths during candidate review. */
export function checkLocalFailureRepairPaths(
  paths: readonly string[],
  verificationPaths: readonly string[] = [],
): "verify_protected_path" | null {
  return paths.some(
    (path) =>
      missionPathRejection(path) ||
      matchMissionProtectedPath(path).length ||
      localProtectedPaths.some((pattern) => pattern.test(path)) ||
      verificationPaths.some((glob) => compileMissionGlob(glob).test(path)),
  )
    ? "verify_protected_path"
    : null;
}
