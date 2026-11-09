import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SECRET_BACKEND_ENV, SECRET_PROGRAM_ENV } from '@momonga/foundation';
import { withTempDir } from '@momonga/testkit';
import { gatewayEnv } from '../src/child-env.ts';
import type { CredentialSettings } from '../src/child-env.ts';

const binWith = (dir: string, program: string): string => {
  const real = fs.realpathSync.native(dir);
  fs.writeFileSync(path.join(real, program), '#!/bin/sh\nexit 97\n', { mode: 0o755 });
  return real;
};

const SETTINGS_WITHOUT_SECRETS: readonly { label: string; settings: CredentialSettings }[] = [
  { label: 'no targets at all', settings: { models: { targets: {} } } as unknown as CredentialSettings },
  {
    label: 'only an apiKeyEnv target',
    settings: { models: { targets: { remote: { adapter: 'chat-completions', provider: 'fake', apiKeyEnv: 'UPSTREAM_X' } } } } as unknown as CredentialSettings,
  },
];

describe('the gateway spawn environment does not depend on the settings: the secret-store location is always handed (design-settings-live 3.3)', () => {
  for (const { label, settings } of SETTINGS_WITHOUT_SECRETS) {
    it(`hands the secret-store location when the settings declare no apiKeySecret (${label})`, (context) => {
      const bin = binWith(withTempDir(context), 'security');
      const env = gatewayEnv({ PATH: bin, HOME: '/home/u' }, settings, '/home/u');
      expect(env[SECRET_BACKEND_ENV]).toBe('keychain');
      expect(env[SECRET_PROGRAM_ENV]).toBe(path.join(bin, 'security'));
    });
  }
});
