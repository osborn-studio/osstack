import { inspectGitSource } from '/Users/osborn/Developer/CodeX/.worktrees/osstack/joint-source-snapshot/packages/skill-registry/dist/source-snapshot.js';
import { writeFileSync } from 'node:fs';
const out='/Volumes/AIMATE_WORK/tmp/osstack/runtime/joint-handoff-20261027';
const inputs=[
 ['pstack',{repositoryPath:out+'/pstack-mirror.git',repository:'https://github.com/cursor/plugins.git',commit:'99b609a72323b70204eab407c622f436e858e112',subdir:'pstack',licensePaths:['pstack/LICENSE']}],
 ['firstmate-harness-adapters',{repositoryPath:'/Volumes/AIMATE_WORK/Developer/CodeX/firstmate',repository:'https://github.com/kunchenguid/firstmate.git',commit:'af1c6817fc47589b162cbc361671c43cdb150933',subdir:'.agents/skills/harness-adapters',licensePaths:['LICENSE']}],
];
for(const [name,input] of inputs){
 const result=inspectGitSource({gitBinary:'/usr/bin/git',...input});
 const replay=inspectGitSource({gitBinary:'/usr/bin/git',...input,expectedContentSha256:result.pin.content_sha256});
 if(!replay.expected_digest_checked)throw Error('missing expected digest check');
 writeFileSync(out+'/'+name+'-inspection.json',JSON.stringify(result,null,2)+'\n');
 console.log(JSON.stringify({name,commit:input.commit,files:result.files.length,bytes:result.files.reduce((n,f)=>n+f.bytes,0),content_sha256:result.pin.content_sha256,replay:'pass',dependency_resolution:result.dependency_resolution}));
}
