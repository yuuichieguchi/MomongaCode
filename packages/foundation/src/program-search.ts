import path from 'node:path';
import { nodeFileSystemSync } from './node-file-system.ts';

export type SearchEnv = Readonly<Record<string, string | undefined>>;

const isExecutableFile = (candidate: string): boolean => {
  try {
    if (!nodeFileSystemSync.statSync(candidate).isFile()) return false;
    nodeFileSystemSync.accessSync(candidate, 'execute');
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EACCES' || code === 'ELOOP') return false;
    throw error;
  }
};

const namesOf = (program: string, env: SearchEnv): string[] => {
  const extensions = (env['PATHEXT'] ?? '').split(';').filter((extension) => extension !== '');
  return [program, ...extensions.map((extension) => `${program}${extension.toLowerCase()}`), ...extensions.map((extension) => `${program}${extension}`)];
};

export const findProgramOnPath = (program: string, env: SearchEnv): string | undefined => {
  const entries = (env['PATH'] ?? '').split(path.delimiter).filter((entry) => entry !== '');
  for (const entry of entries) {
    for (const name of namesOf(program, env)) {
      const candidate = path.join(entry, name);
      if (isExecutableFile(candidate)) return candidate;
    }
  }
  return undefined;
};
