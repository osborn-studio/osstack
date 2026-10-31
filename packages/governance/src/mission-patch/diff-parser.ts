import { type MissionPathRejection, missionPathRejection } from "./path-rules.js";

export const MISSION_PATCH_MAX_BYTES = 256 * 1024;

export type MissionPatchRejectionCode =
  | MissionPathRejection
  | "BINARY_REJECTED"
  | "COPY_REJECTED"
  | "DUPLICATE_FILE"
  | "HUNK_MALFORMED"
  | "MODE_CHANGE_REJECTED"
  | "PATCH_EMPTY"
  | "PATCH_MALFORMED"
  | "PATCH_NOT_UTF8"
  | "PATCH_TOO_LARGE"
  | "RENAME_REJECTED"
  | "SUBMODULE_REJECTED"
  | "SYMLINK_REJECTED";

export interface MissionPatchRejection {
  code: MissionPatchRejectionCode;
  path?: string;
  /** 1-based line of the patch text where the problem was seen. */
  patchLine?: number;
}

export type MissionPatchFileKind = "modify" | "add" | "delete";

export interface MissionPatchAddedLine {
  /** 1-based line number in the new file. */
  line: number;
  /** 1-based line of the patch text. */
  patchLine: number;
  text: string;
}

export interface MissionPatchFile {
  path: string;
  /** 1-based patch line where this file's section starts. */
  patchLine: number;
  kind: MissionPatchFileKind;
  added: number;
  removed: number;
  /** UTF-8 bytes of the added lines, newlines included. */
  addedBytes: number;
  addedLines: MissionPatchAddedLine[];
}

export type MissionPatchParseResult =
  | { ok: true; files: MissionPatchFile[] }
  | { ok: false; rejections: MissionPatchRejection[] };

const encoder = new TextEncoder();
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: .*)?$/;
const INDEX_LINE = /^index [0-9a-f]+\.\.[0-9a-f]+(?: (\d{6}))?$/;

/**
 * Parses a bounded unified diff (git or plain `--- a/` / `+++ b/` sections).
 * Anything that is not a content change to a regular text file is rejected.
 */
export function parseMissionPatch(input: string | Uint8Array): MissionPatchParseResult {
  const decoded = decodeMissionPatch(input);
  if (typeof decoded !== "string") return { ok: false, rejections: [decoded] };
  if (decoded === "") return { ok: false, rejections: [{ code: "PATCH_EMPTY" }] };
  return new Parser(decoded).run();
}

/** Size and UTF-8 checks shared by the parser and the patch-channel secret scan. */
export function decodeMissionPatch(input: string | Uint8Array): string | MissionPatchRejection {
  if (typeof input === "string") {
    if (input.length > MISSION_PATCH_MAX_BYTES) return { code: "PATCH_TOO_LARGE" };
    if (LONE_SURROGATE.test(input)) return { code: "PATCH_NOT_UTF8" };
    if (encoder.encode(input).length > MISSION_PATCH_MAX_BYTES) return { code: "PATCH_TOO_LARGE" };
    return input;
  }
  if (input.byteLength > MISSION_PATCH_MAX_BYTES) return { code: "PATCH_TOO_LARGE" };
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(input);
  } catch {
    return { code: "PATCH_NOT_UTF8" };
  }
}

interface Section {
  gitPath?: string;
  oldPath?: string | null;
  newPath?: string | null;
  newFileMode?: string;
  deletedFileMode?: string;
  startLine: number;
  rejections: MissionPatchRejection[];
  hunks: number;
  lastOldStart: number;
  lastNewStart: number;
  file: MissionPatchFile;
}

class Fatal extends Error {
  constructor(readonly rejection: MissionPatchRejection) {
    super(rejection.code);
  }
}

class Parser {
  private readonly lines: string[];
  private index = 0;
  private readonly rejections: MissionPatchRejection[] = [];
  private readonly files: MissionPatchFile[] = [];
  private readonly seen = new Set<string>();

  constructor(text: string) {
    this.lines = text.split("\n");
    if (this.lines[this.lines.length - 1] === "") this.lines.pop();
  }

