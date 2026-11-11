import { createDecipheriv } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import {
  CREDENTIAL_KEY_LOCK_NAME,
  CREDENTIAL_KEY_MARKER_FILE,
  CREDENTIAL_KEY_PREFIX,
  CredentialStoreError,
  OperationLimitError,
  SECURITY_BINARY,
  SecretStoreAbsentError,
  SecretStoreAnswerError,
  StoreCallEndedError,
  createEncryptedCredentialStore,
  createFileCredentialStore,
  createKeychainSecretStore,
  createMemoryCredentialStore,
  inspectProcessLock,
} from '@momonga/foundation';
import type { CredentialEntry, CredentialStore, Random, SecretStore } from '@momonga/foundation';
import { KEYCHAIN_BACKEND } from '@momonga/foundation/secret-store';
import type { SecretBackend } from '@momonga/foundation/secret-store';
import { REAL_PROCESS_TEST_TIMEOUT_MS, createFakeSecretFiles, createFakeSecurityPort, startLockHolder, waitFor } from '@momonga/testkit';
import type { FakeControl, FakeSecurityPort } from '@momonga/testkit';
import type { ScopedOperations } from '../src/credential-store.ts';
import { DEFAULT_LOCK_TIMEOUT_MS } from '../src/file-lock.ts';
import { FAKE_KEY_STORE_ADVICE, createFakeKeyStore, recordFileOf, recordLockOf, steppedPorts } from './support/credential-key-fakes.ts';
import type { FakeKeyStore } from './support/credential-key-fakes.ts';
import { KEYCHAIN_PATH, R_ND, R_PATH, fakeLimit, noStoreRefusal } from './support/secret-store-fakes.ts';
import { makeTemporaryDirectory as makeDir } from './support/temporary-directory.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const FORMAT = 'momonga-credential/1';

const SIGNAL = new AbortController().signal;

type Setup = { directory: string; stateDirectory: string; keys: FakeKeyStore; plaintext: { value: boolean } };

const setup = (keys: FakeKeyStore = createFakeKeyStore()): Setup => {
  const home = makeDir();
  return { directory: path.join(home, 'state', 'plan-sessions'), stateDirectory: path.join(home, 'state'), keys, plaintext: { value: false } };
};

const storeOf = (given: Setup, options: { noSecretStore?: string; secretStore?: SecretStore; ports?: ReturnType<typeof steppedPorts> } = {}): CredentialStore =>
  createEncryptedCredentialStore({
    directory: given.directory,
    stateDirectory: given.stateDirectory,
    secretStore: options.noSecretStore === undefined ? { kind: 'available', store: options.secretStore ?? given.keys } : { kind: 'none', reason: options.noSecretStore },
    plaintextTokenFiles: () => given.plaintext.value,
    ...(options.ports === undefined ? {} : { ports: options.ports }),
  });

const createdKeyNames = (keys: FakeKeyStore): string[] => keys.writes.filter((name) => name.startsWith('credential-key-'));

const decrypt = (envelope: Record<string, string>, keyHex: string, storeKey: string): string => {
  const decipher = createDecipheriv('aes-256-gcm', Buffer.from(keyHex, 'hex'), Buffer.from(envelope['nonce'] as string, 'hex'));
  decipher.setAAD(Buffer.concat([Buffer.from(FORMAT, 'utf8'), Buffer.from([0]), Buffer.from(storeKey, 'utf8')]));
  decipher.setAuthTag(Buffer.from(envelope['tag'] as string, 'hex'));
  return Buffer.concat([decipher.update(Buffer.from(envelope['ciphertext'] as string, 'hex')), decipher.final()]).toString('utf8');
};

type KeychainKeys = { store: SecretStore; port: FakeSecurityPort; items: Map<string, string>; control: FakeControl };

const keychainKeys = (): KeychainKeys => {
  const items = new Map<string, string>();
  const port = createFakeSecurityPort(
    () => Object.fromEntries(items),
    (name, value) => void items.set(name, value),
    { control: () => keys.control },
  );
  const keys: KeychainKeys = {
    store: createKeychainSecretStore(port, SECURITY_BINARY, createFakeSecretFiles(() => new Set([KEYCHAIN_PATH]))),
    port,
    items,
    control: { readiness: 'ready', calls: 'answer' },
  };
  return keys;
};

