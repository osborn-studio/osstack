#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

export const repoRoot = resolve(import.meta.dirname, "..");
const sourceExtensions = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".mts", ".cjs", ".cts"]);

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

// One entry per file. Exact counts reject growth and require stale entries to shrink.
function countedViolations(findings, allowlist, label, remedy) {
  const keyOf = entry => entry.file;
  const actual = new Map();
  for (const finding of findings) {
    const key = keyOf(finding);
    const value = actual.get(key) ?? { finding, count: 0 };
    value.count++;
    actual.set(key, value);
  }
  const errors = [];
  const seen = new Set();
  for (const entry of allowlist) {
    const key = keyOf(entry);
    const count = actual.get(key)?.count ?? 0;
    if (seen.has(key) || !entry.reason?.trim() || !Number.isInteger(entry.count) || entry.count < 1 || count !== entry.count) errors.push(`stale ${label} allowlist entry ${key}: expected ${entry.count}, found ${count}; remove or narrow this entry`);
    seen.add(key);
    actual.delete(key);
  }
  for (const [key, { finding, count }] of actual) errors.push(`${key} (line ${finding.line}, ${count} uses): ${remedy(finding)}`);
  return errors;
}
function packageProductionSource(root, path) {
  const parts = rel(root, path).split("/");
  return parts[0] === "packages" && parts[2] === "src" && sourceExtensions.has(extname(path))
    && !parts.slice(3, -1).some(part => /^(?:__)?(?:tests?|fixtures)(?:__)?$|^testkit$/.test(part))
    && !/(?:\.(?:test|spec|testkit|fixture)|-test-fixture)\.[cm]?[jt]sx?$/.test(path) && !/^test-/.test(parts.at(-1));
}
// Network scope: all core state/stores and decisions, including policy, kanban,
// orchestrator, privacy, graph (local Git/artifact state) and top-level contracts.
// Excluded: hermes/ shells out to the host; kg/ is the GBrain adapter;
// observability/ exports telemetry. These are existing integration surfaces.
// Tests/fixtures use the shared production-source exclusion above.
export function coreNetworkScope(file) {
  return file.startsWith("packages/core/src/")
    && !/^packages\/core\/src\/(?:hermes|kg|observability)\//.test(file);
}
// Contracts, state machines, schedulers and deterministic validators are core-like.
// Cover all loop files, not only loop-engine/verifier, so moving a decision to a
// helper does not bypass the rule. Other packages are host/configuration, agent,
// service, knowledge ingestion, UI/CLI, runtime or evaluation integrations.
const coreProductPackages = new Set(["core", "protocol", "loop", "autonomy", "contracts", "governance", "graph", "plugins"]);
// Existing adapter directories, including the two integrations still in core.
export const productAdapterDirectories = ["packages/agents/src/adapters/", "packages/hermes-adapter/src/", "packages/core/src/hermes/", "packages/core/src/kg/", "packages/governance/src/knowledge-hygiene/adapters/"];
export function coreProductScope(file) {
  return coreProductPackages.has(file.split("/")[1]) && !productAdapterDirectories.some(prefix => file.startsWith(prefix));
}
// Inventory from agents/src/adapters: codex-{cli,proxy} (OpenAI), claude-*
// (Anthropic), deepseek-*/ds-{review,verify}, kimi-*, opencode-cli, zcode-cli
// (GLM), google-stitch. Gemini and gpt-* are additional requested model-family
// guards (not currently named by adapter production sources); hermes is
// the host adapter in hermes-adapter/ and core/hermes/. Do not match generic
// words such as "code", "design", "research" or "stitch" on their own.
// Split camelCase/ACRONYM identifiers first; delimiters include '_' and '-'.
const productNamePattern = /(?:^|[^a-z0-9])(?:codex|claude|deep[ -]?seek|kimi|gemini|glm|open[ -]?code|z[ -]?code|hermes|open[ -]?ai|anthropic)(?=$|[^a-z0-9])|(?:^|[^a-z0-9])(?:gpt-|ds-(?:review|verify)(?=$|[^a-z0-9])|google[ -]stitch(?=$|[^a-z0-9]))/i;
function identifierWords(value) {
  return value.replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2").replace(/([a-z0-9])([A-Z])/g, "$1 $2");
}
function findingAt(root, path, source, node, category) {
  return { file: rel(root, path), category, line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1, expression: node.getText(source) };
}
function coreFiles(root, scope) {
  return walk(join(root, "packages"), path => packageProductionSource(root, path) && scope(rel(root, path)));
}
export function coreProductFindings(root) {
  const findings = [];
  for (const path of coreFiles(root, coreProductScope)) {
    const source = sourceFile(path);
    // Bind imports to their references without loading dependencies. This permits
    // adapter-exported constants/types, but still rejects local shadowing and
    // product literals in registry keys or capability ids.
    const host = ts.createCompilerHost({ noLib: true, noResolve: true });
    host.getSourceFile = name => name === path ? source : undefined;
    const program = ts.createProgram([path], { noLib: true, noResolve: true }, host);
    const checker = program.getTypeChecker();
    const adapterImports = new Set();
    function adapterModule(module) {
      const target = resolveSource(root, path, module);
      return /^@osstack\/(?:agents|hermes-adapter)(?:\/|$)/.test(module)
        || Boolean(target && productAdapterDirectories.some(prefix => rel(root, target).startsWith(prefix)));
    }
    traverse(source, node => {
      if (!ts.isImportDeclaration(node) || !ts.isStringLiteral(node.moduleSpecifier)) return;
      const module = node.moduleSpecifier.text;
      if (!adapterModule(module)) return;
      traverse(node.importClause ?? node, child => {
        const symbol = ts.isIdentifier(child) ? checker.getSymbolAtLocation(child) : undefined;
        if (symbol) adapterImports.add(symbol);
      });
    });
    traverse(source, node => {
      const identifier = ts.isIdentifier(node);
      const literal = ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node);
      if (!identifier && !literal) return;
      if (identifier) {
        let declaration = node.parent;
        while (declaration && !ts.isSourceFile(declaration)) {
          if ((ts.isImportDeclaration(declaration) || ts.isExportDeclaration(declaration))
            && declaration.moduleSpecifier && ts.isStringLiteral(declaration.moduleSpecifier)
            && adapterModule(declaration.moduleSpecifier.text)) return;
          declaration = declaration.parent;
        }
        let reference = node;
        if (ts.isPropertyAccessExpression(node.parent) && node.parent.name === node) {
          reference = node.parent.expression;
          while (ts.isPropertyAccessExpression(reference)) reference = reference.expression;
        }
        if (adapterImports.has(checker.getSymbolAtLocation(reference))) return;
      }
      // Module specifiers for approved adapter imports are references, not ids.
      if (literal && adapterModule(node.text) && (
        (ts.isImportDeclaration(node.parent) || ts.isExportDeclaration(node.parent)) && node.parent.moduleSpecifier === node
        || ts.isCallExpression(node.parent) && node.parent.expression.kind === ts.SyntaxKind.ImportKeyword
        || ts.isLiteralTypeNode(node.parent) && ts.isImportTypeNode(node.parent.parent))) return;
      if (productNamePattern.test(identifier ? identifierWords(node.text) : node.text)) findings.push(findingAt(root, path, source, node, identifier ? "identifier" : "literal"));
    });
  }
  return findings;
}
export function coreProductViolations(root, allowlist) {
  return countedViolations(coreProductFindings(root), allowlist, "core product", () => "use exported constants from the adapter package for capability ids and registry keys; pass adapter/model selection as parameters; keep product names in adapters; do not expand the allowlist");
}
const networkModule = /^(?:(?:node:)?(?:https?|net|tls|dgram|dns)(?:\/|$)|undici(?:\/|$)|axios(?:\/|$)|ws$|websocket$)/i;
const remoteGit = /(?:^|\s)(?:clone|fetch|pull|push|ls-remote)(?=\s|$)|(?:^|\s)remote\s+(?:update|prune|show)(?=\s|$)|(?:^|\s)submodule\s+(?:add|update)(?=\s|$)|(?:^|\s)archive\s+.*--remote(?:=|\s)/;
export function coreNetworkFindings(root) {
  const findings = [];
  for (const path of coreFiles(root, coreNetworkScope)) {
    const source = sourceFile(path);
    const bindings = new Map();
    const processNames = new Set(["exec", "execSync", "execFile", "execFileSync", "spawn", "spawnSync"]);
    traverse(source, node => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) bindings.set(node.name.text, node.initializer);
      if (ts.isImportSpecifier(node) && processNames.has(node.propertyName?.text ?? node.name.text)) processNames.add(node.name.text);
      if (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name) && node.initializer) {
        for (const element of node.name.elements) {
          if (ts.isIdentifier(element.name)) bindings.set(element.name.text, ts.factory.createPropertyAccessExpression(node.initializer, element.propertyName?.getText(source) ?? element.name.text));
        }
      }
    });
    function values(node, seen = new Set()) {
      if (!node) return "";
      if (ts.isStringLiteralLike(node)) return node.text;
      if (ts.isTemplateExpression(node)) return node.head.text + node.templateSpans.map(span => " <dynamic> " + span.literal.text).join("");
      if (ts.isIdentifier(node) && bindings.has(node.text) && !seen.has(node.text)) return values(bindings.get(node.text), new Set([...seen, node.text]));
      if (ts.isArrayLiteralExpression(node)) return node.elements.map(item => values(item, seen)).join(" ");
      if (ts.isSpreadElement(node)) return values(node.expression, seen);
      if (ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isParenthesizedExpression(node)) return values(node.expression, seen);
      return "<dynamic>";
    }
    function apiName(node, seen = new Set()) {
      if (ts.isIdentifier(node)) {
        if (bindings.has(node.text) && !seen.has(node.text)) return apiName(bindings.get(node.text), new Set([...seen, node.text]));
        return node.text;
      }
      if (ts.isPropertyAccessExpression(node)) return node.name.text;
      if (ts.isElementAccessExpression(node)) return values(node.argumentExpression);
      if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node)) return apiName(node.expression, seen);
      return "";
    }
    traverse(source, node => {
      let category;
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier) && networkModule.test(node.moduleSpecifier.text)) category = "network import";
      if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) && node.moduleReference.expression && networkModule.test(values(node.moduleReference.expression))) category = "network import";
      if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
        const name = apiName(node.expression);
        if (name === "fetch" || name === "WebSocket") category = "network API";
        if ((name === "require" || node.expression.kind === ts.SyntaxKind.ImportKeyword) && networkModule.test(values(node.arguments?.[0]))) category = "network import";
        // Include conventional exec/spawn wrappers: subprocess indirection must
        // not make a literal remote command disappear from the decision layer.
        if (processNames.has(name) || /exec|spawn|run|git/i.test(name)) {
          const command = (node.arguments ?? []).map(arg => values(arg)).join(" ");
          if (/(?:^|[\s/;&|])(?:curl|gh)(?=\s|$)/.test(command)
            || (/(?:^|[\s/;&|])git(?=\s|$)/.test(command) || /git/i.test(name)) && remoteGit.test(command)) category = "remote command";
        }
      }
      if (category) findings.push(findingAt(root, path, source, node, category));
    });
  }
  return findings;
}
export function coreNetworkViolations(root, allowlist) {
  return countedViolations(coreNetworkFindings(root), allowlist, "core network", () => "move network calls to an adapter or CLI; pass fetched results into core as parameters; do not expand the allowlist");
}

