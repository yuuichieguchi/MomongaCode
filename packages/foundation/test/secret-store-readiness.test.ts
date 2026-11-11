import { describe, expect, it } from 'vitest';
import { CREDENTIAL_MANAGER_BACKEND, KEYCHAIN_BACKEND, SECRET_SERVICE_BACKEND } from '@momonga/foundation/secret-store';
import {
  SECRET_TOOL_BINARY,
  SECURITY_BINARY,
  SecretStoreAbsentError,
  SecretStoreAnswerError,
  SecretUnavailableError,
  createCredentialManagerStore,
  createGivenSecretStore,
  createKeychainSecretStore,
  createPlatformSecretStore,
  createSecretServiceStore,
} from '@momonga/foundation';
import type { SecretProcessResult, SecretStore } from '@momonga/foundation';
import {
  KEYCHAIN_PATH,
  NO_DEFAULT,
  READY,
  R_FG,
  R_ND,
  R_NOT_GIVEN,
  R_PATH,
  aFile,
  answering,
  failing,
  keychainFileMissing,
  keychainFilePresent,
  notAFile,
  perCommandPort,
  recordingFiles,
  rejection,
  statFailure,
} from './support/secret-store-fakes.ts';
import type { PerCommandPort, RecordingFiles } from './support/secret-store-fakes.ts';
import { makeTemporaryDirectory as makeDir } from './support/temporary-directory.ts';

const SIGNAL = new AbortController().signal;

const READINESS_CALL = { file: SECURITY_BINARY, args: ['default-keychain'], stdin: '' };
const FIND_K = { file: SECURITY_BINARY, args: ['find-generic-password', '-s', 'momonga', '-a', 'k', '-w'], stdin: '' };
const ADD_K_V = { file: SECURITY_BINARY, args: ['-i'], stdin: 'add-generic-password -U -s momonga -a k -X 76\n' };

const FOUND: SecretProcessResult = { exitCode: 0, stdout: 'held\n', stderr: '' };

const keychain = (fake: PerCommandPort, files: RecordingFiles = keychainFilePresent()): SecretStore => createKeychainSecretStore(fake.port, SECURITY_BINARY, files.files);

const readinessOf = (result: SecretProcessResult): PerCommandPort => perCommandPort({ readiness: answering(result), call: answering(FOUND) });

