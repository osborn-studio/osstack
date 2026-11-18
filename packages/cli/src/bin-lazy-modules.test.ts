import { readFileSync } from "node:fs";
import { isBuiltin } from "node:module";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { expect, it } from "vitest";
// @ts-expect-error The repository rule is a JavaScript module without declarations.
import { staticClosure } from "../../../scripts/check-deterministic-rules.mjs";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const bin = "packages/cli/src/bin.ts";
const source = ts.createSourceFile(bin, readFileSync(new URL("./bin.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
const exportsByModule = new Map<string, Set<string>>();

function collect(node: ts.Node): void {
  if (ts.isAwaitExpression(node) && ts.isCallExpression(node.expression)
    && node.expression.expression.kind === ts.SyntaxKind.ImportKeyword) {
    const [specifier] = node.expression.arguments;
    if (specifier && ts.isStringLiteral(specifier) && !isBuiltin(specifier.text)) {
      let result: ts.Node = node;
      while (ts.isParenthesizedExpression(result.parent)) result = result.parent;
      const use = result.parent;
      const names = exportsByModule.get(specifier.text) ?? new Set<string>();
      if (ts.isVariableDeclaration(use) && ts.isObjectBindingPattern(use.name)) {
        for (const binding of use.name.elements) {
          const name = binding.propertyName ?? binding.name;
          if (!(ts.isIdentifier(name) || ts.isStringLiteral(name)) || binding.dotDotDotToken) {
            throw new Error(`Unsupported import binding: ${binding.getText(source)}`);
          }
          names.add(name.text);
        }
      } else if (ts.isPropertyAccessExpression(use)) {
        names.add(use.name.text);
      } else if (ts.isElementAccessExpression(use) && ts.isStringLiteral(use.argumentExpression)) {
        names.add(use.argumentExpression.text);
      }
      if (names.size > 0) exportsByModule.set(specifier.text, names);
    }
  }
  ts.forEachChild(node, collect);
}
collect(source);

it.each([...exportsByModule])("%s provides the exports used by bin.ts", async (specifier, names) => {
  const module = await import(/* @vite-ignore */ specifier);
  for (const name of names) {
    expect(module[name], `${specifier} export ${name}`).toBeDefined();
    if (name.startsWith("handle")) expect(typeof module[name], name).toBe("function");
  }
});

it("keeps command packages off the static startup path", () => {
  const closure: Set<string> = staticClosure(root, bin);
  expect([...closure].filter((file) => /^packages\/(core|autonomy|protocol|knowledge)\//.test(file))).toEqual([]);
});
