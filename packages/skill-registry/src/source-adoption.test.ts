import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createScratchDir } from '@osstack/core';
import { canonicalJson, sourceDigest, SourceSnapshot } from '@osstack/protocol/source';
import { inspectGitSource, type GitSourceInspection, type InspectedSourceFile } from './source-snapshot.js';
import { assembleDeclaredAdoption, SourceAdoptionError } from './source-adoption.js';

const repo = 'https://example.invalid/skills';
const commit = 'a'.repeat(40);
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
function inspection(subdir: string, extra: InspectedSourceFile[] = []): GitSourceInspection {
  const files: InspectedSourceFile[] = [
    { path: 'LICENSE', mode: '100644', blob: 'b'.repeat(40), bytes: 7, sha256: hash('license'), role: 'license' },
    { path: `${subdir}/SKILL.md`, mode: '100644', blob: hash(subdir).slice(0, 40), bytes: 4, sha256: hash(subdir), role: 'source' }, ...extra,
  ];
  files.sort((a,b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
  return resign({ kind: 'source_inspection', schema_version: 1, dependency_resolution: 'not_performed', repository_identity: 'caller_asserted', expected_digest_checked: false,
    pin: { kind: 'source_pin', schema_version: 1, repository: repo, commit, subdir, content_sha256: '0'.repeat(64), license_refs: [] }, files, inspection_digest: '' });
}
function resign(i: GitSourceInspection): GitSourceInspection {
  i.pin.content_sha256 = sourceDigest('osstack.joint.source-content.v1', { schema_version: 1, repository: i.pin.repository, commit: i.pin.commit, subdir: i.pin.subdir, files: i.files });
  i.pin.license_refs = [...new Set(i.files.filter(f => f.role === 'license').map(f => `sha256:${f.sha256}`))].sort();
  const { inspection_digest: _old, ...body } = i;
  i.inspection_digest = sourceDigest('osstack.joint.source-inspection.v1', body); return i;
}
function example() {
  const a = inspection('method'), b = inspection('principle');
  return { declaration: { schema_version: 1, repository: repo, commit, package_version: '0.15.36', roots: ['method'],
    components: [
      { id: 'method', subdir: 'method', expectedContentSha256: a.pin.content_sha256, requires: ['principle'], external_requires: ['host'] },
      { id: 'principle', subdir: 'principle', expectedContentSha256: b.pin.content_sha256, requires: [], external_requires: [] },
    ], external_requirements: [{ id: 'host', description: 'A host that can read method material.' }] }, inspections: [a,b] };
}
function assemble(x = example()) { return assembleDeclaredAdoption(x.declaration, x.inspections); }


// Each source file is shared by every nested component. Per-inspection input stays
// bounded; only the aggregate component_ids/roles expansion grows quadratically.
function nestedExample(componentCount: number, sharedFileCount: number) {
  const subdirs = Array.from({ length: componentCount }, (_, n) => Array(n + 1).fill('nested').join('/'));
  const leaf = subdirs.at(-1)!;
  const shared: InspectedSourceFile[] = Array.from({ length: sharedFileCount }, (_, n) => ({
    path: leaf + '/file-' + String(n).padStart(3, '0') + '.md', mode: '100644',
    blob: hash('shared-' + n).slice(0, 40), bytes: 1, sha256: hash('shared-' + n), role: 'source',
  }));
  const inspections = subdirs.map(subdir => {
    const i = inspection(subdir);
    i.files = [i.files.find(f => f.role === 'license')!, ...shared.map(f => ({ ...f }))];
    return resign(i);
  });
  const ids = subdirs.map((_, n) => 'c' + String(n).padStart(2, '0') + 'x'.repeat(61));
  return {
    declaration: { schema_version: 1, repository: repo, commit, package_version: '0.15.36',
      roots: ids, components: inspections.map((i, n) => ({
        id: ids[n]!, subdir: i.pin.subdir, expectedContentSha256: i.pin.content_sha256,
        requires: [], external_requires: [],
      })), external_requirements: [],
    },
    inspections,
  };
}

describe('declared candidate closure, not semantic discovery or activation', () => {

  it('labels package version as caller asserted even when its label changes at the same commit', () => {
    const x = example(), first = assemble(x);
    x.declaration.package_version = '9.9.9';
    const changed = assemble(x);
    expect(first.package_version_identity).toBe('caller_asserted');
    expect(changed.package_version_identity).toBe('caller_asserted');
    expect(changed.package_version).toBe('9.9.9');
    expect(changed.commit).toBe(first.commit);
    expect(changed.candidate_digest).not.toBe(first.candidate_digest);
  });
  it('accepts a small legal nested-component overlap and retains both roles', () => {
    const x = nestedExample(3, 4), out = assemble(x);
    expect(out.files).toHaveLength(5);
    expect(out.total_bytes).toBe(11);
    expect(out.files.every(f => f.component_ids.length === 3 && f.roles.length === 3)).toBe(true);
    expect(out.components).toHaveLength(3);
  });
  it('maps only oversized final candidate serialization to typed RESOURCE_LIMIT', () => {
    const x = nestedExample(32, 500);
    // Unique files (501) and bytes (507) are small. Two 64-byte IDs per
    // component/file alone exceed 1 MiB before JSON keys or any other metadata.
    expect(500 * 32 * 2 * 64).toBeGreaterThan(1_048_576);
    expect(x.inspections.every(i => Buffer.byteLength(canonicalJson(i)) < 1_048_576)).toBe(true);
    let failure: unknown;
    try { assemble(x); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(SourceAdoptionError);
    expect(failure).toMatchObject({ code: 'RESOURCE_LIMIT', message: 'RESOURCE_LIMIT' });
  });
  it.each([
    ['docs/license', false],
    ['docs/NOTICE', true],
  ] as const)('checks cross-component license path %s (allowed=%s)', (otherPath, allowed) => {
    const x = example();
    for (const [index, path] of ['docs/LICENSE', otherPath].entries()) {
      const i = x.inspections[index]!;
      i.files.find(f => f.role === 'license')!.path = path;
      i.files.sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
      resign(i);
      x.declaration.components[index]!.expectedContentSha256 = i.pin.content_sha256;
    }
    if (allowed) expect(assemble(x).files).toHaveLength(4);
    else expect(() => assemble(x)).toThrowError(new SourceAdoptionError('FILE_CONFLICT'));
  });

  it('deduplicates a shared license, binds dependencies and stays candidate-only', () => {
    const x=example(), before=JSON.stringify(x), out=assemble(x);
    expect(out.kind).toBe('declared_adoption_candidate'); expect(out.dependency_order).toEqual(['principle','method']);
    expect(out.files).toHaveLength(3); expect(out.total_bytes).toBe(15);
    expect(out.files[0]?.component_ids).toEqual(['method','principle']);
    expect(out.declared_closure).toBe('verified'); expect(out.semantic_completeness).toBe('not_assessed');
    expect(out.activation).toBe(false); expect(out.installation).toBe('not_performed'); expect(out.formal_snapshot).toBe(false);
    expect(out.external_requirements[0]?.status).toBe('not_checked'); expect(SourceSnapshot.safeParse(out).success).toBe(false);
    const { candidate_digest, ...body } = out;
    expect(candidate_digest).toBe(hash('osstack.joint.declared-adoption.v1\n'+canonicalJson(body))); expect(JSON.stringify(x)).toBe(before);
  });
  it('set ordering is deterministic and graph changes alter the candidate digest', () => {
    const x=example(), first=assemble(x); x.declaration.components.reverse();x.inspections.reverse();expect(assemble(x)).toEqual(first);
    x.declaration.roots=['method','principle'];x.declaration.components.find(c=>c.id==='method')!.requires=[];
    expect(assemble(x).candidate_digest).not.toBe(first.candidate_digest);
  });
  it('handles a diamond once and permits required nodes that are also roots', () => {
    const x=example(), c=inspection('other');x.inspections.push(c);
    x.declaration.components.push({id:'other',subdir:'other',expectedContentSha256:c.pin.content_sha256,requires:['principle'],external_requires:[]});
    x.declaration.components[0]!.requires.push('other');x.declaration.roots.push('principle');
    expect(assemble(x).dependency_order).toEqual(['principle','other','method']);
  });
  it.each(['missing','cycle','unreachable','extra-inspection','duplicate-id','duplicate-subdir','external-missing','external-unused'])('rejects declaration closure defect: %s', defect => {
    const x=example();
    if(defect==='missing')x.declaration.components[0]!.requires=['absent'];
    if(defect==='cycle')x.declaration.components[1]!.requires=['method'];
    if(defect==='unreachable')x.declaration.components[0]!.requires=[];
    if(defect==='extra-inspection')x.inspections.push(inspection('extra'));
    if(defect==='duplicate-id')x.declaration.components[1]!.id='method';
    if(defect==='duplicate-subdir')x.declaration.components[1]!.subdir='method';
    if(defect==='external-missing')x.declaration.external_requirements=[];
    if(defect==='external-unused')x.declaration.external_requirements.push({id:'unused',description:'Unused'});
    expect(()=>assemble(x)).toThrow();
  });
  it.each(['envelope','content','expected','repository','commit','file','license','extra-key'])('rejects inconsistent supplied inspection: %s', defect => {
    const x=example(), i=x.inspections[0]!;
    if(defect==='envelope')i.inspection_digest='0'.repeat(64);
    if(defect==='content')i.pin.content_sha256='0'.repeat(64);
    if(defect==='expected')x.declaration.components[0]!.expectedContentSha256='0'.repeat(64);
    if(defect==='repository'){i.pin.repository='https://other.invalid/skills';resign(i);}
    if(defect==='commit'){i.pin.commit='c'.repeat(40);resign(i);}
    if(defect==='file')i.files[1]!.bytes++;
    if(defect==='license'){i.pin.license_refs=['sha256:'+'d'.repeat(64)];const {inspection_digest:_,...body}=i;i.inspection_digest=sourceDigest('osstack.joint.source-inspection.v1',body);}
    if(defect==='extra-key')Object.assign(i,{activation:true});
    expect(()=>assemble(x)).toThrow();
  });
  it.each(['path','sort','mode','source-outside','file-bytes','array-digest','extra-declaration'])('rejects invalid facts even if a caller recalculates digests: %s', defect => {
    const x=example(), i=x.inspections[0]!;
    if(defect==='path')i.files[1]!.path='method/../outside';
    if(defect==='sort')i.files.reverse();
    if(defect==='mode')Object.assign(i.files[1]!,{mode:'120000'});
    if(defect==='source-outside')i.files[1]!.path='outside/SKILL.md';
    if(defect==='file-bytes')i.files[1]!.bytes=512*1024+1;
    if(defect==='array-digest')Object.assign(x.declaration.components[0]!,{expectedContentSha256:[i.pin.content_sha256]});
    if(defect==='extra-declaration')Object.assign(x.declaration,{authorized:true});
    resign(i);if(defect!=='array-digest')x.declaration.components[0]!.expectedContentSha256=i.pin.content_sha256;
    expect(()=>assemble(x)).toThrow();
  });
  it('rejects conflicting shared path facts after both envelopes have been recalculated', () => {
    const x=example(), i=x.inspections[1]!;i.files[0]!.bytes=8;resign(i);x.declaration.components[1]!.expectedContentSha256=i.pin.content_sha256;
    expect(()=>assemble(x)).toThrow('FILE_CONFLICT');
  });
  it.each(['files','bytes'])('enforces aggregate unique %s budget across individually bounded inspections', budget => {
    const x=example();
    for(let n=0;n<x.inspections.length;n++){
      const i=x.inspections[n]!;
      for(let k=0;k<(budget==='files'?256:9);k++)i.files.push({path:`${i.pin.subdir}/f${k}`,mode:'100644',blob:hash(`${n}-${k}`).slice(0,40),bytes:budget==='files'?0:512*1024,sha256:hash(`${n}-${k}`),role:'source'});
      i.files.sort((a,b)=>Buffer.compare(Buffer.from(a.path),Buffer.from(b.path)));resign(i);x.declaration.components[n]!.expectedContentSha256=i.pin.content_sha256;
    }
    expect(()=>assemble(x)).toThrow('RESOURCE_LIMIT');
  });
  it('accepts inspections produced from actual fixed local Git objects without changing the checkout', async () => {
    const root=await createScratchDir('tests','adoption');
    const git=(...args:string[])=>execFileSync('git',['-C',root,...args],{encoding:'utf8'}).trim();
    git('init','-q');git('config','user.name','Fixture');git('config','user.email','fixture@example.invalid');
    for(const dir of ['method','principle']){mkdirSync(join(root,dir));writeFileSync(join(root,dir,'SKILL.md'),dir);}
    writeFileSync(join(root,'LICENSE'),'MIT fixture');git('add','.');git('commit','-qm','fixture');
    const x=example();x.declaration.commit=git('rev-parse','HEAD');
    x.inspections=x.declaration.components.map(c=>inspectGitSource({gitBinary:execFileSync('which',['git'],{encoding:'utf8'}).trim(),repositoryPath:root,repository:repo,commit:x.declaration.commit,subdir:c.subdir,licensePaths:['LICENSE']}));
    x.declaration.components.forEach((c,n)=>{c.expectedContentSha256=x.inspections[n]!.pin.content_sha256;});
    expect(assemble(x).files).toHaveLength(3);expect(git('status','--porcelain')).toBe('');
  });
});