describe('the Keychain readiness question before every call', () => {
  it('a keychain without a default keychain refuses a write before any keychain call', async () => {
    const fake = readinessOf(NO_DEFAULT);
    const error = await rejection(keychain(fake).write('x', 'v', SIGNAL));
    expect((error as Error).name).toBe('SecretStoreAbsentError');
    expect(error).toBeInstanceOf(SecretStoreAbsentError);
    expect((error as SecretStoreAbsentError).reason).toBe(R_ND);
    expect((error as SecretStoreAbsentError).backend).toBe(KEYCHAIN_BACKEND);
    expect((error as Error).message).toBe(
      'the secret "x" could not be written: no secret store was found on this host (security reports no default keychain (SecKeychainCopyDefault: A default keychain could not be found.)); make a default keychain available',
    );
    expect(fake.calls).toEqual([READINESS_CALL]);
  });

  it('a keychain without a default keychain refuses a read before any keychain call', async () => {
    const fake = readinessOf(NO_DEFAULT);
    const error = await rejection(keychain(fake).read('k', SIGNAL));
    expect((error as Error).name).toBe('SecretStoreAbsentError');
    expect(error).toBeInstanceOf(SecretStoreAbsentError);
    expect((error as SecretStoreAbsentError).reason).toBe(R_ND);
    expect((error as SecretStoreAbsentError).backend).toBe(KEYCHAIN_BACKEND);
    expect((error as Error).message).toBe(
      'the secret "k" could not be read: no secret store was found on this host (security reports no default keychain (SecKeychainCopyDefault: A default keychain could not be found.)); make a default keychain available, then store it with: security add-generic-password -s momonga -a k -w',
    );
    expect(fake.calls).toEqual([READINESS_CALL]);
  });

  it('a default keychain whose file is gone is absent', async () => {
    const fake = readinessOf(READY);
    const files = keychainFileMissing();
    const error = await rejection(keychain(fake, files).read('k', SIGNAL));
    expect((error as Error).name).toBe('SecretStoreAbsentError');
    expect(error).toBeInstanceOf(SecretStoreAbsentError);
    expect((error as SecretStoreAbsentError).reason).toBe(R_FG);
    expect((error as SecretStoreAbsentError).backend).toBe(KEYCHAIN_BACKEND);
    expect((error as Error).message).toBe(
      'the secret "k" could not be read: no secret store was found on this host (the default keychain /Users/x/Library/Keychains/login.keychain-db does not exist); make a default keychain available, then store it with: security add-generic-password -s momonga -a k -w',
    );
    expect(fake.calls).toEqual([READINESS_CALL]);
    expect(files.asked).toEqual([KEYCHAIN_PATH]);
  });

  it('a path below a file is absent too', async () => {
    const fake = readinessOf(READY);
    const error = await rejection(keychain(fake, recordingFiles(statFailure('ENOTDIR'))).read('k', SIGNAL));
    expect((error as Error).name).toBe('SecretStoreAbsentError');
    expect((error as SecretStoreAbsentError).reason).toBe(R_FG);
    expect(fake.calls).toEqual([READINESS_CALL]);
  });

  it('a ready keychain runs the real read after the readiness call', async () => {
    const fake = readinessOf(READY);
    const files = keychainFilePresent();
    expect(await keychain(fake, files).read('k', SIGNAL)).toBe('held');
    expect(fake.calls).toEqual([READINESS_CALL, FIND_K]);
    expect(files.asked).toEqual([KEYCHAIN_PATH]);
  });

  it('a ready keychain runs the real write after the readiness call', async () => {
    const fake = perCommandPort({ call: answering({ exitCode: 0, stdout: '', stderr: '' }) });
    const files = keychainFilePresent();
    await keychain(fake, files).write('k', 'v', SIGNAL);
    expect(fake.calls).toEqual([READINESS_CALL, ADD_K_V]);
    expect(files.asked).toEqual([KEYCHAIN_PATH]);
  });

  it('asks again at every call and caches nothing', async () => {
    const fake = readinessOf(READY);
    const files = keychainFilePresent();
    const store = keychain(fake, files);
    await store.read('k', SIGNAL);
    await store.read('k', SIGNAL);
    expect(fake.calls).toEqual([READINESS_CALL, FIND_K, READINESS_CALL, FIND_K]);
    expect(files.asked).toEqual([KEYCHAIN_PATH, KEYCHAIN_PATH]);
  });

  it('asks the program the store was given', async () => {
    const fake = readinessOf(READY);
    const store = createKeychainSecretStore(fake.port, '/fake/bin/security', keychainFilePresent().files);
    await store.read('k', SIGNAL);
    expect(fake.calls.map((call) => [call.file, call.args[0]])).toEqual([
      ['/fake/bin/security', 'default-keychain'],
      ['/fake/bin/security', 'find-generic-password'],
    ]);
  });

  it('names its backend', () => {
    expect(keychain(readinessOf(READY)).backend).toBe(KEYCHAIN_BACKEND);
  });

  it.for([
    ['garbage on stdout', { exitCode: 0, stdout: 'garbage\n', stderr: '' }, 'the Keychain readiness answer was not understood (exit 0): garbage', 'garbage'],
    [
      'two quoted lines',
      { exitCode: 0, stdout: '    "/a/login.keychain-db"\n    "/b/login.keychain-db"\n', stderr: '' },
      'the Keychain readiness answer was not understood (exit 0): "/a/login.keychain-db"\n    "/b/login.keychain-db"',
      '"/a/login.keychain-db"\n    "/b/login.keychain-db"',
    ],
    ['no output', { exitCode: 0, stdout: '', stderr: '' }, 'the Keychain readiness answer was not understood (exit 0): no output', 'no output'],
    ['an error of another shape', { exitCode: 1, stdout: '', stderr: 'boom' }, 'the Keychain readiness answer was not understood (exit 1): boom', 'boom'],
    [
      'a long error',
      { exitCode: 1, stdout: '', stderr: 'e'.repeat(300) },
      `the Keychain readiness answer was not understood (exit 1): ${'e'.repeat(200)}`,
      'e'.repeat(200),
    ],
  ] as const)('an unknown readiness answer fails with a cause and runs no real call (%s)', async ([, answer, message, excerpt]) => {
    const fake = readinessOf(answer);
    const error = await rejection(keychain(fake).read('k', SIGNAL));
    expect((error as Error).name).toBe('SecretStoreAnswerError');
    expect(error).toBeInstanceOf(SecretStoreAnswerError);
    expect((error as Error).message).toBe(message);
    expect((error as SecretStoreAnswerError).backend).toBe(KEYCHAIN_BACKEND);
    expect((error as SecretStoreAnswerError).exitCode).toBe(answer.exitCode);
    expect((error as SecretStoreAnswerError).excerpt).toBe(excerpt);
    expect((error as SecretStoreAnswerError).excerpt.length).toBeLessThanOrEqual(200);
    expect(fake.calls).toEqual([READINESS_CALL]);
  });

  it.for([
    ['the program name', 'security: SecKeychainCopyDefault: The specified keychain could not be found.\n'],
    ['the program path', '/usr/bin/security: SecKeychainCopyDefault: The specified keychain could not be found.\n'],
  ] as const)('another SecKeychainCopyDefault error is absent (after %s)', async ([, stderr]) => {
    const fake = readinessOf({ exitCode: 1, stdout: '', stderr });
    const error = await rejection(keychain(fake).read('k', SIGNAL));
    expect((error as Error).name).toBe('SecretStoreAbsentError');
    expect(error).toBeInstanceOf(SecretStoreAbsentError);
    expect((error as SecretStoreAbsentError).reason).toBe('security reports no default keychain (SecKeychainCopyDefault: The specified keychain could not be found.)');
    expect(fake.calls).toEqual([READINESS_CALL]);
  });

  it.for([
    ['a directory', notAFile, 'the default keychain /p is not a file'],
    ['EACCES', statFailure('EACCES'), 'the default keychain /p could not be checked: EACCES'],
    ['ELOOP', statFailure('ELOOP'), 'the default keychain /p could not be checked: ELOOP'],
  ] as const)('a printed path that is not a file or cannot be checked is not understood (%s)', async ([, stat, excerpt]) => {
    const fake = readinessOf({ exitCode: 0, stdout: '    "/p"\n', stderr: '' });
    const files = recordingFiles(stat);
    const error = await rejection(keychain(fake, files).read('k', SIGNAL));
    expect((error as Error).name).toBe('SecretStoreAnswerError');
    expect(error).toBeInstanceOf(SecretStoreAnswerError);
    expect((error as SecretStoreAnswerError).excerpt).toBe(excerpt);
    expect((error as Error).message).toBe(`the Keychain readiness answer was not understood (exit 0): ${excerpt}`);
    expect(files.asked).toEqual(['/p']);
    expect(fake.calls).toEqual([READINESS_CALL]);
  });

  it('a port failure during the readiness call propagates unchanged', async () => {
    const failure = new Error('spawn security ENOENT');
    const fake = perCommandPort({ readiness: failing(failure), call: answering(FOUND) });
    const files = recordingFiles(aFile);
    expect(await rejection(keychain(fake, files).read('k', SIGNAL))).toBe(failure);
    expect(fake.calls).toEqual([READINESS_CALL]);
    expect(files.asked).toEqual([]);
  });
});