const markerOf = (given: Setup): string => path.join(given.stateDirectory, CREDENTIAL_KEY_MARKER_FILE);

const keyLockOf = (given: Setup): string => path.join(given.stateDirectory, CREDENTIAL_KEY_LOCK_NAME);

const expectAbsentCause = (error: unknown, reason: string, backend: SecretBackend | undefined): void => {
  const cause = (error as CredentialStoreError).cause;
  expect((cause as Error).name).toBe('SecretStoreAbsentError');
  expect(cause).toBeInstanceOf(SecretStoreAbsentError);
  expect((cause as SecretStoreAbsentError).reason).toBe(reason);
  expect((cause as SecretStoreAbsentError).backend).toBe(backend);
  expect((cause as SecretStoreAbsentError).call).toBeUndefined();
  expect((cause as Error).message).not.toContain('credential-key-');
};

const rejection = async (attempt: Promise<unknown>): Promise<unknown> => {
  try {
    await attempt;
  } catch (error) {
    return error;
  }
  throw new Error('expected the operation to be refused');
};

describe('encrypted credential store: the four operations of the one CredentialStore (N81)', () => {
  it('reads undefined for a missing key, then what was written, then the update, then undefined after removal', async () => {
    const store = storeOf(setup());
    expect(await store.read('plan/p/a', SIGNAL)).toBeUndefined();
    await store.write('plan/p/a', 'one', SIGNAL);
    expect(await store.read('plan/p/a', SIGNAL)).toBe('one');
    await store.update('plan/p/a', (current) => `${current}-two`, SIGNAL);
    expect(await store.read('plan/p/a', SIGNAL)).toBe('one-two');
    await store.remove('plan/p/a', SIGNAL);
    expect(await store.read('plan/p/a', SIGNAL)).toBeUndefined();
  });

  it('writes one AES-256-GCM envelope, mode 0600, whose AAD is the format, a NUL byte and the store key', async () => {
    const given = setup();
    await storeOf(given).write('plan/p/a', 'access-token-value', SIGNAL);
    const file = recordFileOf(given.directory, 'plan/p/a');
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    const text = fs.readFileSync(file, 'utf8');
    expect(text).not.toContain('access-token-value');
    const envelope = JSON.parse(text) as Record<string, string>;
    expect(Object.keys(envelope).sort()).toEqual(['ciphertext', 'format', 'key', 'nonce', 'tag']);
    expect(envelope['format']).toBe(FORMAT);
    expect(envelope['key']).toBe('plan/p/a');
    const [name] = createdKeyNames(given.keys);
    expect(name).toMatch(/^credential-key-[0-9a-f]{16}$/);
    const keyHex = given.keys.items.get(name as string) as string;
    expect(keyHex).toMatch(/^[0-9a-f]{64}$/);
    expect(decrypt(envelope, keyHex, 'plan/p/a')).toBe('access-token-value');
    expect(() => decrypt(envelope, keyHex, 'plan/p/b')).toThrow();
  });

  it('refuses a record moved to another key as store_unreadable', async () => {
    const given = setup();
    const store = storeOf(given);
    await store.write('plan/p/a', 'token-a', SIGNAL);
    await store.write('plan/p/b', 'token-b', SIGNAL);
    fs.copyFileSync(recordFileOf(given.directory, 'plan/p/a'), recordFileOf(given.directory, 'plan/p/b'));
    const error = await rejection(store.read('plan/p/b', SIGNAL));
    expect(error).toBeInstanceOf(CredentialStoreError);
    expect((error as CredentialStoreError).code).toBe('store_unreadable');
  });

  it('creates one key, names it in the marker under the state directory, and reuses it for every later record', async () => {
    const given = setup();
    const store = storeOf(given);
    await store.write('plan/p/a', '1', SIGNAL);
    await store.write('plan/p/b', '2', SIGNAL);
    await storeOf(given).write('mcp/server', '3', SIGNAL);
    expect(createdKeyNames(given.keys)).toHaveLength(1);
    expect(fs.existsSync(path.join(given.stateDirectory, CREDENTIAL_KEY_MARKER_FILE))).toBe(true);
    expect(fs.readFileSync(path.join(given.stateDirectory, CREDENTIAL_KEY_MARKER_FILE), 'utf8')).toContain(createdKeyNames(given.keys)[0] as string);
  });

  it('creates no key on a read', async () => {
    const given = setup();
    expect(await storeOf(given).read('plan/p/a', SIGNAL)).toBeUndefined();
    expect(given.keys.writes).toEqual([]);
    expect(fs.existsSync(path.join(given.stateDirectory, CREDENTIAL_KEY_MARKER_FILE))).toBe(false);
  });
});

