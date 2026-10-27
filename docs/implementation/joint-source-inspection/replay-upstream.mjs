// Run after building the package. Arguments: pstack complete mirror, Firstmate repo.
// Network hydration is intentionally external to this source inspector.
import { inspectGitSource } from '../../../packages/skill-registry/dist/source-snapshot.js';
import { resolve } from 'node:path';
if (process.argv.length !== 4) throw new Error('usage: node replay-upstream.mjs <pstack-complete-mirror> <firstmate-repository>');
const sources = [
  { repositoryPath: resolve(process.argv[2]), repository: 'https://github.com/cursor/plugins.git', commit: '99b609a72323b70204eab407c622f436e858e112', subdir: 'pstack', licensePaths: ['pstack/LICENSE'], expectedContentSha256: 'a265a1bfce66a6c2498c2798fe4e4ab30edabf06983fe46e04771d28011219f0' },
  { repositoryPath: resolve(process.argv[3]), repository: 'https://github.com/kunchenguid/firstmate.git', commit: 'af1c6817fc47589b162cbc361671c43cdb150933', subdir: '.agents/skills/harness-adapters', licensePaths: ['LICENSE'], expectedContentSha256: '233e79ef33297f419ab9593a8984b4330b1acc58c10fe3b83f4d4562eb12463d' },
];
for (const input of sources) {
  const result = inspectGitSource({ gitBinary: process.env.GIT_BINARY ?? '/usr/bin/git', ...input });
  console.log(JSON.stringify({ repository: input.repository, commit: input.commit, files: result.files.length, expected_digest_checked: result.expected_digest_checked, content_sha256: result.pin.content_sha256, dependency_resolution: result.dependency_resolution }));
}