describe('backends that declare no readiness question', () => {
  const powershell = { file: 'powershell.exe', args: (script: string): readonly string[] => ['-EncodedCommand', script] };

  it.for([
    ['Secret Service read', 'secret-service', 'read'],
    ['Secret Service write', 'secret-service', 'write'],
    ['Credential Manager read', 'credential-manager', 'read'],
    ['Credential Manager write', 'credential-manager', 'write'],
  ] as const)('backends without readiness run one process per call (%s)', async ([, kind, action]) => {
    const fake = perCommandPort({ call: answering({ exitCode: 0, stdout: action === 'read' ? 'held' : '', stderr: '' }) });
    const files = recordingFiles(aFile);
    const store = kind === 'secret-service' ? createSecretServiceStore(fake.port) : createCredentialManagerStore(fake.port, powershell);
    if (action === 'read') expect(await store.read('k', SIGNAL)).toBe('held');
    else await store.write('k', 'v', SIGNAL);
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.file).toBe(kind === 'secret-service' ? SECRET_TOOL_BINARY : 'powershell.exe');
    expect(files.asked).toEqual([]);
    expect(store.backend).toBe(kind === 'secret-service' ? SECRET_SERVICE_BACKEND : CREDENTIAL_MANAGER_BACKEND);
  });

  it('a secret-tool failure stays a SecretUnavailableError', async () => {
    const fake = perCommandPort({ call: answering({ exitCode: 1, stdout: '', stderr: 'Cannot autolaunch D-Bus' }) });
    const error = await rejection(createSecretServiceStore(fake.port).read('k', SIGNAL));
    expect(error).toBeInstanceOf(SecretUnavailableError);
    expect((error as Error).name).toBe('SecretUnavailableError');
    expect((error as Error).message.endsWith('the gateway reads a missing secret again on the next request')).toBe(true);
    expect(fake.calls).toHaveLength(1);
  });

  it('a secret-tool write failure stays a SecretWriteError', async () => {
    const fake = perCommandPort({ call: answering({ exitCode: 1, stdout: '', stderr: 'no collection' }) });
    const error = await rejection(createSecretServiceStore(fake.port).write('k', 'v', SIGNAL));
    expect((error as Error).name).toBe('SecretWriteError');
    expect(fake.calls).toHaveLength(1);
  });
});

