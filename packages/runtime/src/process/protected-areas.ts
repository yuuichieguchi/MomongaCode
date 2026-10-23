import path from 'node:path';
import type { MomongaPaths } from '@momonga/foundation';

export const protectedRootAreasOf = (paths: MomongaPaths, canonicalHome: string): string[] => [
  paths.root,
  path.join(canonicalHome, 'Library', 'Keychains'),
  paths.tmp.root,
];
