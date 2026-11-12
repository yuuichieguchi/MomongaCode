import path from 'node:path';

const SESSION_SCRATCH_ROLE = 'session-scratch';

export const sessionScratchRoleIn = (sessionsRoot: string): string => path.join(sessionsRoot, SESSION_SCRATCH_ROLE);

export const sessionScratchRoleOf = (sessionScratch: string): string => sessionScratchRoleIn(path.dirname(sessionScratch));
