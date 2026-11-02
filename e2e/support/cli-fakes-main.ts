import fs from 'node:fs';
import { createKeychainSecretStore } from '@momonga/foundation';
import { createFakeSecurityPort } from '@momonga/testkit';
import packageJson from '../../packages/cli/package.json' with { type: 'json' };
import { runMain } from '../../packages/cli/src/run-main.ts';

export const E2E_OPEN_LOG_ENV = 'MOMONGA_E2E_OPEN_LOG';
export const E2E_SECRETS_FILE_ENV = 'MOMONGA_E2E_SECRETS_FILE';

const required = (name: string): string => {
  const value = process.env[name];
  if (value === undefined) throw new Error(`${name} is not set; the fake port needs it`);
  return value;
};

const readSecrets = (file: string): Record<string, string> => {
  if (!fs.existsSync(file)) return {};
  const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error(`${file} must hold a JSON object`);
  return Object.fromEntries(Object.entries(parsed).map(([name, value]) => [name, String(value)]));
};

await runMain(packageJson.version, {
  openUrl: async (url) => {
    fs.appendFileSync(required(E2E_OPEN_LOG_ENV), `${url.href}\n`);
  },
  secretStore: () => {
    const file = required(E2E_SECRETS_FILE_ENV);
    return createKeychainSecretStore(
      createFakeSecurityPort(
        () => readSecrets(file),
        (name, value) => fs.writeFileSync(file, JSON.stringify({ ...readSecrets(file), [name]: value })),
      ),
    );
  },
});