describe('encrypted credential store: key creation by concurrent writers (N81, CredentialKey MarkerWrittenOnce)', () => {
  it('two stores writing at once create exactly one key and both records decrypt with it', async () => {
    const given = setup();
    const first = storeOf(given);
    const second = storeOf(given);
    await Promise.all([first.write('plan/p/a', 'from-first', SIGNAL), second.write('plan/p/b', 'from-second', SIGNAL)]);
    expect(createdKeyNames(given.keys)).toHaveLength(1);
    expect(await second.read('plan/p/a', SIGNAL)).toBe('from-first');
    expect(await first.read('plan/p/b', SIGNAL)).toBe('from-second');
  });
});

describe('encrypted credential store: a marker whose key cannot be read (N81, UnreadableNeverRecreates)', () => {
  const withLostKey = async (): Promise<{ given: Setup; markerText: string }> => {
    const given = setup();
    await storeOf(given).write('plan/p/a', 'token', SIGNAL);
    for (const name of createdKeyNames(given.keys)) given.keys.items.delete(name);
    return { given, markerText: fs.readFileSync(path.join(given.stateDirectory, CREDENTIAL_KEY_MARKER_FILE), 'utf8') };
  };

  it('read is store_unreadable with the cause, and no key is created', async () => {
    const { given, markerText } = await withLostKey();
    const error = await rejection(storeOf(given).read('plan/p/a', SIGNAL));
    expect(error).toBeInstanceOf(CredentialStoreError);
    expect((error as CredentialStoreError).code).toBe('store_unreadable');
    expect((error as CredentialStoreError).cause).toBeInstanceOf(Error);
    expect(createdKeyNames(given.keys)).toHaveLength(1);
    expect(fs.readFileSync(path.join(given.stateDirectory, CREDENTIAL_KEY_MARKER_FILE), 'utf8')).toBe(markerText);
  });

  it('write is store_unwritable with the cause, no key is created and the record is left as it was', async () => {
    const { given, markerText } = await withLostKey();
    const before = fs.readFileSync(recordFileOf(given.directory, 'plan/p/a'), 'utf8');
    const error = await rejection(storeOf(given).write('plan/p/a', 'replacement', SIGNAL));
    expect(error).toBeInstanceOf(CredentialStoreError);
    expect((error as CredentialStoreError).code).toBe('store_unwritable');
    expect((error as CredentialStoreError).cause).toBeInstanceOf(Error);
    expect(createdKeyNames(given.keys)).toHaveLength(1);
    expect(fs.readFileSync(path.join(given.stateDirectory, CREDENTIAL_KEY_MARKER_FILE), 'utf8')).toBe(markerText);
    expect(fs.readFileSync(recordFileOf(given.directory, 'plan/p/a'), 'utf8')).toBe(before);
  });

  it('after a crash between the OS-store write and the marker, the next writer creates a key of its own and never reads the orphan', async () => {
    const orphan = `${CREDENTIAL_KEY_PREFIX}${'0'.repeat(16)}`;
    const given = setup(createFakeKeyStore({ [orphan]: Buffer.alloc(32, 1).toString('hex') }));
    const store = storeOf(given);
    await store.write('plan/p/a', 'token', SIGNAL);
    expect(createdKeyNames(given.keys)).toHaveLength(1);
    expect(createdKeyNames(given.keys)[0]).not.toBe(orphan);
    expect(given.keys.reads).not.toContain(orphan);
    expect(await store.read('plan/p/a', SIGNAL)).toBe('token');
  });
});

describe('encrypted credential store: a record not in the envelope form (N81)', () => {
  it('is store_unreadable with the exact text naming the file', async () => {
    const given = setup();
    await createFileCredentialStore(given.directory).write('plan/p/a', '{"access_token":"plain"}', SIGNAL);
    const error = await rejection(storeOf(given).read('plan/p/a', SIGNAL));
    const file = recordFileOf(given.directory, 'plan/p/a');
    expect(error).toBeInstanceOf(CredentialStoreError);
    expect((error as CredentialStoreError).code).toBe('store_unreadable');
    expect((error as Error).message).toBe(
      `The credential file ${file} is not encrypted. Delete it and sign in again, or set credentials.plaintextTokenFiles to true to keep using it.`,
    );
    expect(given.keys.writes).toEqual([]);
  });
});

