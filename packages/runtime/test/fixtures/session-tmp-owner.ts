import { createKernelLockMechanism, ensureSessionTmpDir, momongaPaths } from '@momonga/foundation';

const [home, sessionId, platform] = process.argv.slice(2);
if (home === undefined || sessionId === undefined || platform === undefined) throw new Error('home, session id and platform arguments are required');
await ensureSessionTmpDir(momongaPaths(home), sessionId, { lock: createKernelLockMechanism(platform as NodeJS.Platform) });
process.stdout.write('ready\n');
setInterval(() => undefined, 60_000);
