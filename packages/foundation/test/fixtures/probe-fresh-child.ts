import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { defaultProcessStartProbe } from '../../src/process-lock.ts';

const sleeper = spawn('/bin/sleep', ['60'], { stdio: 'ignore' });
const pid = sleeper.pid;
if (pid === undefined) throw new Error('spawn of sleep failed');
process.stdout.write(`${JSON.stringify({ sleeper: pid })}\n`);
const spawnedAt = Date.now();
try {
  const start = await defaultProcessStartProbe(pid);
  process.stdout.write(JSON.stringify({ spawnedAt, start: start ?? null, sleeper: pid }));
} finally {
  sleeper.kill('SIGKILL');
  await once(sleeper, 'exit');
}