describe('encrypted credential store: credentials.plaintextTokenFiles, read at each operation (N81, R06-76)', () => {
  it('writes and reads plaintext 0600 records while true, with no key created', async () => {
    const given = setup();
    given.plaintext.value = true;
    const store = storeOf(given);
    await store.write('plan/p/a', 'plain-token', SIGNAL);
    const file = recordFileOf(given.directory, 'plan/p/a');
    expect(fs.readFileSync(file, 'utf8')).toBe('plain-token');
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(await store.read('plan/p/a', SIGNAL)).toBe('plain-token');
    expect(given.keys.writes).toEqual([]);
  });

  it('a change of the setting takes effect at the next operation of the same store', async () => {
    const given = setup();
    const store = storeOf(given);
    given.plaintext.value = true;
    await store.write('plan/p/a', 'plain-token', SIGNAL);
    given.plaintext.value = false;
    const refused = await rejection(store.read('plan/p/a', SIGNAL));
    expect((refused as CredentialStoreError).code).toBe('store_unreadable');
    await store.write('plan/p/b', 'sealed-token', SIGNAL);
    expect(JSON.parse(fs.readFileSync(recordFileOf(given.directory, 'plan/p/b'), 'utf8')).format).toBe(FORMAT);
    given.plaintext.value = true;
    expect(await store.read('plan/p/a', SIGNAL)).toBe('plain-token');
  });
});

describe('encrypted credential store: no OS secret store on the host (N81, NoPlaintextUnlessOptIn)', () => {
  const reason = 'security (Keychain) is not on PATH';

  it('refuses a write with the exact text and writes no file', async () => {
    const given = setup();
    const error = await rejection(storeOf(given, { noSecretStore: reason }).write('plan/p/a', 'token', SIGNAL));
    expect(error).toBeInstanceOf(CredentialStoreError);
    expect((error as CredentialStoreError).code).toBe('store_unwritable');
    expect((error as Error).message).toBe(
      `No secret store was found on this host (${reason}). MomongaCode does not keep sign-in tokens in a plain file unless you ask: set credentials.plaintextTokenFiles to true in your user settings to keep them in a file only you can read.`,
    );
    expectAbsentCause(error, reason, undefined);
    expect(fs.existsSync(given.directory) ? fs.readdirSync(given.directory) : []).toEqual([]);
    expect(fs.existsSync(path.join(given.stateDirectory, CREDENTIAL_KEY_MARKER_FILE))).toBe(false);
  });

  it.for(['read', 'write'] as const)('no OS store on PATH has the same cause class (%s)', async (action) => {
    const given = setup();
    await storeOf(given).write('plan/p/a', 'token', SIGNAL);
    const store = storeOf(given, { noSecretStore: R_PATH });
    const error = await rejection(action === 'read' ? store.read('plan/p/a', SIGNAL) : store.write('plan/p/a', 'replacement', SIGNAL));
    expect(error).toBeInstanceOf(CredentialStoreError);
    expect((error as CredentialStoreError).code).toBe(action === 'read' ? 'store_unreadable' : 'store_unwritable');
    expect((error as Error).message).toBe(noStoreRefusal(R_PATH));
    expectAbsentCause(error, R_PATH, undefined);
    expect(await storeOf(given).read('plan/p/a', SIGNAL)).toBe('token');
  });

  it('writes plaintext only when the user has set credentials.plaintextTokenFiles', async () => {
    const given = setup();
    given.plaintext.value = true;
    const store = storeOf(given, { noSecretStore: reason });
    await store.write('plan/p/a', 'plain-token', SIGNAL);
    expect(await store.read('plan/p/a', SIGNAL)).toBe('plain-token');
  });
});

