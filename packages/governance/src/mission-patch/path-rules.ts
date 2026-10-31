export type MissionPathRejection =
  | "PATH_ABSOLUTE"
  | "PATH_BACKSLASH"
  | "PATH_CONTROL_CHAR"
  | "PATH_GIT_DIR"
  | "PATH_INVALID"
  | "PATH_TRAVERSAL";

/** First reason a repository-relative path is unsafe, or undefined when it is safe. */
export function missionPathRejection(path: string): MissionPathRejection | undefined {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this rejects.
  if (/[\u0000-\u001f\u007f]/.test(path)) return "PATH_CONTROL_CHAR";
  if (path.includes("\\")) return "PATH_BACKSLASH";
  if (path.startsWith("/") || /^[A-Za-z]:/.test(path)) return "PATH_ABSOLUTE";
  const segments = path.split("/");
  if (segments.some((segment) => segment === "." || segment === "..")) return "PATH_TRAVERSAL";
  if (segments.some((segment) => segment === "")) return "PATH_INVALID";
  // Case-folded, with trailing dots/spaces dropped, so `.GIT` and `.git.` also count.
  if (segments.some((segment) => segment.toLowerCase().replace(/[. ]+$/, "") === ".git")) {
    return "PATH_GIT_DIR";
  }
  return undefined;
}

/**
 * Compiles a path glob: `**` spans segments (`a/**`, `**\/b`), `*` and `?` stay
 * inside one segment. Everything else is literal.
 */
export function compileMissionGlob(glob: string, options: { caseInsensitive?: boolean } = {}): RegExp {
  let source = "";
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index]!;
    if (char === "*" && glob[index + 1] === "*") {
      const atStart = index === 0 || glob[index - 1] === "/";
      const next = glob[index + 2];
      if (atStart && next === "/") {
        source += "(?:.*/)?";
        index += 2;
      } else if (atStart && next === undefined && index > 0) {
        source = `${source.slice(0, -1)}(?:/.*)?`;
        index += 1;
      } else {
        source += ".*";
        index += 1;
      }
    } else if (char === "*") {
      source += "[^/]*";
    } else if (char === "?") {
      source += "[^/]";
    } else {
      source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${source}$`, options.caseInsensitive === true ? "i" : "");
}
