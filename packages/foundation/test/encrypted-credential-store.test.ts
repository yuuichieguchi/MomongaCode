import { createDecipheriv } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  CREDENTIAL_KEY_LOCK_NAME,
  CREDENTIAL_KEY_MARKER_FILE,
  CREDENTIAL_KEY_PREFIX,
  CredentialStoreError,
  DEFAULT_LOCK_TIMEOUT_MS,
  createEncryptedCredentialStore,
  createFileCredentialStore,
} from '@momonga/foundation';
import type { CredentialStore, Random } from '@momonga/foundation';
import { REAL_PROCESS_TEST_TIMEOUT_MS, startLockHolder } from '@momonga/testkit';
import { createFakeKeyStore, recordFileOf, steppedPorts } from './support/credential-key-fakes.ts';
import type { FakeKeyStore } from './support/credential-key-fakes.ts';
import { makeTemporaryDirectory as makeDir } from './support/temporary-directory.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const FORMAT = 'momonga-credential/1';

type Setup = { directory: string; stateDirectory: string; keys: FakeKeyStore; plaintext: { value: boolean } };

const setup = (keys: FakeKeyStore = createFakeKeyStore()): Setup => {
  const home = makeDir();
  return { directory: path.join(home, 'state', 'plan-sessions'), stateDirectory: path.join(home, 'state'), keys, plaintext: { value: false } };
};

const storeOf = (given: Setup, options: { noSecretStore?: string; ports?: ReturnType<typeof steppedPorts> } = {}): CredentialStore =>
  createEncryptedCredentialStore({
    directory: given.directory,
    stateDirectory: given.stateDirectory,
    secretStore: options.noSecretStore === undefined ? { kind: 'available', store: given.keys } : { kind: 'none', reason: options.noSecretStore },
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
    expect(await store.read('plan/p/a')).toBeUndefined();
    await store.write('plan/p/a', 'one');
    expect(await store.read('plan/p/a')).toBe('one');
    await store.update('plan/p/a', (current) => `${current}-two`);
    expect(await store.read('plan/p/a')).toBe('one-two');
    await store.remove('plan/p/a');
    expect(await store.read('plan/p/a')).toBeUndefined();
  });

  it('writes one AES-256-GCM envelope, mode 0600, whose AAD is the format, a NUL byte and the store key', async () => {
    const given = setup();
    await storeOf(given).write('plan/p/a', 'access-token-value');
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
    await store.write('plan/p/a', 'token-a');
    await store.write('plan/p/b', 'token-b');
    fs.copyFileSync(recordFileOf(given.directory, 'plan/p/a'), recordFileOf(given.directory, 'plan/p/b'));
    const error = await rejection(store.read('plan/p/b'));
    expect(error).toBeInstanceOf(CredentialStoreError);
    expect((error as CredentialStoreError).code).toBe('store_unreadable');
  });

  it('creates one key, names it in the marker under the state directory, and reuses it for every later record', async () => {
    const given = setup();
    const store = storeOf(given);
    await store.write('plan/p/a', '1');
    await store.write('plan/p/b', '2');
    await storeOf(given).write('mcp/server', '3');
    expect(createdKeyNames(given.keys)).toHaveLength(1);
    expect(fs.existsSync(path.join(given.stateDirectory, CREDENTIAL_KEY_MARKER_FILE))).toBe(true);
    expect(fs.readFileSync(path.join(given.stateDirectory, CREDENTIAL_KEY_MARKER_FILE), 'utf8')).toContain(createdKeyNames(given.keys)[0] as string);
  });

  it('creates no key on a read', async () => {
    const given = setup();
    expect(await storeOf(given).read('plan/p/a')).toBeUndefined();
    expect(given.keys.writes).toEqual([]);
    expect(fs.existsSync(path.join(given.stateDirectory, CREDENTIAL_KEY_MARKER_FILE))).toBe(false);
  });
});

describe('encrypted credential store: key creation by concurrent writers (N81, CredentialKey MarkerWrittenOnce)', () => {
  it('two stores writing at once create exactly one key and both records decrypt with it', async () => {
    const given = setup();
    const first = storeOf(given);
    const second = storeOf(given);
    await Promise.all([first.write('plan/p/a', 'from-first'), second.write('plan/p/b', 'from-second')]);
    expect(createdKeyNames(given.keys)).toHaveLength(1);
    expect(await second.read('plan/p/a')).toBe('from-first');
    expect(await first.read('plan/p/b')).toBe('from-second');
  });
});

