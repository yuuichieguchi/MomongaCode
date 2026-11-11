import { acquireProcessLock, kernelLockNamed } from '@momonga/foundation';
import type { KernelLockMechanism } from '@momonga/foundation';
import { testKernelLock } from './test-locks.ts';

const lockPath = process.argv[2];
if (lockPath === undefined) throw new Error('lock path argument is required');
const named = process.argv[3];
await acquireProcessLock(lockPath, undefined, { mechanism: named === undefined ? testKernelLock() : kernelLockNamed(named as KernelLockMechanism['name']) });
process.stdout.write('locked\n');
setInterval(() => undefined, 60_000);