describe('the backend data of each OS store', () => {
  it('only the Keychain declares a readiness question, and each store its advice for a call that is not answered', () => {
    expect(KEYCHAIN_BACKEND.readiness?.args).toEqual(['default-keychain']);
    expect(KEYCHAIN_BACKEND.readiness?.advice).toBe('make a default keychain available');
    expect(KEYCHAIN_BACKEND.unansweredAdvice).toBe('the Keychain may be waiting for an answer in a window on your screen: answer it or unlock the login keychain');
    expect(Object.hasOwn(SECRET_SERVICE_BACKEND, 'readiness')).toBe(true);
    expect(SECRET_SERVICE_BACKEND.readiness).toBeUndefined();
    expect(SECRET_SERVICE_BACKEND.unansweredAdvice).toBe('the Secret Service may be waiting for you to answer a prompt: answer it or unlock the keyring');
    expect(Object.hasOwn(CREDENTIAL_MANAGER_BACKEND, 'readiness')).toBe(true);
    expect(CREDENTIAL_MANAGER_BACKEND.readiness).toBeUndefined();
    expect(Object.hasOwn(CREDENTIAL_MANAGER_BACKEND, 'unansweredAdvice')).toBe(true);
    expect(CREDENTIAL_MANAGER_BACKEND.unansweredAdvice).toBeUndefined();
  });

  it.for([
    ['a default keychain', READY, { kind: 'file', path: KEYCHAIN_PATH, named: `the default keychain ${KEYCHAIN_PATH}` }],
    ['no default keychain', NO_DEFAULT, { kind: 'absent', reason: R_ND }],
    ['garbage', { exitCode: 0, stdout: 'garbage\n', stderr: '' }, { kind: 'unknown', excerpt: 'garbage' }],
    ['a path holding a quote', { exitCode: 0, stdout: '    "/a "b"/login.keychain-db"\n', stderr: '' }, { kind: 'file', path: '/a "b"/login.keychain-db', named: 'the default keychain /a "b"/login.keychain-db' }],
    ['a non-zero exit with a quoted line', { exitCode: 1, stdout: '    "/p"\n', stderr: '' }, { kind: 'unknown', excerpt: '"/p"' }],
    ['stderr before stdout', { exitCode: 2, stdout: 'out\n', stderr: ' err \n' }, { kind: 'unknown', excerpt: 'err' }],
  ] as const)('the Keychain reads %s from the answer alone', ([, answer, reading]) => {
    expect(KEYCHAIN_BACKEND.readiness?.read(answer)).toEqual(reading);
  });
});

describe('no OS store at all', () => {
  const neverCalled = (): PerCommandPort => perCommandPort({ call: answering(FOUND) });

  it.for([
    ['the platform store reading', 'platform', 'read', R_PATH],
    ['the platform store writing', 'platform', 'write', R_PATH],
    ['the given store reading', 'given', 'read', R_NOT_GIVEN],
    ['the given store writing', 'given', 'write', R_NOT_GIVEN],
  ] as const)('no OS store on PATH is the same error class (%s)', async ([, kind, action, reason]) => {
    const fake = neverCalled();
    const store = kind === 'platform' ? createPlatformSecretStore(fake.port, { PATH: makeDir() }) : createGivenSecretStore(fake.port, {});
    const error = await rejection(action === 'read' ? store.read('k', SIGNAL) : store.write('k', 'v', SIGNAL));
    expect((error as Error).name).toBe('SecretStoreAbsentError');
    expect(error).toBeInstanceOf(SecretStoreAbsentError);
    expect((error as SecretStoreAbsentError).reason).toBe(reason);
    expect((error as SecretStoreAbsentError).backend).toBeUndefined();
    expect((error as Error).message).toBe(`the secret "k" could not be ${action === 'read' ? 'read' : 'written'}: no secret store was found on this host (${reason})`);
    expect(fake.calls).toEqual([]);
  });
});
