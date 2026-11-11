import path from 'node:path';

export const absoluteFrom = (target: string, cwd: string): string => (path.isAbsolute(target) ? target : `${cwd}${path.sep}${target}`);
