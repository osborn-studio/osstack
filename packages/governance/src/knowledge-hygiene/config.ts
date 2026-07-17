import { createHash } from "node:crypto";
import { lstat, readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { parseDocument } from "yaml";
import { z, ZodError } from "zod";
import {
  KnowledgeHygieneRuleIdV1,
  KnowledgeHygieneSeverityV1,
} from "./types.js";

const DEFAULT_CONFIG_PATH = ".osstack/neat.yaml";
const MAX_CONFIG_BYTES = 1024 * 1024;

export type KnowledgeHygieneConfigErrorCode =
  | "parse"
  | "validation"
  | "path"
  | "read";

export class KnowledgeHygieneConfigError extends Error {
  readonly code: KnowledgeHygieneConfigErrorCode;
  readonly details: readonly string[];

  constructor(
    code: KnowledgeHygieneConfigErrorCode,
    message: string,
    details: readonly string[] = [],
  ) {
    super(message);
    this.name = "KnowledgeHygieneConfigError";
    this.code = code;
    this.details = details;
  }
}

function validateRepositoryPath(value: string, allowPattern: boolean): string[] {
  const issues: string[] = [];
  if (value.includes("\\")) {
    issues.push("must use POSIX separators");
  }
  if (isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value)) {
    issues.push("must be repository-relative");
  }
  if (value.split("/").includes("..")) {
    issues.push("must not contain '..' segments");
  }
  if (
    value === "." ||
    value.startsWith("./") ||
    value.endsWith("/") ||
    value.includes("//") ||
    value.split("/").includes(".")
  ) {
    issues.push("must be normalized without './' or a trailing slash");
  }
  if (!allowPattern && value.includes("*")) {
    issues.push("must not contain wildcards");
  }
  if (allowPattern) {
    if (/[?[\]{}()]/.test(value) || value.startsWith("!")) {
      issues.push("contains unsupported pattern syntax");
    }
    for (const segment of value.split("/")) {
      if (segment.includes("**") && segment !== "**") {
        issues.push("'**' must occupy a complete path segment");
        break;
      }
    }
  }
  return issues;
}

function repositoryPathSchema(allowPattern: boolean) {
  return z
    .string()
    .trim()
    .min(1)
    .superRefine((value, context) => {
      for (const message of validateRepositoryPath(value, allowPattern)) {
        context.addIssue({ code: z.ZodIssueCode.custom, message });
      }
    });
}

const repositoryPath = repositoryPathSchema(false);
const repositoryPattern = repositoryPathSchema(true);
const identifier = z.string().trim().min(1).regex(/^[a-z0-9][a-z0-9._-]*$/);
const positiveLimit = z.number().int().positive();

const budgetThreshold = z
  .object({
    lines: positiveLimit.optional(),
    bytes: positiveLimit.optional(),
  })
  .strict()
  .refine((value) => value.lines !== undefined || value.bytes !== undefined, {
    message: "budget threshold requires lines or bytes",
  });

const budget = z
  .object({
    id: identifier,
    path: repositoryPath,
    warn: budgetThreshold.optional(),
    error: budgetThreshold.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (!value.warn && !value.error) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "budget requires warn or error threshold",
      });
      return;
    }
    if (
      value.warn?.lines !== undefined &&
      value.error?.lines !== undefined &&
      value.error.lines < value.warn.lines
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "error.lines must be greater than or equal to warn.lines",
      });
    }
    if (
      value.warn?.bytes !== undefined &&
      value.error?.bytes !== undefined &&
      value.error.bytes < value.warn.bytes
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "error.bytes must be greater than or equal to warn.bytes",
      });
    }
  });

const patternList = z
  .object({ any_path: z.array(repositoryPattern).min(1) })
  .strict();

const knowledgeHygieneConfigV1Schema = z
  .object({
    version: z.literal(1),
    instructions: z
      .object({
        canonical: repositoryPath,
        mirrors: z
          .array(
            z
              .object({
                path: repositoryPath,
                mode: z.enum(["import", "symlink", "import_or_symlink"]),
              })
              .strict(),
          )
          .default([]),
      })
      .strict()
      .optional(),
    required_surfaces: z
      .array(
        z
          .object({
            id: identifier,
            path: repositoryPath,
            kind: z.enum(["file", "directory"]).default("file"),
            severity: KnowledgeHygieneSeverityV1.default("warning"),
          })
          .strict(),
      )
      .default([]),
    budgets: z.array(budget).default([]),
    contracts: z
      .array(
        z
          .object({
            id: identifier,
            when: patternList,
            review: patternList,
            enforcement: z.enum(["advisory", "required"]).default("advisory"),
          })
          .strict(),
      )
      .default([]),
    ignore: z
      .array(
        z
          .object({
            rule_id: KnowledgeHygieneRuleIdV1,
            paths: z
              .array(repositoryPattern)
              .min(1)
              .refine((paths) => !paths.includes("**"), {
                message: "a broad '**' suppression is not allowed",
              }),
            reason: z.string().trim().min(1),
          })
          .strict(),
      )
      .default([]),
  })
  .strict()
  .superRefine((config, context) => {
    const idGroups: ReadonlyArray<readonly string[]> = [
      config.required_surfaces.map((item) => item.id),
      config.budgets.map((item) => item.id),
      config.contracts.map((item) => item.id),
    ];
    for (const ids of idGroups) {
      const duplicate = ids.find((id, index) => ids.indexOf(id) !== index);
      if (duplicate) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `duplicate id: ${duplicate}`,
        });
      }
    }
    if (config.instructions) {
      const mirrorPaths = config.instructions.mirrors.map((item) => item.path);
      const duplicateMirror = mirrorPaths.find(
        (path, index) => mirrorPaths.indexOf(path) !== index,
      );
      if (duplicateMirror) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `duplicate mirror path: ${duplicateMirror}`,
        });
      }
    }
  });

