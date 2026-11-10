import path from 'node:path';
import { MINIMAL_CHILD_PATH } from '@momonga/foundation';
import { assertFakeSecretStoreEnv, fakeSecretProgramsBin } from './secret-store-env-check.ts';

export const productTestEnv = (env: Readonly<Record<string, string>> = {}): Record<string, string> => {
  const built = { ...env, PATH: `${fakeSecretProgramsBin()}${path.delimiter}${env['PATH'] ?? MINIMAL_CHILD_PATH}` };
  assertFakeSecretStoreEnv(built, 'a product process');
  return built;
};
