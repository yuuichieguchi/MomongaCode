import type { webcrypto } from 'node:crypto';
import path from 'node:path';
import { writeFileAtomically } from './atomic-file.ts';
import { AUTH_DOCUMENT_MAX_BYTES, createFileCredentialStore, credentialFileFor, storeThroughScope } from './credential-store.ts';
import type { CredentialEntry, CredentialKeyListing, ListableCredentialStore } from './credential-store.ts';
import { systemFileLockPorts, withFileLock } from './file-lock.ts';
import { parseOutsideJson } from './json-depth.ts';
import type { FileLockPorts } from './file-lock.ts';
import { nodeFileSystem } from './node-file-system.ts';
import type { Random } from './random.ts';
import { SecretStoreAbsentError, StoreCallEndedError, limitEndOf } from './secret-store-failures.ts';
import type { SecretStore } from './secret-store.ts';
import { systemRandom } from './system-random.ts';

export const CREDENTIAL_KEY_PREFIX = 'credential-key-';
export const CREDENTIAL_KEY_MARKER_FILE = 'credential-key.json';
export const CREDENTIAL_KEY_LOCK_NAME = 'credential-key.lock';
export const CREDENTIAL_KEY_CREATION_STEPS = ['read_marker_again', 'write_os_item', 'write_marker'] as const;
export const CREDENTIAL_KEY_OS_POINTS = ['fast', 'locked', 'creating'] as const;

export const CREDENTIAL_ENVELOPE_FORMAT = 'momonga-credential/1';

export const CREDENTIAL_STORE_ERROR_CODES = ['store_unreadable', 'store_unwritable'] as const;

export type CredentialStoreErrorCode = (typeof CREDENTIAL_STORE_ERROR_CODES)[number];

export class CredentialStoreError extends Error {
  readonly code: CredentialStoreErrorCode;

  constructor(code: CredentialStoreErrorCode, message: string, options?: { cause: unknown }) {
    super(message, options);
    this.name = 'CredentialStoreError';
    this.code = code;
  }
}

export type CredentialSecretStore = { kind: 'available'; store: SecretStore } | { kind: 'none'; reason: string };

export type EncryptedCredentialStoreOptions = {
  directory: string;
  stateDirectory: string;
  secretStore: CredentialSecretStore;
  plaintextTokenFiles: () => boolean;
  keyOfPlaintext?: (text: string) => string;
  ports?: FileLockPorts;
  random?: Random;
};

type CreationStep = (typeof CREDENTIAL_KEY_CREATION_STEPS)[number];

type CreatedKey = { keyHex: string; name: string };

type CreationState = { found: string | undefined; created: CreatedKey | undefined };

const throwIfCancelled = (error: unknown, signal: AbortSignal): void => {
  if (error instanceof StoreCallEndedError) throw new StoreCallEndedError({ ...error.call, name: undefined }, error.limit);
  if ((signal.aborted && error === signal.reason) || limitEndOf(error) !== undefined) throw error;
};

const KEY_BYTES = 32;
const KEY_NAME_BYTES = 8;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const FILE_MODE = 0o600;

type Envelope = { format: string; key: string; nonce: string; ciphertext: string; tag: string };

const ENVELOPE_FIELDS: readonly (keyof Envelope)[] = ['format', 'key', 'nonce', 'ciphertext', 'tag'];


const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const envelopeOf = (text: string): Envelope | undefined => {
  let parsed: unknown;
  try {
    parsed = parseOutsideJson(text);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || parsed['format'] !== CREDENTIAL_ENVELOPE_FORMAT) return undefined;
  if (Object.keys(parsed).length !== ENVELOPE_FIELDS.length || !ENVELOPE_FIELDS.every((field) => typeof parsed[field] === 'string')) return undefined;
  return parsed as Envelope;
};

const additionalDataOf = (storeKey: string): Uint8Array =>
  Buffer.concat([Buffer.from(CREDENTIAL_ENVELOPE_FORMAT, 'utf8'), Buffer.from([0]), Buffer.from(storeKey, 'utf8')]);

const cipherKeyOf = (keyHex: string): Promise<webcrypto.CryptoKey> => {
  const bytes = Buffer.from(keyHex, 'hex');
  if (bytes.length !== KEY_BYTES || bytes.toString('hex') !== keyHex.toLowerCase()) {
    return Promise.reject(new Error(`the credential key is not ${KEY_BYTES} bytes of hex`));
  }
  return globalThis.crypto.subtle.importKey('raw', bytes, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
};

const seal = async (random: Random, keyHex: string, storeKey: string, value: string): Promise<Envelope> => {
  const nonce = Buffer.from(random.bytes(NONCE_BYTES));
  const sealed = Buffer.from(
    await globalThis.crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: nonce, additionalData: additionalDataOf(storeKey), tagLength: TAG_BYTES * 8 },
      await cipherKeyOf(keyHex),
      Buffer.from(value, 'utf8'),
    ),
  );
  return {
    format: CREDENTIAL_ENVELOPE_FORMAT,
    key: storeKey,
    nonce: nonce.toString('hex'),
    ciphertext: sealed.subarray(0, sealed.length - TAG_BYTES).toString('hex'),
    tag: sealed.subarray(sealed.length - TAG_BYTES).toString('hex'),
  };
};

