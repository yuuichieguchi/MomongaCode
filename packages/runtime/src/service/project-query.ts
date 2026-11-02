import path from 'node:path';
import { canonicalPath, isTransientErrno } from '@momonga/foundation';
import { invalidRequest } from './errors.ts';

export const canonicalProject = (raw: string, param: string): string => {
  if (!path.isAbsolute(raw)) throw invalidRequest(`${param} ${raw} must be an absolute path`, param);
  try {
    return canonicalPath(raw);
  } catch (error) {
    if (isTransientErrno(error)) throw error;
    throw invalidRequest(`${param} ${raw} cannot be resolved: ${(error as Error).message}`, param);
  }
};
