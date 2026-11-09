import { createKernelLockMechanism, hostKernelLock } from '@momonga/foundation';

const lockPath = process.argv[2];
if (lockPath === undefined) throw new Error('lock path argument is required');
const platform = process.argv[3];
const mechanism = platform === undefined ? hostKernelLock() : createKernelLockMechanism(platform as NodeJS.Platform);
const outcome = await mechanism.claim(lockPath);
if (outcome.kind !== 'claimed') throw new Error(`${lockPath} is held by another process`);
process.stdout.write('locked\n');
setInterval(() => undefined, 60_000);
