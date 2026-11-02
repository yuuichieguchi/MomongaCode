import { UnadoptedEnv } from '../../src/process-lock.ts';

const lockPath = process.argv[2];
if (lockPath === undefined) throw new Error('lock path argument is required');
const unadopted = new UnadoptedEnv(process.env);
unadopted.adopt(lockPath);
process.stdout.write(`adopted ${JSON.stringify(Object.keys(unadopted.withoutLockVariables()).filter((name) => name.startsWith('MOMONGA_LOCK_')))}\n`);
setInterval(() => undefined, 60_000);
