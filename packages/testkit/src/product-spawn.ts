import path from 'node:path';
import { MINIMAL_CHILD_PATH } from '@momonga/foundation';
import { fakeBrowserOf } from './fake-programs.ts';
import { assertFakeSecretStoreEnv, fakeSecretProgramsBin } from './secret-store-env-check.ts';
import { LOCK_PROOF_ENV, lockProofFolder } from './test-locks.ts';

export const standInEnv = (base: string = MINIMAL_CHILD_PATH): Record<string, string> => {
  const bin = fakeSecretProgramsBin();
  const fakeBus = path.join(path.dirname(bin), 'session-bus');
  return { PATH: `${bin}${path.delimiter}${base}`, BROWSER: fakeBrowserOf(bin), DBUS_SESSION_BUS_ADDRESS: `unix:path=${fakeBus}` };
};

export const productTestEnv = (env: Readonly<Record<string, string>> = {}): Record<string, string> => {
  const built = { ...env, ...standInEnv(env['PATH'] ?? MINIMAL_CHILD_PATH), [LOCK_PROOF_ENV]: lockProofFolder() };
  assertFakeSecretStoreEnv(built, 'a product process');
  return built;
};
