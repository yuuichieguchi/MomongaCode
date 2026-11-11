import { CREDENTIAL_PATHS, standardSecretLocations } from '@momonga/foundation';
import type { MomongaPaths, SecretLocation } from '@momonga/foundation';

export { CREDENTIAL_PATHS };

export const secretLocationsOf = (paths: Pick<MomongaPaths, 'home' | 'root' | 'keychains'>, extra: readonly string[]): SecretLocation[] => [
  ...standardSecretLocations(paths),
  ...extra.map((directory) => ({ label: directory, directory })),
];
