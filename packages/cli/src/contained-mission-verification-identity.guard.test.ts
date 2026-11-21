import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { expect, it } from 'vitest';

const packages = fileURLToPath(new URL('../../', import.meta.url));
const prefix = 'cli/src/contained-mission-verification-';
const config = prefix + 'producer-config.ts'; const proof = prefix + 'installation.ts'; const transport = prefix + 'read-transport.ts';
const libraries = [config, proof, transport].map(path => path.split('/').pop()!.slice(0, -3));
function* sources(dir: string): Generator<string> {
  for (const item of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, item.name);
    if (item.isDirectory() && item.name !== 'node_modules' && item.name !== 'dist') yield* sources(path);
    if (item.isFile() && path.endsWith('.ts') && !path.endsWith('.test.ts')) yield path;
  }
}
function specifiers(file: string, source: string): string[] {
  const result: string[] = [];
  const visit = (node: ts.Node): void => {
    const spec = ts.isImportDeclaration(node) || ts.isExportDeclaration(node) ? node.moduleSpecifier
      : ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || node.expression.getText() === 'require') ? node.arguments[0]
      : ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) ? node.argument.literal : undefined;
    if (spec && ts.isStringLiteralLike(spec)) result.push(spec.text);
    ts.forEachChild(node, visit);
  };
  visit(ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)); return result;
}
it('isolates verification credentials and keeps the identity libraries unwired', () => {
  const seen = new Set<string>();
  for (const pkg of readdirSync(packages, { withFileTypes: true })) {
    if (!pkg.isDirectory() || !readdirSync(join(packages, pkg.name)).includes('src')) continue;
    for (const path of sources(join(packages, pkg.name, 'src'))) {
      const file = relative(packages, path); const source = readFileSync(path, 'utf8');
      if (source.includes('verification_private_key_path')) {
        expect([config, proof], file).toContain(file); expect(source, file).not.toContain('createInstallationTokenSource');
      }
      if (file === config) {
        for (const line of source.split('\n').filter(l => l.includes('verification_private_key_path'))) expect(line).not.toMatch(/readFile|lstat|stat|open|access/);
      }
      if (source.includes('access_tokens')) expect(file).toBe('cli/src/contained-mission-github-app.ts');
      if (file !== proof && file !== transport && !libraries.some(name => source.includes(name))) continue;
      const imports = specifiers(file, source);
      if (file !== 'cli/src/contained-mission-local-failure-scan.ts') for (const spec of imports) expect(libraries, file).not.toContain(spec.split('/').pop()!.replace(/\.(?:js|ts)$/, ''));
      if (file === proof) {
        seen.add(file);
        for (const spec of imports) expect(['node:crypto', 'node:fs/promises', 'node:path', 'zod']).toContain(spec);
        expect(source.match(/\bmethod\s*:/g)).toHaveLength(1); expect(source).toContain("method: 'GET'");
        expect(source).not.toMatch(/POST|PUT|PATCH|DELETE|access_tokens|createInstallationTokenSource/);
      }
      if (file === transport) {
        seen.add(file); expect(imports).toEqual(['node:child_process']); expect(source).toContain("'--method', 'GET'");
        expect(source).not.toMatch(/POST|PUT|PATCH|DELETE|verification_private_key_path/);
      }
    }
  }
  expect(seen).toEqual(new Set([proof, transport]));
});
