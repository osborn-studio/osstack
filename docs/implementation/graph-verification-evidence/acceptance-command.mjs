import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
const commands = {"full-tests": ["pnpm", "-r", "--no-bail", "--workspace-concurrency=1", "test", "--maxWorkers=1"], "typecheck": ["pnpm", "typecheck:check"], "schemas": ["pnpm", "--filter", "@osstack/protocol", "check:schemas"], "kernel": ["node", "scripts/probe-graph-saver.mjs"], "functional": ["node", "scripts/probe-graph-c2.mjs"], "startup": ["node", "scripts/bench-cli-startup.mjs"], "whitespace": ["git", "diff", "--check"]};
const name = process.argv[2]; const command = commands[name];
if (!command) throw Error('unknown check');
const child = spawn(command[0], command.slice(1), {cwd: "/Volumes/AIMATE_WORK/Developer/CodeX/osstack-graph-runtime-foundation", env: process.env, stdio: ['ignore','pipe','pipe']});
let output = ''; child.stdout.on('data', x => output += x); child.stderr.on('data', x => output += x);
child.on('error', e => { console.error(e); process.exitCode = 1; });
child.on('close', async code => { await writeFile("/Volumes/AIMATE_WORK/tmp/gc6" + '/accepted-' + name + '.txt', output); console.log(name + ': exit=' + code + '\n' + output.slice(-1600)); process.exitCode = code ?? 1; });
