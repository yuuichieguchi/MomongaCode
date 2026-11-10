import fs from 'node:fs';

const ignoresTerm = process.argv.includes('ignore-term');
const pidFile = process.argv.find((argument) => argument.startsWith('--pid-file='))?.slice('--pid-file='.length);

if (ignoresTerm) {
  process.on('SIGTERM', () => {
    process.stderr.write('term\n');
  });
}
process.stdin.on('data', () => undefined);
process.stdin.on('end', () => undefined);
process.stdin.resume();
setInterval(() => undefined, 1 << 30);
if (pidFile !== undefined) fs.appendFileSync(pidFile, `${process.pid}\n`);
process.stderr.write('armed\n');