describe('encrypted credential store: a marker whose key cannot be read (N81, UnreadableNeverRecreates)', () => {
  const withLostKey = async (): Promise<{ given: Setup; markerText: string }> => {
    const given = setup();
    await storeOf(given).write('plan/p/a', 'token');
    for (const name of createdKeyNames(given.keys)) given.keys.items.delete(name);
    return { given, markerText: fs.readFileSync(path.join(given.stateDirectory, CREDENTIAL_KEY_MARKER_FILE), 'utf8') };
  };

  it('read is store_unreadable with the cause, and no key is created', async () => {
    const { given, markerText } = await withLostKey();
    const error = await rejection(storeOf(given).read('plan/p/a'));
    expect(error).toBeInstanceOf(CredentialStoreError);
    expect((error as CredentialStoreError).code).toBe('store_unreadable');
    expect((error as CredentialStoreError).cause).toBeInstanceOf(Error);
    expect(createdKeyNames(given.keys)).toHaveLength(1);
    expect(fs.readFileSync(path.join(given.stateDirectory, CREDENTIAL_KEY_MARKER_FILE), 'utf8')).toBe(markerText);
  });

  it('write is store_unwritable with the cause, no key is created and the record is left as it was', async () => {
    const { given, markerText } = await withLostKey();
    const before = fs.readFileSync(recordFileOf(given.directory, 'plan/p/a'), 'utf8');
    const error = await rejection(storeOf(given).write('plan/p/a', 'replacement'));
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
    await store.write('plan/p/a', 'token');
    expect(createdKeyNames(given.keys)).toHaveLength(1);
    expect(createdKeyNames(given.keys)[0]).not.toBe(orphan);
    expect(given.keys.reads).not.toContain(orphan);
    expect(await store.read('plan/p/a')).toBe('token');
  });
});

describe('encrypted credential store: a record not in the envelope form (N81)', () => {
  it('is store_unreadable with the exact text naming the file', async () => {
    const given = setup();
    await createFileCredentialStore(given.directory).write('plan/p/a', '{"access_token":"plain"}');
    const error = await rejection(storeOf(given).read('plan/p/a'));
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
    await store.write('plan/p/a', 'plain-token');
    const file = recordFileOf(given.directory, 'plan/p/a');
    expect(fs.readFileSync(file, 'utf8')).toBe('plain-token');
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(await store.read('plan/p/a')).toBe('plain-token');
    expect(given.keys.writes).toEqual([]);
  });

  it('a change of the setting takes effect at the next operation of the same store', async () => {
    const given = setup();
    const store = storeOf(given);
    given.plaintext.value = true;
    await store.write('plan/p/a', 'plain-token');
    given.plaintext.value = false;
    const refused = await rejection(store.read('plan/p/a'));
    expect((refused as CredentialStoreError).code).toBe('store_unreadable');
    await store.write('plan/p/b', 'sealed-token');
    expect(JSON.parse(fs.readFileSync(recordFileOf(given.directory, 'plan/p/b'), 'utf8')).format).toBe(FORMAT);
    given.plaintext.value = true;
    expect(await store.read('plan/p/a')).toBe('plain-token');
  });
});

describe('encrypted credential store: no OS secret store on the host (N81, NoPlaintextUnlessOptIn)', () => {
  const reason = 'security (Keychain) is not on PATH';

  it('refuses a write with the exact text and writes no file', async () => {
    const given = setup();
    const error = await rejection(storeOf(given, { noSecretStore: reason }).write('plan/p/a', 'token'));
    expect(error).toBeInstanceOf(CredentialStoreError);
    expect((error as CredentialStoreError).code).toBe('store_unwritable');
    expect((error as Error).message).toBe(
      `No secret store was found on this host (${reason}). MomongaCode does not keep sign-in tokens in a plain file unless you ask: set credentials.plaintextTokenFiles to true in your user settings to keep them in a file only you can read.`,
    );
    expect(fs.existsSync(given.directory) ? fs.readdirSync(given.directory) : []).toEqual([]);
    expect(fs.existsSync(path.join(given.stateDirectory, CREDENTIAL_KEY_MARKER_FILE))).toBe(false);
  });

  it('writes plaintext only when the user has set credentials.plaintextTokenFiles', async () => {
    const given = setup();
    given.plaintext.value = true;
    const store = storeOf(given, { noSecretStore: reason });
    await store.write('plan/p/a', 'plain-token');
    expect(await store.read('plan/p/a')).toBe('plain-token');
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
    for (let turn = 0; turn < 100_000 && ports.waitedMs() <= 3 * DEFAULT_LOCK_TIMEOUT_MS && !settled; turn += 1) await new Promise((resolve) => setImmediate(resolve));
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
    await store.write('plan/chatgpt/work', 'the record');
    const envelope = JSON.parse(fs.readFileSync(recordFileOf(given.directory, 'plan/chatgpt/work'), 'utf8')) as Record<string, string>;
    expect(envelope['nonce']).toBe('11'.repeat(12));
    expect(createdKeyNames(given.keys)).toEqual([`${CREDENTIAL_KEY_PREFIX}${'33'.repeat(8)}`]);
    expect(decrypt(envelope, '22'.repeat(32), 'plan/chatgpt/work')).toBe('the record');
    expect([...requested].sort((a, b) => a - b)).toEqual([8, 12, 32]);
  });
});