const open = async (keyHex: string, envelope: Envelope): Promise<string> => {
  const opened = await globalThis.crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: Buffer.from(envelope.nonce, 'hex'), additionalData: additionalDataOf(envelope.key), tagLength: TAG_BYTES * 8 },
    await cipherKeyOf(keyHex),
    Buffer.concat([Buffer.from(envelope.ciphertext, 'hex'), Buffer.from(envelope.tag, 'hex')]),
  );
  return Buffer.from(opened).toString('utf8');
};

const noStoreRefusal = (reason: string): string =>
  `No secret store was found on this host (${reason}). MomongaCode does not keep sign-in tokens in a plain file unless you ask: set credentials.plaintextTokenFiles to true in your user settings to keep them in a file only you can read.`;

const refusedWithoutStore = (code: CredentialStoreErrorCode, { reason, backend }: Pick<SecretStoreAbsentError, 'reason' | 'backend'>): CredentialStoreError =>
  new CredentialStoreError(code, noStoreRefusal(reason), { cause: new SecretStoreAbsentError({ reason, backend }) });

const notEncrypted = (file: string): string =>
  `The credential file ${file} is not encrypted. Delete it and sign in again, or set credentials.plaintextTokenFiles to true to keep using it.`;

const RECORD_FILE_NAME = /^[0-9a-f]{64}\.json$/;

const errorCodeOf = (error: unknown): unknown => (isRecord(error) ? error['code'] : undefined);

const KEY_NAME_SHAPE = new RegExp(`^${CREDENTIAL_KEY_PREFIX}[0-9a-f]{${KEY_NAME_BYTES * 2}}$`);

const keyNameOfMarker = (text: string, markerFile: string): string => {
  const parsed: unknown = parseOutsideJson(text);
  const name = isRecord(parsed) ? parsed['name'] : undefined;
  if (typeof name !== 'string' || !KEY_NAME_SHAPE.test(name)) throw new Error(`the marker ${markerFile} does not name a credential key`);
  return name;
};

