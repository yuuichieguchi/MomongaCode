import { acquireProcessLock } from '@momonga/foundation';

const lockPath = process.argv[2];
if (lockPath === undefined) throw new Error('lock path argument is required');
await acquireProcessLock(lockPath);
process.stdout.write('locked\n');
setInterval(() => undefined, 60_000);
