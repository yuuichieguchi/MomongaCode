import { spawn } from 'node:child_process';

const childScript = process.argv[2];
if (childScript === undefined) throw new Error('usage: lifeline-middle.ts <child script>');
const child = spawn(process.execPath, [childScript], { stdio: ['ignore', 'ignore', 'inherit', 'pipe'] });
process.stdout.write(`child ${child.pid}\n`);
setInterval(() => undefined, 60_000);