export const createEncryptedCredentialStore = (options: EncryptedCredentialStoreOptions): ListableCredentialStore => {
  const ports = options.ports ?? systemFileLockPorts;
  const random = options.random ?? systemRandom;
  const records = createFileCredentialStore(options.directory, { ports });
  const markerFile = path.join(options.stateDirectory, CREDENTIAL_KEY_MARKER_FILE);
  const lockFile = path.join(options.stateDirectory, CREDENTIAL_KEY_LOCK_NAME);

  const readMarker = async (): Promise<string | undefined> => {
    const text = await nodeFileSystem.readOwnerOnlyTextFile(markerFile, `credential key marker ${markerFile}`);
    return text === undefined ? undefined : keyNameOfMarker(text, markerFile);
  };

  const readNamedKey = async (store: SecretStore, signal: AbortSignal): Promise<string | undefined> => {
    const name = await readMarker();
    return name === undefined ? undefined : store.read(name, signal);
  };

  const createKey = async (store: SecretStore, signal: AbortSignal): Promise<string> => {
    const creation: CreationState = { found: undefined, created: undefined };
    const steps: Readonly<Record<CreationStep, () => Promise<void>>> = {
      read_marker_again: async () => {
        creation.found = await readNamedKey(store, signal);
      },
      write_os_item: async () => {
        const keyHex = Buffer.from(random.bytes(KEY_BYTES)).toString('hex');
        const name = `${CREDENTIAL_KEY_PREFIX}${Buffer.from(random.bytes(KEY_NAME_BYTES)).toString('hex')}`;
        await store.write(name, keyHex, signal);
        creation.created = { keyHex, name };
      },
      write_marker: async () => {
        const { name } = creation.created as CreatedKey;
        await writeFileAtomically(nodeFileSystem, { ...systemRandom, hex: ports.randomHex }, markerFile, `${JSON.stringify({ name })}\n`, { mode: FILE_MODE });
      },
    };
    for (const step of CREDENTIAL_KEY_CREATION_STEPS) {
      await steps[step]();
      if (creation.found !== undefined) return creation.found;
    }
    return (creation.created as CreatedKey).keyHex;
  };

  const keyForWriting = async (store: SecretStore, signal: AbortSignal): Promise<string> => {
    const named = await readNamedKey(store, signal);
    if (named !== undefined) return named;
    await nodeFileSystem.mkdirPrivate(options.stateDirectory);
    return withFileLock(lockFile, () => createKey(store, signal), { ports, signal });
  };

  const keyForReading = async (signal: AbortSignal, file: string): Promise<string> => {
    if (options.secretStore.kind === 'none') throw refusedWithoutStore('store_unreadable', { reason: options.secretStore.reason, backend: undefined });
    const named = await readNamedKey(options.secretStore.store, signal).catch((error: unknown) => {
      throwIfCancelled(error, signal);
      if (error instanceof SecretStoreAbsentError) throw refusedWithoutStore('store_unreadable', error);
      throw new CredentialStoreError('store_unreadable', `the key of the credential file ${file} could not be read: ${messageOf(error)}`, { cause: error });
    });
    if (named === undefined) throw new CredentialStoreError('store_unreadable', `the credential file ${file} is encrypted, but the marker ${markerFile} naming its key is missing`, { cause: new Error(`${markerFile} does not exist`) });
    return named;
  };

  const decode = async (key: string, text: string | undefined, plaintext: boolean, signal: AbortSignal): Promise<string | undefined> => {
    if (text === undefined) return undefined;
    const file = credentialFileFor(options.directory, key);
    const envelope = envelopeOf(text);
    if (envelope === undefined) {
      if (plaintext) return text;
      throw new CredentialStoreError('store_unreadable', notEncrypted(file));
    }
    if (envelope.key !== key) {
      throw new CredentialStoreError('store_unreadable', `the credential file ${file} holds the record of another key`, { cause: new Error(`the envelope key is ${JSON.stringify(envelope.key)}`) });
    }
    const keyHex = await keyForReading(signal, file);
    return open(keyHex, envelope).catch((error: unknown) => {
      throw new CredentialStoreError('store_unreadable', `the credential file ${file} could not be decrypted: ${messageOf(error)}`, { cause: error });
    });
  };

  const encode = async (key: string, value: string, signal: AbortSignal): Promise<string> => {
    if (options.secretStore.kind === 'none') throw refusedWithoutStore('store_unwritable', { reason: options.secretStore.reason, backend: undefined });
    const keyHex = await keyForWriting(options.secretStore.store, signal).catch((error: unknown) => {
      throwIfCancelled(error, signal);
      if (error instanceof SecretStoreAbsentError) throw refusedWithoutStore('store_unwritable', error);
      throw new CredentialStoreError('store_unwritable', `the credential key could not be read or created: ${messageOf(error)}`, { cause: error });
    });
    return JSON.stringify(await seal(random, keyHex, key, value));
  };

  const entryOf = (key: string, inner: CredentialEntry, signal: AbortSignal): CredentialEntry => {
    const plaintext = options.plaintextTokenFiles();
    return {
      read: async () => decode(key, await inner.read(), plaintext, signal),
      write: async (value) => inner.write(plaintext ? value : await encode(key, value, signal)),
      remove: () => inner.remove(),
    };
  };

  const keyOfText = (text: string, file: string): string => {
    const envelope = envelopeOf(text);
    if (envelope !== undefined) return envelope.key;
    if (options.keyOfPlaintext === undefined) throw new Error(notEncrypted(file));
    return options.keyOfPlaintext(text);
  };

  const listKeys = async (signal: AbortSignal): Promise<CredentialKeyListing> => {
    signal.throwIfAborted();
    const listing: CredentialKeyListing = { keys: [], problems: [] };
    let names: string[];
    try {
      names = await nodeFileSystem.readdir(options.directory);
    } catch (error) {
      if (errorCodeOf(error) === 'ENOENT') return listing;
      listing.problems.push({ file: path.basename(options.directory), cause: messageOf(error) });
      return listing;
    }
    for (const name of names.filter((entry) => RECORD_FILE_NAME.test(entry)).sort()) {
      signal.throwIfAborted();
      const file = path.join(options.directory, name);
      try {
        const text = await nodeFileSystem.readOwnerOnlyTextFile(file, `credential file ${file}`, AUTH_DOCUMENT_MAX_BYTES);
        if (text === undefined) continue;
        const key = keyOfText(text, file);
        if (credentialFileFor(options.directory, key) !== file) throw new Error(`the credential file ${file} holds the record of ${JSON.stringify(key)}, which belongs in another file`);
        listing.keys.push({ key, file: name });
      } catch (error) {
        listing.problems.push({ file: name, cause: messageOf(error) });
      }
    }
    return listing;
  };

  return {
    ...storeThroughScope({
      read: async (key, signal) => decode(key, await records.read(key, signal), options.plaintextTokenFiles(), signal),
      withKey: (key, action, signal) => records.withKey(key, (inner) => action(entryOf(key, inner, signal)), signal),
    }),
    listKeys,
  };
};
