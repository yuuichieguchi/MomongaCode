import { momongaLayout } from '@momonga/foundation';
import type { MomongaPaths } from '@momonga/foundation';

export const protectedRootAreasOf = (paths: MomongaPaths, canonicalHome: string): string[] => [
  paths.root,
  momongaLayout(canonicalHome).keychains,
  paths.tmp.root,
];
