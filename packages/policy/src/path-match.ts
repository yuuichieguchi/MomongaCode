import path from 'node:path';
import { volumeIsCaseInsensitive } from '@momonga/foundation';

export { volumeIsCaseInsensitive };

export const absoluteFrom = (target: string, cwd: string): string => (path.isAbsolute(target) ? target : `${cwd}/${target}`);
