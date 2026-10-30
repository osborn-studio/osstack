import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { exportMethods } from './lib/osstack-method-export.mjs';

const sha = b => createHash('sha256').update(b).digest('hex');
async function fixture(t) {
  const root = join(process.env.OSSTACK_SCRATCH_ROOT ?? join(tmpdir(), 'osstack'), 'tests', `provenance-${randomUUID()}`);
  const sourceRoot = join(root, 'source');
  await mkdir(join(sourceRoot, 'references'), { recursive: true });
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const name of ['osstack-mode', 'osstack-help', 'setup-osstack', 'osstack-agent']) {
    await mkdir(join(sourceRoot, 'entries', name), { recursive: true });
    await writeFile(join(sourceRoot, 'entries', name, 'SKILL.md'), '# Method\n[Use](../../references/bug-fix.md)\n');
  }
  const material = '# Bug fix\nReproduce, repair, then verify.\n';
  await writeFile(join(sourceRoot, 'references/bug-fix.md'), material);
  await writeFile(join(sourceRoot, 'references/legacy.md'), '# Older material\n');
  const declaration = {
    kind: 'declared_method_provenance', schema_version: 1,
    upstream: { repository: 'https://github.com/cursor/plugins', commit: 'a'.repeat(40), subdir: 'pstack', package_version: '0.15.36' },
    adoption_candidate_digest: 'b'.repeat(64),
    bindings: [{ material: 'references/bug-fix.md', sha256: sha(material), source_refs: [{ path: 'pstack/skills/tdd/SKILL.md', sha256: 'c'.repeat(64), role: 'adopted_guidance' }] }],
  };
  const save = async () => writeFile(join(sourceRoot, 'provenance.json'), JSON.stringify(declaration) + '\n');
  await save();
  return { root, sourceRoot, output: join(root, 'out'), declaration, save };
}
test('exports exact declaration and binds only the declared material, leaving legacy material unbound', async t => {
  const f = await fixture(t); await exportMethods({ ...f, host: 'codex' });
  const manifest = JSON.parse(await readFile(join(f.output, 'manifest.json'), 'utf8'));
  assert.deepEqual(await readFile(join(f.output, 'provenance.json')), await readFile(join(f.sourceRoot, 'provenance.json')));
  assert.equal(manifest.provenance.status, 'declared_material_hashes_checked');
  assert.equal(manifest.provenance.authenticated, false);
  assert.deepEqual(manifest.provenance.bound_materials, ['references/bug-fix.md']);
  assert.ok(manifest.provenance.unbound_materials.includes('references/legacy.md'));
  assert.equal(manifest.provenance.upstream_content_verified, false);
  const exported = manifest.files.find(x => x.path === 'provenance.json');
  assert.equal(exported.sha256, sha(await readFile(join(f.output, 'provenance.json'))));
});
test('dry-run checks provenance without creating output', async t => {
  const f = await fixture(t); const r = await exportMethods({ ...f, host: 'claude', dryRun: true });
  assert.equal(r.provenance.status, 'declared_material_hashes_checked');
  assert.equal(existsSync(f.output), false);
});
test('changed material is rejected before creating output', async t => {
  const f = await fixture(t); await writeFile(join(f.sourceRoot, 'references/bug-fix.md'), '# Changed\n');
  await assert.rejects(exportMethods({ ...f, host: 'codex' }), /provenance_material_drift/);
  assert.equal(existsSync(f.output), false);
});
for (const [name, mutate] of [
  ['unknown field', d => { d.activation = true; }],
  ['empty bindings', d => { d.bindings = []; }],
  ['duplicate binding', d => { d.bindings.push(d.bindings[0]); }],
  ['missing material', d => { d.bindings[0].material = 'references/missing.md'; }],
  ['escaped material', d => { d.bindings[0].material = '../outside.md'; }],
  ['source outside subtree', d => { d.bindings[0].source_refs[0].path = 'elsewhere/SKILL.md'; }],
  ['duplicate source', d => { d.bindings[0].source_refs.push(d.bindings[0].source_refs[0]); }],
  ['coerced digest', d => { d.bindings[0].sha256 = [d.bindings[0].sha256]; }],
  ['moving ref', d => { d.upstream.commit = 'main'; }],
  ['credential URL', d => { d.upstream.repository = 'https://token@example.invalid/repo'; }],
  ['unknown upstream field', d => { d.upstream.qualified = true; }],
]) test(`rejects ${name} before output`, async t => {
  const f = await fixture(t); mutate(f.declaration); await f.save();
  await assert.rejects(exportMethods({ ...f, host: 'codex' }), /provenance_/);
  assert.equal(existsSync(f.output), false);
});
test('refuses provenance symlink', async t => {
  const f = await fixture(t); const path = join(f.sourceRoot, 'provenance.json');
  await rm(path); await symlink(join(f.sourceRoot, 'references/bug-fix.md'), path);
  await assert.rejects(exportMethods({ ...f, host: 'codex' }), /source_symlink/);
});
test('refuses oversized provenance before output', async t => {
  const f = await fixture(t); await writeFile(join(f.sourceRoot, 'provenance.json'), ' '.repeat(65537));
  await assert.rejects(exportMethods({ ...f, host: 'codex' }), /provenance_limit/);
});

 test('rejects contradictory hashes for one source path across material bindings', async t => {
  const f=await fixture(t); const material=await readFile(join(f.sourceRoot,'references/legacy.md'));
  f.declaration.bindings.push({material:'references/legacy.md',sha256:sha(material),source_refs:[{...f.declaration.bindings[0].source_refs[0],sha256:'d'.repeat(64)}]});await f.save();
  await assert.rejects(exportMethods({...f,host:'codex'}),/provenance_source_conflict/);assert.equal(existsSync(f.output),false);
 });

for(const [name,role] of [['unknown','certified'],['missing',undefined]]) test(`rejects ${name} source-reference role`,async t=>{
 const f=await fixture(t);if(role===undefined)delete f.declaration.bindings[0].source_refs[0].role;else f.declaration.bindings[0].source_refs[0].role=role;await f.save();
 await assert.rejects(exportMethods({...f,host:'codex'}),/provenance_/);assert.equal(existsSync(f.output),false);
});
test('real export returns the same provenance status as its saved manifest',async t=>{
 const f=await fixture(t);const result=await exportMethods({...f,host:'codex'});const manifest=JSON.parse(await readFile(join(f.output,'manifest.json'),'utf8'));
 assert.deepEqual(result.provenance,manifest.provenance);assert.match(result.provenance.limitation,/duplicate keys use last-value/);
});
test('canonical package retains its reviewed five bindings and fixed version',async t=>{
 const f=await fixture(t);const sourceRoot=new URL('../osstack-methods-skill/',import.meta.url).pathname;
 const result=await exportMethods({sourceRoot,host:'codex',output:f.output,dryRun:true});
 assert.deepEqual(result.provenance.bound_materials,['references/bug-fix.md','references/code-review.md','references/evidence.md','references/investigation.md','references/sources.md']);
 assert.equal(result.provenance.upstream.commit,'c742dd61706fbacc1b95f1a20b7b988cf096ce6c');assert.equal(result.provenance.upstream.package_version,'0.15.36');
 assert.equal(result.provenance.adoption_candidate_digest,'699ffdbbdd848f4e55dc0f7466d6bf21807b87306f2ff45ee436dc26ab26d7d3');
});
