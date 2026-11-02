import { acquireProcessLock, createKernelLockMechanism, hostKernelLock } from '@momonga/foundation';

const lockPath = process.argv[2];
if (lockPath === undefined) throw new Error('lock path argument is required');
const platform = process.argv[3];
await acquireProcessLock(lockPath, undefined, { mechanism: platform === undefined ? hostKernelLock() : createKernelLockMechanism(platform as NodeJS.Platform) });
process.stdout.write('locked\n');
setInterval(() => undefined, 60_000);
