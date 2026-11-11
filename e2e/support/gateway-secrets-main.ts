import fs from 'node:fs';
import path from 'node:path';
import { SECURITY_BINARY, createKeychainSecretStore, nodeEntryIo, parseFlags } from '@momonga/foundation';
import { GATEWAY_ENTRY_FLAGS, runGatewayEntry } from '@momonga/gateway';
import { FAKE_KEYCHAIN_PATH, createFakeSecretFiles, createFakeSecurityPort } from '@momonga/testkit';
import { SUPERVISOR_APP_VERSION } from './app-version.ts';

export const E2E_SECRETS_FILE_NAME = 'e2e-secrets.json';

const secretsFileOf = (argv: readonly string[]): string => {
  const { home } = parseFlags(argv, GATEWAY_ENTRY_FLAGS);
  if (home === undefined) throw new Error('--home is required');
  return path.join(home, E2E_SECRETS_FILE_NAME);
};

const readSecrets = (file: string): Record<string, string> => {
  const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error(`${file} must hold a JSON object`);
  return Object.fromEntries(
    Object.entries(parsed).map(([name, value]) => {
      if (typeof value !== 'string') throw new Error(`${file}: secret ${name} must be a string`);
      return [name, value];
    }),
  );
};

if (import.meta.main) {
  const file = secretsFileOf(process.argv.slice(2));
  void runGatewayEntry(nodeEntryIo(), { version: SUPERVISOR_APP_VERSION, secretStore: createKeychainSecretStore(createFakeSecurityPort(() => readSecrets(file)), SECURITY_BINARY, createFakeSecretFiles(() => new Set([FAKE_KEYCHAIN_PATH]))) });
}
