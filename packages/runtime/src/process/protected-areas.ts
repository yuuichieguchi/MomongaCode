import type { MomongaPaths } from '@momonga/foundation';

export const protectedRootAreasOf = (paths: MomongaPaths): string[] => [
  paths.root,
  paths.keychains,
  paths.executables,
  paths.tmp.root,
];
