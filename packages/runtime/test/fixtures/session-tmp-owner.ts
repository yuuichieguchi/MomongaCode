import { ensureSessionTmpDir, momongaPaths } from '@momonga/foundation';
import { expectedKernelLockOn } from '@momonga/testkit';

const [home, sessionId, platform] = process.argv.slice(2);
if (home === undefined || sessionId === undefined || platform === undefined) throw new Error('home, session id and platform arguments are required');
await ensureSessionTmpDir(momongaPaths(home, process.platform, process.env), sessionId, { lock: expectedKernelLockOn(platform as NodeJS.Platform) });
process.stdout.write('ready\n');
setInterval(() => undefined, 60_000);