  run(): MissionPatchParseResult {
    try {
      while (this.index < this.lines.length) this.section();
    } catch (error) {
      if (!(error instanceof Fatal)) throw error;
      this.rejections.push(error.rejection);
    }
    if (this.rejections.length > 0) return { ok: false, rejections: sortRejections(this.rejections) };
    if (this.files.length === 0) return { ok: false, rejections: [{ code: "PATCH_EMPTY" }] };
    return { ok: true, files: this.files };
  }

  private fatal(code: MissionPatchRejectionCode, path?: string): never {
    throw new Fatal({ code, ...(path === undefined ? {} : { path }), patchLine: this.index + 1 });
  }

  private section(): void {
    const line = this.lines[this.index]!;
    const section: Section = {
      startLine: this.index + 1,
      rejections: [],
      hunks: 0,
      lastOldStart: 0,
      lastNewStart: 0,
      file: { path: "", patchLine: this.index + 1, kind: "modify", added: 0, removed: 0, addedBytes: 0, addedLines: [] },
    };
    if (line.startsWith("diff --git ")) {
      const gitPath = parseGitHeaderPath(line.slice("diff --git ".length));
      if (gitPath !== undefined) section.gitPath = gitPath;
      this.index += 1;
      this.extendedHeaders(section);
    } else if (!line.startsWith("--- ")) {
      this.fatal("PATCH_MALFORMED");
    }

    if (this.lines[this.index]?.startsWith("--- ")) {
      section.oldPath = this.filePath(this.lines[this.index]!.slice(4), "a/");
      const plus = this.lines[this.index + 1];
      if (plus === undefined || !plus.startsWith("+++ ")) {
        this.index += 1;
        this.fatal("PATCH_MALFORMED");
      }
      this.index += 1;
      section.newPath = this.filePath(plus.slice(4), "b/");
      this.index += 1;
      while (this.lines[this.index]?.startsWith("@@") === true) this.hunk(section);
      if (section.hunks === 0) this.fatal("HUNK_MALFORMED");
    }
    this.finish(section);
  }

  private extendedHeaders(section: Section): void {
    while (this.index < this.lines.length) {
      const line = this.lines[this.index]!;
      if (line.startsWith("--- ") || line.startsWith("diff --git ")) return;
      const reject = (code: MissionPatchRejectionCode) => section.rejections.push({ code, patchLine: this.index + 1 });
      const modeLine = line.match(/^(new file mode|deleted file mode|old mode|new mode) (\d{6})$/);
      const indexLine = line.match(INDEX_LINE);
      if (modeLine !== null) {
        const header = modeLine[1]!;
        const mode = modeLine[2]!;
        if (header === "new file mode") section.newFileMode = mode;
        else if (header === "deleted file mode") section.deletedFileMode = mode;
        else reject("MODE_CHANGE_REJECTED");
        const code = modeRejection(mode, header === "new file mode" ? ["100644"] : ["100644", "100755"]);
        if (code !== undefined) reject(code);
      } else if (/^(?:rename (?:from|to) |(?:dis)?similarity index )/.test(line)) {
        reject("RENAME_REJECTED");
      } else if (/^copy (?:from|to) /.test(line)) {
        reject("COPY_REJECTED");
      } else if (indexLine !== null) {
        const code = indexLine[1] === undefined ? undefined : modeRejection(indexLine[1], ["100644", "100755"]);
        if (code !== undefined) reject(code);
      } else if (line === "GIT binary patch" || /^Binary files .* differ$/.test(line)) {
        this.fatal("BINARY_REJECTED", section.gitPath);
      } else {
        this.fatal("PATCH_MALFORMED");
      }
      this.index += 1;
    }
  }

  private filePath(raw: string, prefix: "a/" | "b/"): string | null {
    const value = raw.includes("\t") && !raw.startsWith("\"") ? raw.slice(0, raw.indexOf("\t")) : raw;
    if (value === "/dev/null") return null;
    const path = value.startsWith("\"") ? unquoteGitPath(value) : value;
    if (path === undefined || !path.startsWith(prefix)) this.fatal("PATCH_MALFORMED");
    return path.slice(prefix.length);
  }

