import { hostReplace, replaceProcess } from '../src/handover/replace-process.ts';

const RESULT_BYTES = 4 * 1024 * 1024;
const way = process.argv[2];

process.stdout.write(`${'r'.repeat(RESULT_BYTES)}\nend of the result\n`);
if (way === 'exec') await replaceProcess({ file: process.execPath, args: ['-e', ''], env: process.env }, hostReplace, { release: () => undefined, relayed: () => undefined });
else await replaceProcess({ file: process.execPath, args: ['-e', ''], env: process.env }, { ...hostReplace, execve: undefined }, { release: () => undefined, relayed: () => undefined });
