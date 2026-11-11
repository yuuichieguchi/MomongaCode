import path from 'node:path';
import { hostPaths, isTransientErrno } from '@momonga/foundation';
import { invalidRequest } from './errors.ts';

export const canonicalProject = async (raw: string, param: string, signal: AbortSignal): Promise<string> => {
  if (!path.isAbsolute(raw)) throw invalidRequest(`${param} ${raw} must be an absolute path`, param);
  try {
    return await hostPaths(signal).canonicalPath(raw);
  } catch (error) {
    if (isTransientErrno(error)) throw error;
    throw invalidRequest(`${param} ${raw} cannot be resolved: ${(error as Error).message}`, param);
  }
};