  private hunk(section: Section): void {
    const match = this.lines[this.index]!.match(HUNK_HEADER);
    if (match === null) this.fatal("HUNK_MALFORMED");
    const oldStart = Number(match[1]);
    const newStart = Number(match[3]);
    let oldLeft = match[2] === undefined ? 1 : Number(match[2]);
    let newLeft = match[4] === undefined ? 1 : Number(match[4]);
    if (oldLeft + newLeft === 0 || oldStart < section.lastOldStart || newStart < section.lastNewStart) {
      this.fatal("HUNK_MALFORMED");
    }
    section.lastOldStart = oldStart + Math.max(oldLeft, 1);
    section.lastNewStart = newStart + Math.max(newLeft, 1);
    if (section.oldPath === null && (oldStart !== 0 || oldLeft !== 0)) this.fatal("HUNK_MALFORMED");
    if (section.newPath === null && (newStart !== 0 || newLeft !== 0)) this.fatal("HUNK_MALFORMED");
    section.hunks += 1;
    this.index += 1;
    let newLine = newStart;
    while (oldLeft > 0 || newLeft > 0) {
      const line = this.lines[this.index];
      const marker = line?.[0];
      if (line === undefined || marker === undefined) this.fatal("HUNK_MALFORMED");
      // Git treats NUL as binary; a textual hunk must not smuggle it past the header checks.
      if (line.includes("\u0000")) this.fatal("BINARY_REJECTED", section.newPath ?? section.oldPath ?? undefined);
      if (marker === " " && oldLeft > 0 && newLeft > 0) {
        oldLeft -= 1;
        newLeft -= 1;
        newLine += 1;
      } else if (marker === "-" && oldLeft > 0) {
        oldLeft -= 1;
        section.file.removed += 1;
      } else if (marker === "+" && newLeft > 0) {
        newLeft -= 1;
        const text = line.slice(1);
        section.file.added += 1;
        section.file.addedBytes += encoder.encode(text).length + 1;
        section.file.addedLines.push({ line: newLine, patchLine: this.index + 1, text });
        newLine += 1;
      } else if (marker !== "\\" || !/^[ +-]/.test(this.lines[this.index - 1]!)) {
        this.fatal("HUNK_MALFORMED");
      }
      this.index += 1;
    }
    if (this.lines[this.index]?.startsWith("\\") === true) this.index += 1;
    const next = this.lines[this.index];
    if (
      next !== undefined
      && !next.startsWith("@@")
      && !next.startsWith("diff --git ")
      && !next.startsWith("--- ")
    ) {
      this.fatal("HUNK_MALFORMED");
    }
  }

  private finish(section: Section): void {
    const { oldPath, newPath, gitPath, rejections } = section;
    const hasMarkers = oldPath !== undefined;
    const isAdd = section.newFileMode !== undefined || (hasMarkers && oldPath === null);
    const isDelete = section.deletedFileMode !== undefined || (hasMarkers && newPath === null);
    const candidates = [oldPath, newPath, gitPath].filter((value): value is string => typeof value === "string");
    const path = candidates[0];
    const consistent = path !== undefined && candidates.every((candidate) => candidate === path);
    if (!rejections.some(isRenameOrCopy)) {
      if (
        !consistent
        || (isAdd && isDelete)
        || (section.newFileMode !== undefined && hasMarkers && oldPath !== null)
        || (section.deletedFileMode !== undefined && hasMarkers && newPath !== null)
        || (!hasMarkers && !isAdd && !isDelete && rejections.length === 0)
      ) {
        rejections.push({ code: "PATCH_MALFORMED", patchLine: section.startLine });
      }
    }
    if (path !== undefined) {
      const pathCode = missionPathRejection(path);
      if (pathCode !== undefined) rejections.push({ code: pathCode, patchLine: section.startLine });
      if (consistent && this.seen.has(path)) rejections.push({ code: "DUPLICATE_FILE", patchLine: section.startLine });
      this.seen.add(path);
    }
    const reportPath = gitPath ?? newPath ?? oldPath ?? undefined;
    for (const rejection of rejections) {
      this.rejections.push(reportPath === undefined ? rejection : { ...rejection, path: reportPath });
    }
    if (rejections.length > 0 || path === undefined) return;
    section.file.path = path;
    section.file.kind = isAdd ? "add" : isDelete ? "delete" : "modify";
    this.files.push(section.file);
  }
}

