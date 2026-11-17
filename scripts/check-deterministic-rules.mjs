#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

export const repoRoot = resolve(import.meta.dirname, "..");
const sourceExtensions = new Set([".ts", ".tsx", ".js", ".mjs", ".mts"]);

export function walk(directory, predicate = () => true) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? walk(path, predicate) : predicate(path) ? [path] : [];
  });
}
function sourceFile(path, content = readFileSync(path, "utf8")) {
  return ts.createSourceFile(path, content, ts.ScriptTarget.Latest, true, path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
}
function traverse(node, visit) { visit(node); ts.forEachChild(node, (child) => traverse(child, visit)); }
function rel(root, path) { return relative(root, path).replaceAll("\\", "/"); }

export function scratchCalls(path, content = readFileSync(path, "utf8")) {
  const found = [];
  const source = sourceFile(path, content);
  traverse(source, (node) => {
    if (!ts.isCallExpression(node)) return;
    const expression = node.expression;
    const name = ts.isIdentifier(expression) ? expression.text : ts.isPropertyAccessExpression(expression) ? expression.name.text : "";
    if (name !== "tmpdir" && name !== "mkdtemp" && name !== "mkdtempSync") return;
    const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
    found.push({ line, expression: node.getText(source).replace(/\s+/g, " ").trim() });
  });
  return found;
}
export function scratchViolations(root, allowlist) {
  const testDirectories = new Set(["fixtures", "__fixtures__", "test", "tests", "__tests__", "testkit"]);
  const packageSource = (path) => {
    const parts = rel(root, path).split("/");
    if (parts.length < 4 || parts[0] !== "packages" || parts[2] !== "src") return false;
    if (parts.slice(3, -1).some((part) => testDirectories.has(part))) return false;
    const name = parts.at(-1);
    if (!sourceExtensions.has(extname(name))) return false;
    // Includes *.property.test.ts and *.integration.test.ts through the *.test.ts suffix.
    return !/\.(?:test|testkit)\.[cm]?[jt]sx?$/.test(name) && !/^test-.*\.[cm]?[jt]sx?$/.test(name);
  };
  const scriptSource = (path) => sourceExtensions.has(extname(path)) && !/\.test\.mjs$/.test(path);
  const files = [...walk(join(root, "packages"), packageSource), ...walk(join(root, "scripts"), scriptSource)];
  const actual = new Map();
  for (const file of files) {
    const path = rel(root, file);
    if (path === "packages/core/src/scratch.ts" || path === "scripts/lib/scratch.mjs") continue;
    for (const call of scratchCalls(file)) {
      const key = `${path}::${call.expression}`;
      actual.set(key, (actual.get(key) ?? 0) + 1);
    }
  }
  const errors = [];
  for (const entry of allowlist) {
    const key = `${entry.file}::${entry.expression}`;
    if (!entry.reason || !Number.isInteger(entry.count) || entry.count < 1) errors.push(`invalid scratch allowlist entry ${key}`);
    const count = actual.get(key) ?? 0;
    if (count !== entry.count) errors.push(`stale scratch allowlist entry ${key}: expected ${entry.count}, found ${count}; remove or narrow this entry`);
    actual.delete(key);
  }
  for (const [key, count] of actual) errors.push(`${key} (${count} use${count === 1 ? "" : "s"}): use @osstack/core createScratchDir / scratchPath in packages or scripts/lib/scratch.mjs createScratchDir in scripts`);
  return errors;
}

export function vitestConfigViolations(root) {
  const errors = [];
  for (const entry of readdirSync(join(root, "packages"), { withFileTypes: true }).filter((item) => item.isDirectory())) {
    const directory = join(root, "packages", entry.name);
    const config = join(directory, "vitest.config.ts");
    const tests = walk(join(directory, "src"), (path) => /\.test\.[cm]?[jt]sx?$/.test(path));
    if (!existsSync(config)) {
      if (tests.length) errors.push(`packages/${entry.name}: test files exist without vitest.config.ts; add a config with test.setupFiles: ["../../scripts/vitest-setup-scratch.ts"]`);
      continue;
    }
    const source = sourceFile(config);
    let loaded = false;
    traverse(source, (node) => {
      if (!ts.isPropertyAssignment(node) || node.name.getText(source) !== "test") return;
      traverse(node.initializer, (child) => {
        if (!ts.isPropertyAssignment(child) || child.name.getText(source) !== "setupFiles") return;
        traverse(child.initializer, (value) => {
          if (ts.isStringLiteral(value) && value.text === "../../scripts/vitest-setup-scratch.ts") loaded = true;
        });
      });
    });
    if (!loaded) errors.push(`packages/${entry.name}/vitest.config.ts: add "../../scripts/vitest-setup-scratch.ts" to test.setupFiles`);
  }
  return errors;
}

export function markdownLinks(markdown) {
  const links = [];
  let fenced = false;
  for (const [index, raw] of markdown.split(/\r?\n/).entries()) {
    if (/^\s*(`{3,}|~{3,})/.test(raw)) { fenced = !fenced; continue; }
    if (fenced) continue;
    const line = raw.replace(/`[^`]*`/g, "");
    const patterns = [/!?\[[^\]]*\]\(\s*(?:<([^>]+)>|([^\s)]+))(?:\s+[^)]*)?\)/g, /^\s*\[(?!\^)[^\]]+\]:\s*(?:<([^>]+)>|(?!\[)(\S+))/g];
    for (const pattern of patterns) for (const match of line.matchAll(pattern)) links.push({ line: index + 1, target: match[1] ?? match[2] });
  }
  return links;
}
export function docsLinkViolations(root, allowlist = []) {
  const actual = new Map();
  for (const file of walk(join(root, "docs"), (path) => path.endsWith(".md"))) {
    for (const { line, target } of markdownLinks(readFileSync(file, "utf8"))) {
      if (/^(?:[a-z][a-z\d+.-]*:|\/|#)/i.test(target)) continue;
      const pathPart = decodeURIComponent(target.split(/[?#]/, 1)[0]);
      if (!pathPart) continue;
      const destination = resolve(dirname(file), pathPart);
      if (destination !== root && !destination.startsWith(`${root}/`)) {
        const key = `${rel(root, file)}::${target}`;
        actual.set(key, [...(actual.get(key) ?? []), line]);
        continue;
      }
      if (existsSync(destination)) continue;
      const key = `${rel(root, file)}::${target}`;
      actual.set(key, [...(actual.get(key) ?? []), line]);
    }
  }
  const errors = [];
  for (const entry of allowlist) {
    const key = `${entry.file}::${entry.target}`;
    const found = actual.get(key) ?? [];
    if (!entry.reason || found.length !== entry.count) errors.push(`stale docs link allowlist entry ${key}: expected ${entry.count}, found ${found.length}; remove or narrow this entry`);
    actual.delete(key);
  }
  for (const [key, lines] of actual) errors.push(`${key} (line ${lines.join(", ")}): point the relative Markdown link to an existing repository file, or add that file`);
  return errors;
}

function resolveSource(root, importer, specifier) {
  let base;
  if (specifier.startsWith(".")) base = resolve(dirname(importer), specifier);
  else if (specifier.startsWith("@osstack/")) base = join(root, "packages", specifier.split("/")[1], "src", ...specifier.split("/").slice(2));
  else return undefined;
  const stem = base.replace(/\.(?:m?js|cjs)$/, "");
  for (const candidate of [base, `${stem}.ts`, `${stem}.tsx`, join(stem, "index.ts")]) {
    if (existsSync(candidate) && statSync(candidate).isFile() && sourceExtensions.has(extname(candidate))) return candidate;
  }
  return undefined;
}
export function staticClosure(root, entry) {
  const visited = new Set();
  function follow(path) {
    if (visited.has(path)) return;
    visited.add(path);
    const source = sourceFile(path);
    traverse(source, (node) => {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        if (ts.isImportDeclaration(node) && (node.importClause?.isTypeOnly || (node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings) && !node.importClause.name && node.importClause.namedBindings.elements.every((element) => element.isTypeOnly)))) return;
        if (ts.isExportDeclaration(node) && node.isTypeOnly) return;
        const next = resolveSource(root, path, node.moduleSpecifier.text);
        if (next) follow(next);
      }
    });
  }
  follow(resolve(root, entry));
  return new Set([...visited].map((path) => rel(root, path)));
}
export function dynamicCommandModules(root) {
  const path = join(root, "packages/cli/src/bin.ts");
  const source = sourceFile(path);
  const commands = new Set();
  traverse(source, (node) => {
    if (!ts.isCallExpression(node) || node.expression.kind !== ts.SyntaxKind.ImportKeyword || node.arguments.length !== 1) return;
    const arg = node.arguments[0];
    if (!ts.isStringLiteral(arg) || !arg.text.startsWith(".")) return;
    const resolved = resolveSource(root, path, arg.text);
    if (resolved) commands.add(rel(root, resolved));
  });
  return commands;
}
export function startupGraphViolations(root, limits) {
  const entry = staticClosure(root, "packages/cli/src/cli-entry.ts");
  const bin = staticClosure(root, "packages/cli/src/bin.ts");
  const errors = [];
  const forbidden = new Set(["packages/cli/src/bin.ts", ...dynamicCommandModules(root)]);
  for (const path of entry) if (forbidden.has(path)) errors.push(`cli-entry.ts statically loads command module ${path}; use await import() at the use site`);
  if (entry.size > limits.entry) errors.push(`cli-entry.ts static closure has ${entry.size} files (limit ${limits.entry}); use await import() at the use site`);
  if (bin.size > limits.bin) errors.push(`bin.ts static closure has ${bin.size} files (limit ${limits.bin}); use await import() at the use site`);
  return { errors, counts: { entry: entry.size, bin: bin.size } };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const scratchAllowlist = JSON.parse(readFileSync(join(repoRoot, "scripts/deterministic-scratch-allowlist.json"), "utf8"));
  const docsAllowlist = JSON.parse(readFileSync(join(repoRoot, "scripts/deterministic-docs-allowlist.json"), "utf8"));
  const results = [
    ...scratchViolations(repoRoot, scratchAllowlist),
    ...vitestConfigViolations(repoRoot),
    ...docsLinkViolations(repoRoot, docsAllowlist),
    // Baseline: cli-entry.ts 2 files (+1), bin.ts 178 files (+4).
    ...startupGraphViolations(repoRoot, { entry: 3, bin: 182 }).errors,
  ];
  if (results.length) { console.error(results.join("\n")); process.exitCode = 1; }
  else console.log("deterministic repository rules: ok");
}
