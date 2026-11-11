import path from 'node:path';
import { momongaLayout } from './momonga-paths.ts';
import type { MomongaPaths } from './momonga-paths.ts';

export type SecretLocation = { label: string; directory: string };

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

export const secretLocationsIn = (home: string, paths: Pick<MomongaPaths, 'root' | 'keychains'>): SecretLocation[] => [
  ...CREDENTIAL_PATHS.map((relative) => ({ label: `~/${relative}`, directory: path.join(home, relative) })),
  { label: 'the Momonga home folder (gateway key, settings, sockets)', directory: paths.root },
  { label: 'the platform key store', directory: paths.keychains },
];

export const standardSecretLocations = (home: string): SecretLocation[] => secretLocationsIn(home, momongaLayout(home));
