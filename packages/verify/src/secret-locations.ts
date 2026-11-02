import path from 'node:path';
import type { MomongaPaths } from '@momonga/foundation';
import type { SecretLocation } from './properties.ts';

export const CREDENTIAL_PATHS: readonly string[] = [
  '.ssh',
  '.aws',
  '.gnupg',
  '.azure',
  '.kube',
  '.config/gcloud',
  '.config/gh',
  '.docker/config.json',
  '.netrc',
  '.npmrc',
  '.pypirc',
  '.git-credentials',
];

const ALL_ACCESS: SecretLocation['accesses'] = ['read', 'write'];

export const secretLocationsOf = (home: string, paths: Pick<MomongaPaths, 'root' | 'keychains'>, extra: readonly string[]): SecretLocation[] => [
  ...CREDENTIAL_PATHS.map((relative) => ({ label: `~/${relative}`, directory: path.join(home, relative), accesses: ALL_ACCESS })),
  { label: 'the Momonga home folder (gateway key, settings, sockets)', directory: paths.root, accesses: ALL_ACCESS },
  { label: 'the platform key store', directory: paths.keychains, accesses: ALL_ACCESS },
  ...extra.map((directory) => ({ label: directory, directory, accesses: ALL_ACCESS })),
];
