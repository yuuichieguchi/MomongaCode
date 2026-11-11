import { CREDENTIAL_PATHS, secretLocationsIn } from '@momonga/foundation';
import type { MomongaPaths, SecretLocation } from '@momonga/foundation';

export { CREDENTIAL_PATHS };

export const secretLocationsOf = (home: string, paths: Pick<MomongaPaths, 'root' | 'keychains'>, extra: readonly string[]): SecretLocation[] => [
  ...secretLocationsIn(home, paths),
  ...extra.map((directory) => ({ label: directory, directory })),
];
