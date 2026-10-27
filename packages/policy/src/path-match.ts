import path from 'node:path';
import { canonicalPath, volumeIsCaseInsensitive } from '@momonga/foundation';

export { volumeIsCaseInsensitive };

export const canonicalizePath = (absolute: string): string | null => {
  try {
    return canonicalPath(absolute);
  } catch {
    return null;
  }
};

export const absoluteFrom = (target: string, cwd: string): string => (path.isAbsolute(target) ? target : `${cwd}/${target}`);