function isRenameOrCopy(rejection: MissionPatchRejection): boolean {
  return rejection.code === "RENAME_REJECTED" || rejection.code === "COPY_REJECTED";
}

function modeRejection(mode: string, allowed: readonly string[]): MissionPatchRejectionCode | undefined {
  if (mode === "120000") return "SYMLINK_REJECTED";
  if (mode === "160000") return "SUBMODULE_REJECTED";
  return allowed.includes(mode) ? undefined : "MODE_CHANGE_REJECTED";
}

function parseGitHeaderPath(rest: string): string | undefined {
  if (rest.startsWith("\"")) {
    const tokens = splitQuotedPair(rest);
    if (tokens === undefined) return undefined;
    const [left, right] = tokens;
    if (!left.startsWith("a/") || !right.startsWith("b/")) return undefined;
    return left.slice(2) === right.slice(2) ? left.slice(2) : undefined;
  }
  if ((rest.length - 5) % 2 !== 0 || !rest.startsWith("a/")) return undefined;
  const length = (rest.length - 5) / 2;
  const path = rest.slice(2, 2 + length);
  return rest.slice(2 + length) === ` b/${path}` ? path : undefined;
}

function splitQuotedPair(rest: string): [string, string] | undefined {
  const end = closingQuote(rest);
  if (end < 0 || rest[end + 1] !== " ") return undefined;
  const left = unquoteGitPath(rest.slice(0, end + 1));
  const rightRaw = rest.slice(end + 2);
  const right = rightRaw.startsWith("\"") ? unquoteGitPath(rightRaw) : rightRaw;
  return left === undefined || right === undefined ? undefined : [left, right];
}

function closingQuote(value: string): number {
  for (let index = 1; index < value.length; index += 1) {
    if (value[index] === "\\") index += 1;
    else if (value[index] === "\"") return index;
  }
  return -1;
}

const ESCAPES: Readonly<Record<string, number>> = {
  a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, "\"": 34, "\\": 92,
};

/** Decodes a git C-style quoted path (`core.quotePath`); undefined when malformed. */
function unquoteGitPath(value: string): string | undefined {
  if (value.length < 2 || closingQuote(value) !== value.length - 1) return undefined;
  const bytes: number[] = [];
  for (let index = 1; index < value.length - 1; index += 1) {
    const char = value[index]!;
    if (char !== "\\") {
      bytes.push(...encoder.encode(char));
      continue;
    }
    const next = value[index + 1];
    if (next === undefined) return undefined;
    const octal = value.slice(index + 1, index + 4);
    if (/^[0-3][0-7]{2}$/.test(octal)) {
      bytes.push(Number.parseInt(octal, 8));
      index += 3;
    } else if (ESCAPES[next] !== undefined) {
      bytes.push(ESCAPES[next]!);
      index += 1;
    } else {
      return undefined;
    }
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(bytes));
  } catch {
    return undefined;
  }
}

function sortRejections(rejections: readonly MissionPatchRejection[]): MissionPatchRejection[] {
  const byKey = new Map<string, MissionPatchRejection>();
  for (const rejection of rejections) {
    byKey.set(`${rejection.code}\u0000${rejection.path ?? ""}\u0000${rejection.patchLine ?? 0}`, rejection);
  }
  return [...byKey.values()].sort((left, right) =>
    compare(left.code, right.code)
    || compare(left.path ?? "", right.path ?? "")
    || (left.patchLine ?? 0) - (right.patchLine ?? 0));
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
