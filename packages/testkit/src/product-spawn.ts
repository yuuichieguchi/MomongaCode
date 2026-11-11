import path from 'node:path';
import { MINIMAL_CHILD_PATH } from '@momonga/foundation';
import { fakeBrowserOf } from './fake-programs.ts';
import { assertFakeSecretStoreEnv, fakeSecretProgramsBin } from './secret-store-env-check.ts';
import { LOCK_PROOF_ENV, lockProofFolder } from './test-locks.ts';

export const productTestEnv = (env: Readonly<Record<string, string>> = {}): Record<string, string> => {
  const bin = fakeSecretProgramsBin();
  const built = { ...env, PATH: `${bin}${path.delimiter}${env['PATH'] ?? MINIMAL_CHILD_PATH}`, BROWSER: fakeBrowserOf(bin), [LOCK_PROOF_ENV]: lockProofFolder() };
  assertFakeSecretStoreEnv(built, 'a product process');
  return built;
};