describe('encrypted credential store: waits use the signal of the operation (N81)', () => {
  it('a writer waiting on credential-key.lock keeps waiting past any fixed timeout and stops only on its own signal', async (context) => {
    const given = setup();
    fs.mkdirSync(given.stateDirectory, { recursive: true });
    await startLockHolder(context, path.join(given.stateDirectory, CREDENTIAL_KEY_LOCK_NAME));
    const ports = steppedPorts();
    const store = storeOf(given, { ports });
    const controller = new AbortController();
    let settled = false;
    const attempt = store.write('plan/p/a', 'token', controller.signal).finally(() => {
      settled = true;
    });
    attempt.catch(() => undefined);
    await waitFor(() => ports.waitedMs() > 3 * DEFAULT_LOCK_TIMEOUT_MS || settled, { description: 'the writer to wait past three lock timeouts or to end' });
    expect(settled).toBe(false);
    expect(ports.waitedMs()).toBeGreaterThan(3 * DEFAULT_LOCK_TIMEOUT_MS);
    expect(given.keys.writes).toEqual([]);
    const reason = new Error('the sign-in was cancelled');
    controller.abort(reason);
    await expect(attempt).rejects.toBe(reason);
    expect(given.keys.writes).toEqual([]);
    expect(fs.existsSync(recordFileOf(given.directory, 'plan/p/a'))).toBe(false);
  });
});

describe('encrypted credential store: an OS store that is not ready (N81, readiness)', () => {
  const NONE: FakeControl = { readiness: 'none', calls: 'answer' };
  const GARBAGE: FakeControl = { readiness: 'garbage', calls: 'answer' };

  it('an absent store refuses a first save with the no-store text', async () => {
    const given = setup();
    const keychain = keychainKeys();
    keychain.control = NONE;
    const error = await rejection(storeOf(given, { secretStore: keychain.store }).write('plan/p/a', 'token', SIGNAL));
    expect(error).toBeInstanceOf(CredentialStoreError);
    expect((error as CredentialStoreError).code).toBe('store_unwritable');
    expect((error as Error).message).toBe(
      'No secret store was found on this host (security reports no default keychain (SecKeychainCopyDefault: A default keychain could not be found.)). MomongaCode does not keep sign-in tokens in a plain file unless you ask: set credentials.plaintextTokenFiles to true in your user settings to keep them in a file only you can read.',
    );
    expectAbsentCause(error, R_ND, KEYCHAIN_BACKEND);
    expect(keychain.port.calls.map((call) => call.args)).toEqual([['default-keychain']]);
    expect(keychain.items.size).toBe(0);
    expect(fs.existsSync(recordFileOf(given.directory, 'plan/p/a'))).toBe(false);
    expect(fs.existsSync(markerOf(given))).toBe(false);
    expect(await inspectProcessLock(keyLockOf(given))).toEqual({ state: 'free' });
  });

  it('an absent store refuses a read of an encrypted record', async () => {
    const given = setup();
    const keychain = keychainKeys();
    const store = storeOf(given, { secretStore: keychain.store });
    await store.write('plan/p/a', 'token', SIGNAL);
    const markerText = fs.readFileSync(markerOf(given), 'utf8');
    const callsBefore = keychain.port.calls.length;
    keychain.control = NONE;
    const error = await rejection(store.read('plan/p/a', SIGNAL));
    expect(error).toBeInstanceOf(CredentialStoreError);
    expect((error as CredentialStoreError).code).toBe('store_unreadable');
    expect((error as Error).message).toBe(noStoreRefusal(R_ND));
    expectAbsentCause(error, R_ND, KEYCHAIN_BACKEND);
    expect(keychain.port.calls.slice(callsBefore).map((call) => call.args)).toEqual([['default-keychain']]);
    expect(fs.readFileSync(markerOf(given), 'utf8')).toBe(markerText);
    expect(keychain.items.size).toBe(1);
  });

  it('an absent store refuses a save over an encrypted record and leaves the record as it was', async () => {
    const given = setup();
    const keychain = keychainKeys();
    const store = storeOf(given, { secretStore: keychain.store });
    await store.write('plan/p/a', 'token', SIGNAL);
    const before = fs.readFileSync(recordFileOf(given.directory, 'plan/p/a'), 'utf8');
    keychain.control = NONE;
    const error = await rejection(store.write('plan/p/a', 'replacement', SIGNAL));
    expect((error as CredentialStoreError).code).toBe('store_unwritable');
    expect((error as Error).message).toBe(noStoreRefusal(R_ND));
    expectAbsentCause(error, R_ND, KEYCHAIN_BACKEND);
    expect(fs.readFileSync(recordFileOf(given.directory, 'plan/p/a'), 'utf8')).toBe(before);
    expect(keychain.items.size).toBe(1);
  });

  it('plaintextTokenFiles true never calls the store', async () => {
    const given = setup();
    given.plaintext.value = true;
    const keychain = keychainKeys();
    keychain.control = NONE;
    const store = storeOf(given, { secretStore: keychain.store });
    await store.write('plan/p/a', 'plain-token', SIGNAL);
    expect(await store.read('plan/p/a', SIGNAL)).toBe('plain-token');
    expect(keychain.port.calls).toEqual([]);
  });

  it.for(['write', 'read'] as const)('an unknown readiness answer is wrapped as the existing store error (%s)', async (action) => {
    const given = setup();
    const keychain = keychainKeys();
    const store = storeOf(given, { secretStore: keychain.store });
    if (action === 'read') await store.write('plan/p/a', 'token', SIGNAL);
    keychain.control = GARBAGE;
    const error = await rejection(action === 'read' ? store.read('plan/p/a', SIGNAL) : store.write('plan/p/a', 'token', SIGNAL));
    expect(error).toBeInstanceOf(CredentialStoreError);
    expect((error as CredentialStoreError).code).toBe(action === 'read' ? 'store_unreadable' : 'store_unwritable');
    expect((error as Error).message).toBe(
      action === 'read'
        ? `the key of the credential file ${recordFileOf(given.directory, 'plan/p/a')} could not be read: the Keychain readiness answer was not understood (exit 0): garbage`
        : 'the credential key could not be read or created: the Keychain readiness answer was not understood (exit 0): garbage',
    );
    expect(((error as CredentialStoreError).cause as Error).name).toBe('SecretStoreAnswerError');
    expect((error as CredentialStoreError).cause).toBeInstanceOf(SecretStoreAnswerError);
    if (action === 'write') {
      expect(fs.existsSync(markerOf(given))).toBe(false);
      expect(fs.existsSync(recordFileOf(given.directory, 'plan/p/a'))).toBe(false);
      expect(keychain.items.size).toBe(0);
    }
  });
});