// Commands observed in the repository plus the other direct ref/index/remote writers.
// Object-only plumbing (hash-object, write-tree, commit-tree) does not change refs or index.
const gitWriters = new Set(["push", "commit", "merge", "rebase", "reset", "checkout", "switch", "restore", "update-ref", "add", "rm", "mv", "fetch", "pull", "cherry-pick", "revert", "stash", "read-tree", "update-index", "apply", "am", "init", "clone", "symbolic-ref", "pack-refs", "filter-branch", "notes", "replace"]);
function gitMutation(tokens) {
  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i];
    if (token === "-c" || token === "-C" || token === "--git-dir" || token === "--work-tree" || token === "--namespace" || token === "--config-env") { i += 2; continue; }
    if (token?.startsWith("-")) { i++; continue; }
    break;
  }
  const command = tokens[i];
  const args = tokens.slice(i + 1);
  if (command === "worktree") return ["add", "remove", "move", "prune", "lock", "unlock", "repair"].includes(args[0]) ? `worktree ${args[0]}` : undefined;
  if (command === "remote") return ["add", "remove", "rm", "rename", "set-url", "set-head", "set-branches", "prune", "update"].includes(args[0]) ? `remote ${args[0]}` : undefined;
  if (command === "branch" || command === "tag") {
    if (args.some(arg => ["-d", "-D", "--delete", "-m", "-M", "--move", "-c", "-C", "--copy", "-f", "--force"].includes(arg))) return command;
    if (args.some(arg => ["--list", "-l", "--show-current", "-r", "-a", "--contains", "--no-merged", "--merged"].includes(arg))) return undefined;
    return args.length ? command : undefined;
  }
  if (command === "symbolic-ref" && args.filter(arg => !arg.startsWith("-")).length < 2 && !args.includes("--delete")) return undefined;
  if (command === "apply" && args.some(arg => ["--check", "--stat", "--numstat", "--summary"].includes(arg))) return undefined;
  return gitWriters.has(command) ? command : undefined;
}
export function gitWriteFindings(root) {
  const findings = [];
  for (const path of walk(join(root, "packages"), path => packageProductionSource(root, path))) {
    const source = sourceFile(path);
    const bindings = new Map();
    traverse(source, node => { if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) bindings.set(node.name.text, node.initializer); });
    function tokens(node, seen = new Set()) {
      if (ts.isStringLiteralLike(node)) return [node.text];
      if (ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isParenthesizedExpression(node)) return tokens(node.expression, seen);
      if (ts.isIdentifier(node) && bindings.has(node.text) && !seen.has(node.text)) return tokens(bindings.get(node.text), new Set([...seen, node.text]));
      if (ts.isSpreadElement(node)) { const expanded = tokens(node.expression, seen); return expanded[0] === "<dynamic>" ? [] : expanded; }
      if (ts.isArrayLiteralExpression(node)) return node.elements.flatMap(child => tokens(child, seen));
      // Preserve unknown option values so -C root / -c config do not consume the command.
      return ["<dynamic>"];
    }
    traverse(source, node => {
      if (!ts.isCallExpression(node)) return;
      const name = node.expression.getText(source);
      const hasGit = node.arguments.some(arg => ts.isStringLiteralLike(arg) && /(?:^|\/)git$/.test(arg.text));
      if (!hasGit && !/git|\brun\b|exec|spawn/i.test(name)) return;
      const commands = new Set();
      for (const arg of node.arguments) {
        const shell = ts.isStringLiteralLike(arg) ? arg.text : ts.isTemplateExpression(arg) ? arg.head.text + arg.templateSpans.map(span => "<dynamic>" + span.literal.text).join("") : "";
        if (/\bgit\s+/.test(shell)) {
          for (const match of shell.matchAll(/(?:^|[;&|]\s*)\s*git\s+([^;&|]+)/g)) {
            const command = gitMutation(match[1].trim().split(/\s+/));
            if (command) commands.add(command);
          }
        }
        const visitArg = value => {
          if (ts.isArrayLiteralExpression(value) || ts.isIdentifier(value)) {
            const command = gitMutation(tokens(value));
            if (command) commands.add(command);
          } else if (ts.isConditionalExpression(value)) { visitArg(value.whenTrue); visitArg(value.whenFalse); }
        };
        visitArg(arg);
      }
      if (/git/i.test(name) && !hasGit && node.arguments.length && !node.arguments.some(ts.isArrayLiteralExpression) && node.arguments.some(ts.isStringLiteralLike)) {
        const argv = node.arguments.flatMap(arg => tokens(arg));
        const command = gitMutation(argv) ?? gitMutation(argv.slice(1));
        if (command) commands.add(command);
      }
      for (const command of commands) findings.push({ file: rel(root, path), command, expression: node.getText(source).replace(/\s+/g, " ").trim(), line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1 });
    });
  }
  return findings;
}
export function gitWriteViolations(root, allowlist) {
  return countedViolations(gitWriteFindings(root), allowlist, "git write", () => "route this write through an existing managed Git location with its authorization gate; do not expand the managed-location allowlist");
}
const secretPatterns = [
  ["private-key", /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/g],
  ["github-token", /\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+)/g],
  ["aws-access-key", /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g],
  ["google-api-key", /\bAIza[0-9A-Za-z_-]{35}\b/g],
  ["alibaba-access-key", /\bLTAI[0-9A-Za-z]{12,20}\b/g],
];
const machinePathPatterns = [
  ["machine-path", /(?:\/(?:Users|home)\/[^\s/"'`<>]+\/|\/Volumes\/[^\s/"'`<>]+\/|[A-Z]:\\Users\\[^\s\\"'`<>]+\\)[^\s"'`<>),;\]}]*/g],
];
// Scan paths only in executable/published surfaces and root configuration files.
// docs/ contains historical run evidence: workstation paths are part of that evidence.
export function machinePathScope(file) {
  return /^(?:packages\/[^/]+\/src\/|scripts\/|\.github\/|hermes-skill\/|loop-engineering\/)/.test(file)
    || (!file.includes("/") && (sourceExtensions.has(extname(file)) || /\.(?:json|ya?ml|toml|ini|conf|config)$/.test(file) || file.startsWith(".") || ["Makefile", "Dockerfile"].includes(file)));
}
function textFindings(root, files, patterns, inScope = () => true) {
  const tracked = files ?? execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }).split("\0").filter(Boolean);
  const findings = [];
  for (const file of tracked.filter(inScope)) {
    const path = join(root, file);
    if (!existsSync(path) || !statSync(path).isFile()) continue;
    const bytes = readFileSync(path);
    if (bytes.includes(0)) continue;
    const content = bytes.toString("utf8");
    for (const [category, pattern] of patterns) for (const match of content.matchAll(pattern)) findings.push({ file, category, line: content.slice(0, match.index).split("\n").length });
  }
  return findings;
}
export function secretFindings(root, files) {
  return textFindings(root, files, secretPatterns);
}
export function machinePathFindings(root, files) {
  return textFindings(root, files, machinePathPatterns, machinePathScope);
}
export function secretViolations(root, allowlist, files) {
  return countedViolations(secretFindings(root, files), allowlist, "secret", () => "remove the secret; use an environment variable; do not expand the allowlist");
}
export function machinePathViolations(root, allowlist, files) {
  return countedViolations(machinePathFindings(root, files), allowlist, "machine path", () => "replace the machine path with an environment variable or a portable example; do not expand the allowlist");
}
export function packageContractViolations(root) {
  const errors = [];
  const base = join(root, "tsconfig.base.json");
  function inherits(path, seen = new Set()) {
    if (!existsSync(path) || seen.has(path)) return false;
    if (path === base) return true;
    const parsed = ts.readConfigFile(path, path => readFileSync(path, "utf8"));
    if (parsed.error) return false;
    const parent = parsed.config.extends;
    return (Array.isArray(parent) ? parent : [parent]).some(value => typeof value === "string" && inherits(resolve(dirname(path), value), new Set([...seen, path])));
  }
  for (const entry of readdirSync(join(root, "packages"), { withFileTypes: true }).filter(entry => entry.isDirectory())) {
    const directory = join(root, "packages", entry.name);
    const file = join(directory, "package.json");
    let pkg;
    try { pkg = JSON.parse(readFileSync(file, "utf8")); } catch { errors.push(`packages/${entry.name}: add a valid package.json with typecheck and test scripts`); continue; }
    if (typeof pkg.scripts?.typecheck !== "string" || !pkg.scripts.typecheck.trim()) errors.push(`packages/${entry.name}/package.json: add a typecheck script (tsc --noEmit)`);
    if (walk(join(directory, "src"), path => /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(path)).length && (typeof pkg.scripts?.test !== "string" || !pkg.scripts.test.trim())) errors.push(`packages/${entry.name}/package.json: source tests exist; add a test script (vitest run)`);
    if (!inherits(join(directory, "tsconfig.json"))) errors.push(`packages/${entry.name}/tsconfig.json: inherit tsconfig.base.json through extends (normally ../../tsconfig.base.json)`);
  }
  return errors;
}

