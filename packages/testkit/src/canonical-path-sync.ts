import { syncPaths } from '@momonga/foundation';

export const canonicalPathSync = (input: string): string => syncPaths.canonicalPath(input);