describe('encrypted credential store: a store call ended by the limit of the operation (N81, AF-no-unbounded-waits)', () => {
  const expectEndedKeyCall = (error: unknown, action: 'read' | 'write', limitReason: unknown): void => {
    expect((error as Error).name).toBe('StoreCallEndedError');
    expect(error).toBeInstanceOf(StoreCallEndedError);
    expect(error).not.toBeInstanceOf(CredentialStoreError);
    expect((error as StoreCallEndedError).call.action).toBe(action);
    expect((error as StoreCallEndedError).call.name).toBeUndefined();
    expect(limitReason).toBeInstanceOf(OperationLimitError);
    expect((error as StoreCallEndedError).limit).toBe(limitReason);
    expect((error as Error).message).toBe(`the ${action} of the key of the stored credentials did not finish within the MCP connect limit of 1000 ms; ${FAKE_KEY_STORE_ADVICE}`);
    expect((error as Error).message).not.toContain(CREDENTIAL_KEY_PREFIX);
  };

  it.for(['reading a record', 'saving another record'] as const)('a limit ending the key read is not wrapped and hides the key name (%s)', async (operation) => {
    const given = setup();
    const store = storeOf(given);
    await store.write('plan/p/a', 'token', SIGNAL);
    const markerText = fs.readFileSync(markerOf(given), 'utf8');
    const { limit, signal, pass } = fakeLimit(1000, 'the MCP connect limit');
    given.keys.hang = true;
    const attempt = operation === 'reading a record' ? store.read('plan/p/a', signal) : store.write('plan/p/b', 'token-b', signal);
    attempt.catch(() => undefined);
    await waitFor(() => given.keys.hung.length === 1, { description: 'the key read started' });
    expect(given.keys.hung).toEqual([{ action: 'read', name: createdKeyNames(given.keys)[0] }]);
    pass();
    expectEndedKeyCall(await rejection(attempt), 'read', signal.reason);
    limit.dispose();
    expect(fs.readFileSync(markerOf(given), 'utf8')).toBe(markerText);
    expect(fs.existsSync(recordFileOf(given.directory, 'plan/p/b'))).toBe(false);
    expect(await inspectProcessLock(keyLockOf(given))).toEqual({ state: 'free' });
    given.keys.hang = false;
    await storeOf(given).write('plan/p/b', 'token-b', SIGNAL);
    expect(await store.read('plan/p/b', SIGNAL)).toBe('token-b');
    expect(await store.read('plan/p/a', SIGNAL)).toBe('token');
    expect(createdKeyNames(given.keys)).toHaveLength(1);
  });

  it('a limit ending the key write leaves the OS item and no marker', async () => {
    const given = setup();
    const store = storeOf(given);
    const { limit, signal, pass } = fakeLimit(1000, 'the MCP connect limit');
    given.keys.hang = true;
    const attempt = store.write('plan/p/a', 'token', signal);
    attempt.catch(() => undefined);
    await waitFor(() => given.keys.hung.length === 1, { description: 'the key write started' });
    const [orphan] = createdKeyNames(given.keys) as [string];
    expect(given.keys.hung).toEqual([{ action: 'write', name: orphan }]);
    pass();
    expectEndedKeyCall(await rejection(attempt), 'write', signal.reason);
    limit.dispose();
    expect(given.keys.items.has(orphan)).toBe(true);
    expect(fs.existsSync(markerOf(given))).toBe(false);
    expect(fs.existsSync(recordFileOf(given.directory, 'plan/p/a'))).toBe(false);
    expect(await inspectProcessLock(keyLockOf(given))).toEqual({ state: 'free' });
    given.keys.hang = false;
    await storeOf(given).write('plan/p/a', 'token', SIGNAL);
    const names = createdKeyNames(given.keys);
    expect(names).toHaveLength(2);
    expect(names[1]).not.toBe(orphan);
    expect(fs.readFileSync(markerOf(given), 'utf8')).toBe(`${JSON.stringify({ name: names[1] })}\n`);
    expect(given.keys.items.has(orphan)).toBe(true);
    expect(given.keys.reads).not.toContain(orphan);
    expect(await store.read('plan/p/a', SIGNAL)).toBe('token');
  });

  it.for([
    ['a limit ending the key-creation lock wait is bare', 'key'],
    ['a limit ending the record lock wait is bare', 'record'],
  ] as const)('%s', async ([, lock], context) => {
    const given = setup();
    const lockPath = lock === 'key' ? keyLockOf(given) : recordLockOf(given.directory, 'plan/p/a');
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    const holder = await startLockHolder(context, lockPath);
    const ports = steppedPorts();
    const store = storeOf(given, { ports });
    const { limit, signal, pass } = fakeLimit(1000, 'the MCP connect limit');
    const attempt = store.write('plan/p/a', 'token', signal);
    attempt.catch(() => undefined);
    await waitFor(() => ports.waitedMs() > 3 * DEFAULT_LOCK_TIMEOUT_MS, { description: 'the writer has waited for the lock past the fixed timeout' });
    pass();
    const error = await rejection(attempt);
    expect(error).toBeInstanceOf(OperationLimitError);
    expect(error).toBe(signal.reason);
    limit.dispose();
    expect(await inspectProcessLock(lockPath)).toEqual({ state: 'held', pid: holder.pid });
    expect(given.keys.writes).toEqual([]);
    expect(fs.existsSync(recordFileOf(given.directory, 'plan/p/a'))).toBe(false);
    expect(fs.existsSync(markerOf(given))).toBe(false);
  });

  it('an interrupt reason passes by identity', async () => {
    const given = setup();
    const store = storeOf(given);
    await store.write('plan/p/a', 'token', SIGNAL);
    let asked = 0;
    given.keys.read = (_name, signal) =>
      new Promise((_resolve, reject) => {
        asked += 1;
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    const controller = new AbortController();
    const reason = new Error('the sign-in was cancelled');
    const reading = store.read('plan/p/a', controller.signal);
    reading.catch(() => undefined);
    await waitFor(() => asked === 1, { description: 'the key read of the record started' });
    const saving = store.write('plan/p/b', 'token-b', controller.signal);
    saving.catch(() => undefined);
    await waitFor(() => asked === 2, { description: 'the key read of the save started' });
    controller.abort(reason);
    expect(await rejection(reading)).toBe(reason);
    expect(await rejection(saving)).toBe(reason);
    expect(fs.existsSync(recordFileOf(given.directory, 'plan/p/b'))).toBe(false);
  });
});

describe('encrypted credential store: every call carries the signal of its operation (N81)', () => {
  it('signal is required', () => {
    type Action = (entry: CredentialEntry) => Promise<string>;
    type Change = (current: string | undefined) => string;
    type Memory = ReturnType<typeof createMemoryCredentialStore>;
    type File = ReturnType<typeof createFileCredentialStore>;
    type Encrypted = ReturnType<typeof createEncryptedCredentialStore>;
    expectTypeOf<CredentialStore['read']>().parameters.toEqualTypeOf<[key: string, signal: AbortSignal]>();
    expectTypeOf<CredentialStore['write']>().parameters.toEqualTypeOf<[key: string, value: string, signal: AbortSignal]>();
    expectTypeOf<CredentialStore['update']>().parameters.toEqualTypeOf<[key: string, change: Change, signal: AbortSignal]>();
    expectTypeOf<CredentialStore['remove']>().parameters.toEqualTypeOf<[key: string, signal: AbortSignal]>();
    expectTypeOf<CredentialStore['withKey']>().toBeCallableWith('k', (async () => 'value') as Action, new AbortController().signal);
    expectTypeOf<Parameters<CredentialStore['withKey']>[2]>().toEqualTypeOf<AbortSignal>();
    expectTypeOf<ScopedOperations['read']>().parameters.toEqualTypeOf<[key: string, signal: AbortSignal]>();
    expectTypeOf<Parameters<ScopedOperations['withKey']>[2]>().toEqualTypeOf<AbortSignal>();
    expectTypeOf<Memory['read']>().parameters.toEqualTypeOf<[key: string, signal: AbortSignal]>();
    expectTypeOf<Parameters<Memory['withKey']>[2]>().toEqualTypeOf<AbortSignal>();
    expectTypeOf<File['read']>().parameters.toEqualTypeOf<[key: string, signal: AbortSignal]>();
    expectTypeOf<Parameters<File['withKey']>[2]>().toEqualTypeOf<AbortSignal>();
    expectTypeOf<Encrypted['write']>().parameters.toEqualTypeOf<[key: string, value: string, signal: AbortSignal]>();
    expectTypeOf<CredentialEntry['read']>().parameters.toEqualTypeOf<[]>();
  });

  it('no NEVER_ABORTED and no signal fallback on the credential path', () => {
    const source = path.join(import.meta.dirname, '..', 'src');
    for (const file of ['encrypted-credential-store.ts', 'credential-store.ts']) {
      const text = fs.readFileSync(path.join(source, file), 'utf8');
      const offending = text.split('\n').filter((line) => line.includes('NEVER_ABORTED') || /signal\s*\?\?/.test(line));
      expect(offending, file).toEqual([]);
    }
  });
});

describe('O-R5-6 L8: the store takes its random bytes from the injected port', () => {
  it('nonce and key bytes come from the injected random', async () => {
    const given = setup();
    const fill = (length: number): number => ({ 12: 0x11, 32: 0x22, 8: 0x33 })[length] ?? 0x44;
    const requested: number[] = [];
    const random: Random = {
      float: () => 0.5,
      bytes: (length) => {
        requested.push(length);
        return new Uint8Array(length).fill(fill(length));
      },
      hex: (byteLength) => '55'.repeat(byteLength),
      uuid: () => '00000000-0000-4000-8000-000000000000',
    };
    const store = createEncryptedCredentialStore({
      directory: given.directory,
      stateDirectory: given.stateDirectory,
      secretStore: { kind: 'available', store: given.keys },
      plaintextTokenFiles: () => false,
      random,
    } as Parameters<typeof createEncryptedCredentialStore>[0]);
    await store.write('plan/chatgpt/work', 'the record', SIGNAL);
    const envelope = JSON.parse(fs.readFileSync(recordFileOf(given.directory, 'plan/chatgpt/work'), 'utf8')) as Record<string, string>;
    expect(envelope['nonce']).toBe('11'.repeat(12));
    expect(createdKeyNames(given.keys)).toEqual([`${CREDENTIAL_KEY_PREFIX}${'33'.repeat(8)}`]);
    expect(decrypt(envelope, '22'.repeat(32), 'plan/chatgpt/work')).toBe('the record');
    expect([...requested].sort((a, b) => a - b)).toEqual([8, 12, 32]);
  });
});