export type KnowledgeHygieneConfigV1 = z.infer<
  typeof knowledgeHygieneConfigV1Schema
>;

function zodDetails(error: ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join(".") : "config";
    return `${path}: ${issue.message}`;
  });
}

export function parseKnowledgeHygieneConfigV1(
  source: string,
): KnowledgeHygieneConfigV1 {
  if (Buffer.byteLength(source, "utf8") > MAX_CONFIG_BYTES) {
    throw new KnowledgeHygieneConfigError(
      "read",
      `neat config exceeds ${MAX_CONFIG_BYTES} byte limit`,
    );
  }
  const document = parseDocument(source, { uniqueKeys: true });
  if (document.errors.length > 0) {
    throw new KnowledgeHygieneConfigError(
      "parse",
      "invalid neat YAML",
      document.errors.map((error) => error.message),
    );
  }

  let value: unknown;
  try {
    value = document.toJS({ maxAliasCount: 50 });
  } catch (error) {
    throw new KnowledgeHygieneConfigError(
      "parse",
      "invalid neat YAML expansion",
      [error instanceof Error ? error.message : String(error)],
    );
  }

  try {
    return knowledgeHygieneConfigV1Schema.parse(value);
  } catch (error) {
    if (error instanceof ZodError) {
      throw new KnowledgeHygieneConfigError(
        "validation",
        "invalid neat config",
        zodDetails(error),
      );
    }
    throw error;
  }
}

export interface LoadKnowledgeHygieneConfigInput {
  repo_root: string;
  config_path?: string;
}

export type LoadedKnowledgeHygieneConfig =
  | {
      mode: "zero_config";
      path: string;
    }
  | {
      mode: "configured";
      path: string;
      sha256: string;
      config: KnowledgeHygieneConfigV1;
    };

function isInsideRoot(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return (
    pathFromRoot === "" ||
    (!pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== ".." && !isAbsolute(pathFromRoot))
  );
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  return typeof error.code === "string" ? error.code : undefined;
}

export async function loadKnowledgeHygieneConfig(
  input: LoadKnowledgeHygieneConfigInput,
): Promise<LoadedKnowledgeHygieneConfig> {
  const requestedRoot = resolve(input.repo_root);
  let resolvedRoot: string;
  try {
    resolvedRoot = await realpath(requestedRoot);
  } catch (error) {
    throw new KnowledgeHygieneConfigError(
      "path",
      `cannot resolve repository root: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const requestedConfig = input.config_path ?? DEFAULT_CONFIG_PATH;
  const configPath = isAbsolute(requestedConfig)
    ? resolve(requestedConfig)
    : resolve(resolvedRoot, requestedConfig);
  if (!isInsideRoot(resolvedRoot, configPath)) {
    throw new KnowledgeHygieneConfigError(
      "path",
      "neat config path is outside repository",
    );
  }

  try {
    await lstat(configPath);
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return { mode: "zero_config", path: configPath };
    }
    throw new KnowledgeHygieneConfigError(
      "read",
      `cannot inspect neat config: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  let resolvedConfig: string;
  try {
    resolvedConfig = await realpath(configPath);
  } catch (error) {
    throw new KnowledgeHygieneConfigError(
      "read",
      `cannot resolve neat config: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!isInsideRoot(resolvedRoot, resolvedConfig)) {
    throw new KnowledgeHygieneConfigError(
      "path",
      "neat config symlink resolves outside repository",
    );
  }

  const configStat = await stat(resolvedConfig);
  if (!configStat.isFile()) {
    throw new KnowledgeHygieneConfigError("read", "neat config is not a file");
  }
  if (configStat.size > MAX_CONFIG_BYTES) {
    throw new KnowledgeHygieneConfigError(
      "read",
      `neat config exceeds ${MAX_CONFIG_BYTES} byte limit`,
    );
  }

  let source: string;
  try {
    source = await readFile(resolvedConfig, "utf8");
  } catch (error) {
    throw new KnowledgeHygieneConfigError(
      "read",
      `cannot read neat config: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return {
    mode: "configured",
    path: configPath,
    sha256: createHash("sha256").update(source).digest("hex"),
    config: parseKnowledgeHygieneConfigV1(source),
  };
}
