import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  CREDENTIAL_KEY_MARKER_FILE,
  CredentialStoreError,
  SECRET_TOOL_BINARY,
  SECURITY_BINARY,
  SecretUnavailableError,
  createEncryptedCredentialStore,
  createKeychainSecretStore,
  createSecretServiceStore,
} from '@momonga/foundation';
import type { CredentialStore, SecretProcessPort, SecretStore } from '@momonga/foundation';
import { SecretNotFoundError } from '@momonga/foundation/secret-store';
import { REAL_PROCESS_TEST_TIMEOUT_MS, createFakeSecretFiles, createFakeSecurityPort, testKernelLock } from '@momonga/testkit';
import { KEYCHAIN_PATH } from './support/secret-store-fakes.ts';
import { makeTemporaryDirectory as makeDir } from './support/temporary-directory.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const SIGNAL = new AbortController().signal;
const STORE_COMMAND_TEXT = 'add-generic-password';

type Keychain = { store: SecretStore; items: Map<string, string> };

const keychain = (): Keychain => {
  const items = new Map<string, string>();
  const port = createFakeSecurityPort(
    () => Object.fromEntries(items),
    (name, value) => void items.set(name, value),
  );
  return { store: createKeychainSecretStore(port, SECURITY_BINARY, createFakeSecretFiles(() => new Set([KEYCHAIN_PATH]))), items };
};

type Home = { directory: string; stateDirectory: string; marker: string };

const home = (): Home => {
  const root = makeDir();
  const stateDirectory = path.join(root, 'state');
  return { directory: path.join(stateDirectory, 'plan-sessions'), stateDirectory, marker: path.join(stateDirectory, CREDENTIAL_KEY_MARKER_FILE) };
};

const storeOver = (given: Home, secretStore: SecretStore): CredentialStore =>
  createEncryptedCredentialStore({
    lock: testKernelLock(),
    directory: given.directory,
    stateDirectory: given.stateDirectory,
    secretStore: { kind: 'available', store: secretStore },
    plaintextTokenFiles: () => false,
  });

const rejection = async (attempt: Promise<unknown>): Promise<unknown> =>
  attempt.then(
    () => {
      throw new Error('expected the operation to be refused');
    },
    (error: unknown) => error,
  );

const markerName = (given: Home): string => (JSON.parse(fs.readFileSync(given.marker, 'utf8')) as { name: string }).name;

describe('a credential key whose OS item is gone', () => {
  it('creates a new key on the next save, rewrites the marker, and the save succeeds', async () => {
    const given = home();
    const keys = keychain();
    const store = storeOver(given, keys.store);
    await store.write('plan/p/a', 'one', SIGNAL);
    const lost = markerName(given);
    keys.items.delete(lost);

    await store.write('plan/p/b', 'two', SIGNAL);

    expect(markerName(given)).not.toBe(lost);
    expect(keys.items.has(markerName(given))).toBe(true);
    expect(await store.read('plan/p/b', SIGNAL)).toBe('two');
  });

  it('reads a record sealed under the lost key as store_unreadable with a text that says the key is gone', async () => {
    const given = home();
    const keys = keychain();
    const store = storeOver(given, keys.store);
    await store.write('plan/p/a', 'one', SIGNAL);
    keys.items.delete(markerName(given));

    const error = await rejection(store.read('plan/p/a', SIGNAL));

    expect(error).toBeInstanceOf(CredentialStoreError);
    expect((error as CredentialStoreError).code).toBe('store_unreadable');
    expect((error as Error).message).toMatch(/is no longer in the Keychain/);
    expect((error as Error).message).not.toContain(STORE_COMMAND_TEXT);
  });

  it('never creates a key while the store is unavailable, and leaves the marker as it was', async () => {
    const given = home();
    const keys = keychain();
    await storeOver(given, keys.store).write('plan/p/a', 'one', SIGNAL);
    const before = fs.readFileSync(given.marker, 'utf8');
    const writes: string[] = [];
    const unavailable: SecretStore = {
      read: async (name) => {
        throw new SecretUnavailableError(name, 36, 'User interaction is not allowed.');
      },
      write: async (name) => {
        writes.push(name);
      },
    };

    const error = await rejection(storeOver(given, unavailable).write('plan/p/b', 'two', SIGNAL));

    expect((error as CredentialStoreError).code).toBe('store_unwritable');
    expect((error as Error).message).not.toContain(STORE_COMMAND_TEXT);
    expect(writes).toEqual([]);
    expect(fs.readFileSync(given.marker, 'utf8')).toBe(before);
  });
});

describe('the secret store answers a read with a value, a positive not found, or unavailable', () => {
  const answering =
    (exitCode: number, stderr: string): SecretProcessPort =>
    async () => ({ exitCode, stdout: '', stderr });

  it('reads the Keychain exit 44 as not found', async () => {
    const store = createKeychainSecretStore(createFakeSecurityPort(() => ({})), SECURITY_BINARY, createFakeSecretFiles(() => new Set([KEYCHAIN_PATH])));
    expect(await rejection(store.read('missing', SIGNAL))).toBeInstanceOf(SecretNotFoundError);
  });

  it('reads a silent secret-tool exit 1 as not found, and exit 1 with a message as unavailable', async () => {
    const silent = await rejection(createSecretServiceStore(answering(1, ''), SECRET_TOOL_BINARY, createFakeSecretFiles(() => new Set())).read('missing', SIGNAL));
    const said = await rejection(createSecretServiceStore(answering(1, 'Cannot autolaunch D-Bus'), SECRET_TOOL_BINARY, createFakeSecretFiles(() => new Set())).read('missing', SIGNAL));
    expect(silent).toBeInstanceOf(SecretNotFoundError);
    expect(said).toBeInstanceOf(SecretUnavailableError);
    expect(said).not.toBeInstanceOf(SecretNotFoundError);
  });
});