/** Keep host instructions independent of reference-data modules and unchecked assertions. */
export function instructionBoundaryViolations(root) {
  const errors = [];
  const files = walk(join(root, "packages"), path => packageProductionSource(root, path));
  const forbidden = /(?:^|[\/.-])(?:external-reference|reference-segment|verification-result|reader)(?:[.-]|$)/;
  const report = (path, source, node, message) => errors.push(`${rel(root, path)}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}: ${message}`);
  for (const path of files) {
    const source = sourceFile(path);
    if (path.endsWith("/instruction-boundary.ts")) {
      const visited = new Set();
      function follow(current) {
        if (visited.has(current)) return;
        visited.add(current);
        const module = sourceFile(current);
        traverse(module, node => {
          let specifier;
          if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) specifier = node.moduleSpecifier.text;
          if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === "require")) && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) specifier = node.arguments[0].text;
          if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) specifier = node.argument.literal.text;
          if (!specifier) return;
          if (forbidden.test(specifier.split("/").at(-1))) report(current, module, node, "instruction boundary imports reference data");
          if (specifier.startsWith(".")) {
            const target = resolveSource(root, current, specifier);
            if (target) follow(target);
          }
        });
      }
      follow(path);
      traverse(source, node => {
        if (node.kind === ts.SyntaxKind.AnyKeyword) report(path, source, node, "instruction boundary contains any type");
        if (ts.isAsExpression(node) && ts.isAsExpression(node.expression) && node.expression.type.kind === ts.SyntaxKind.UnknownKeyword) report(path, source, node, "instruction boundary contains as unknown as");
      });
      const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, source.text);
      for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
        if ((token === ts.SyntaxKind.SingleLineCommentTrivia || token === ts.SyntaxKind.MultiLineCommentTrivia) && /@ts-(?:ignore|expect-error|nocheck)/.test(scanner.getTokenText())) {
          errors.push(`${rel(root, path)}:${source.getLineAndCharacterOfPosition(scanner.getTokenPos()).line + 1}: instruction boundary suppresses type checking`);
        }
      }
    }
    traverse(source, node => {
      if (!ts.isCallExpression(node)) return;
      const name = ts.isIdentifier(node.expression) ? node.expression.text : ts.isPropertyAccessExpression(node.expression) ? node.expression.name.text : "";
      if (name !== "buildInstructionSegment") return;
      for (const argument of node.arguments) traverse(argument, child => {
        if (ts.isAsExpression(child) || ts.isTypeAssertionExpression(child)) report(path, source, child, "instruction segment argument contains a type assertion");
      });
    });
  }
  return errors;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const scratchAllowlist = JSON.parse(readFileSync(join(repoRoot, "scripts/deterministic-scratch-allowlist.json"), "utf8"));
  const docsAllowlist = JSON.parse(readFileSync(join(repoRoot, "scripts/deterministic-docs-allowlist.json"), "utf8"));
  const results = [
    ...instructionBoundaryViolations(repoRoot),
    ...scratchViolations(repoRoot, scratchAllowlist),
    ...vitestConfigViolations(repoRoot),
    ...gitWriteViolations(repoRoot, JSON.parse(readFileSync(join(repoRoot, "scripts/deterministic-git-allowlist.json"), "utf8"))),
    ...secretViolations(repoRoot, JSON.parse(readFileSync(join(repoRoot, "scripts/deterministic-secret-allowlist.json"), "utf8"))),
    ...machinePathViolations(repoRoot, JSON.parse(readFileSync(join(repoRoot, "scripts/deterministic-machine-path-allowlist.json"), "utf8"))),
    ...coreNetworkViolations(repoRoot, JSON.parse(readFileSync(join(repoRoot, "scripts/deterministic-core-network-allowlist.json"), "utf8"))),
    ...coreProductViolations(repoRoot, JSON.parse(readFileSync(join(repoRoot, "scripts/deterministic-core-product-allowlist.json"), "utf8"))),
    ...packageContractViolations(repoRoot),
    ...docsLinkViolations(repoRoot, docsAllowlist),
    // Baseline: cli-entry.ts 2 files (+1), bin.ts 178 files (+4).
    ...startupGraphViolations(repoRoot, { entry: 3, bin: 182 }).errors,
  ];
  if (results.length) { console.error(results.join("\n")); process.exitCode = 1; }
  else console.log("deterministic repository rules: ok");
}
