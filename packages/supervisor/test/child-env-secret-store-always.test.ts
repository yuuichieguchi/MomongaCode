import { secretStoreEnvFor } from '@momonga/foundation';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SECRET_BACKEND_ENV, SECRET_PROGRAM_ENV } from '@momonga/foundation';
import { withTempDir } from '@momonga/testkit';
import { gatewayEnv } from '../src/child-env.ts';
import type { CredentialSettings } from '../src/child-env.ts';
import { HOST_SECRET_STORE as STORE } from './support/host-secret-store.ts';

const HOST = { platform: process.platform, uid: process.getuid?.(), realPathOf: (file: string) => fs.realpathSync(file) };

const binWith = (dir: string, program: string): string => {
  const real = fs.realpathSync.native(dir);
  fs.writeFileSync(path.join(real, program), '#!/bin/sh\nexit 97\n', { mode: 0o755 });
  return real;
};

const SETTINGS_WITHOUT_SECRETS: readonly { label: string; settings: CredentialSettings }[] = [
  { label: 'no connection at all', settings: { models: { connections: [] } } as unknown as CredentialSettings },
  {
    label: 'only a connection with apiKeyEnv',
    settings: { models: { connections: [{ adapter: 'chat-completions', provider: 'fake', apiKeyEnv: 'UPSTREAM_X' }] } } as unknown as CredentialSettings,
  },
];

describe('the gateway spawn environment does not depend on the settings: the secret-store location is always handed (design-settings-live 3.3)', () => {
  for (const { label, settings } of SETTINGS_WITHOUT_SECRETS) {
    it(`hands the secret-store location when the settings declare no apiKeySecret (${label})`, async (context) => {
      const bin = binWith(withTempDir(context), STORE.program);
      const env = gatewayEnv({ PATH: bin, HOME: '/home/u' }, settings, '/home/u', await secretStoreEnvFor({ PATH: bin, HOME: '/home/u', ...STORE.env }, HOST));
      expect(env[SECRET_BACKEND_ENV]).toBe(STORE.backend);
      expect(env[SECRET_PROGRAM_ENV]).toBe(path.join(bin, STORE.program));
    });
  }
});
