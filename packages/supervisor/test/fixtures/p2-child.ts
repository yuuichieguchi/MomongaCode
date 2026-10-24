import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';

const behaviours = new Map<string, string>();
for (const arg of process.argv.slice(2)) {
  if (!arg.startsWith('--p2-')) continue;
  const [name, value = ''] = arg.slice('--p2-'.length).split('=');
  if (name !== undefined) behaviours.set(name, value);
}

const keepAlive = setInterval(() => undefined, 60_000);

const report = (fields: Record<string, unknown>): void => {
  process.stdout.write(`${JSON.stringify(fields)}\n`);
};

if (behaviours.has('watch-lifeline')) {
  const lifeline = new net.Socket({ fd: 3, readable: true, writable: false });
  lifeline.on('end', () => process.exit(0));
  lifeline.on('close', () => process.exit(0));
  lifeline.on('error', () => process.exit(0));
  lifeline.resume();
}

if (behaviours.has('close-lifeline')) fs.closeSync(3);

const termFile = behaviours.get('count-term');
if (termFile !== undefined) {
  process.on('SIGTERM', () => {
    fs.appendFileSync(termFile, 'TERM\n');
    setTimeout(() => process.exit(0), 300);
  });
}

if (behaviours.has('ignore-term')) process.on('SIGTERM', () => undefined);

const grandchild = behaviours.get('grandchild');
if (grandchild !== undefined) {
  const child =
    grandchild === 'group'
      ? spawn('/bin/sleep', ['30'], { detached: false, stdio: 'ignore' })
      : grandchild === 'mapped'
        ? spawn('/bin/sleep', ['30'], { detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ignore', 4] })
        : spawn('/bin/sleep', ['30'], { detached: true, stdio: 'ignore' });
  child.unref();
  report({ grandchild: child.pid });
  if (behaviours.has('exit-after-grandchild')) {
    clearInterval(keepAlive);
    setTimeout(() => process.exit(0), 50);
  }
}

if (behaviours.has('stderr-trace')) process.stderr.write('Error: fixture crash\n    at fixture (p2-child.ts:1:1)\n');

report({ started: process.pid });
