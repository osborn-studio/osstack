import { spawn } from 'node:child_process';
import { appendFileSync, writeFileSync } from 'node:fs';
const commands = {"full-tests": ["pnpm", "-r", "--no-bail", "--workspace-concurrency=1", "test", "--maxWorkers=1"], "typecheck": ["pnpm", "typecheck:check"], "schemas": ["pnpm", "--filter", "@osstack/protocol", "check:schemas"], "kernel": ["node", "scripts/probe-graph-saver.mjs"], "functional": ["node", "scripts/probe-graph-c2.mjs"], "startup": ["node", "scripts/bench-cli-startup.mjs"], "whitespace": ["git", "diff", "--check"]};
commands.matrix = ["node", "scripts/verify-graph-runtime.mjs", "--seed", "250919", "--repeat", "2", "--output", "/Volumes/AIMATE_WORK/tmp/g25-candidate/matrix.json"];
commands.contained = ["node", "scripts/verify-contained-executor.mjs", "/Volumes/AIMATE_WORK/tmp/g25-candidate/config.json", "/Volumes/AIMATE_WORK/tmp/g25-candidate/real-final.json"];
commands.candidate = ["pnpm", "--filter", "@osstack/cli", "test", "src/graph-verification.test.ts", "src/graph-delivery.integration.test.ts", "-t", "contained|substitution|actual child|repairs from|host bounded|finite branch|negative quality", "--maxWorkers=1"];
if (process.argv[2] === 'candidate') { process.env.G25_CONTAINED_CONFIG = '/Volumes/AIMATE_WORK/tmp/g25-candidate/candidate-config.json'; process.env.G25_CONTAINED_REPORT_DIR = '/Volumes/AIMATE_WORK/tmp/g25-candidate/real-evidence'; }
const name = process.argv[2]; const command = commands[name];
if (!command) throw Error('unknown check');
const child = spawn(command[0], command.slice(1), {cwd: "/Volumes/AIMATE_WORK/Developer/CodeX/osstack-graph-runtime-foundation", env: process.env, stdio: ['ignore','pipe','pipe']});
const log = '/Volumes/AIMATE_WORK/tmp/g25-candidate/accepted-' + name + '.txt'; writeFileSync(log, '');
let output = ''; const record = x => { output += x; appendFileSync(log, x); }; child.stdout.on('data', record); child.stderr.on('data', record);
child.on('error', e => { console.error(e); process.exitCode = 1; });
child.on('close', async code => { console.log(name + ': exit=' + code + '\n' + output.slice(-1600)); process.exitCode = code ?? 1; });
