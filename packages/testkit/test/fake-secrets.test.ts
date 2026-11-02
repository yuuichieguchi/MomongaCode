import { describe, expect, it } from 'vitest';
import { KEYCHAIN_SERVICE, SECURITY_BINARY, SecretUnavailableError } from '@momonga/foundation';
import { createFakeSecretStore, createFakeSecurityPort } from '../src/index.ts';

const NEVER_ABORTED = new AbortController().signal;

describe('createFakeSecurityPort', () => {
  it('answers a find-generic-password invocation and records it', async () => {
    const port = createFakeSecurityPort(() => ({ main: 'value' }));
    const args = ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', 'main', '-w'];
    expect(await port(SECURITY_BINARY, args, '', NEVER_ABORTED)).toEqual({ exitCode: 0, stdout: 'value\n', stderr: '' });
    expect(port.calls).toEqual([{ file: SECURITY_BINARY, args, stdin: '' }]);
  });

  it('answers exit 44 for an absent item', async () => {
    const port = createFakeSecurityPort(() => ({}));
    const result = await port(SECURITY_BINARY, ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', 'gone', '-w'], '', NEVER_ABORTED);
    expect(result.exitCode).toBe(44);
  });

  it.for([
    ['/usr/bin/other', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', 'main', '-w'], ''],
    [SECURITY_BINARY, ['add-generic-password', '-s', KEYCHAIN_SERVICE, '-a', 'main', '-w', 'leaked'], ''],
    [SECURITY_BINARY, ['find-generic-password', '-s', 'other-service', '-a', 'main', '-w'], ''],
    [SECURITY_BINARY, ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', 'main', '-w'], 'stdin'],
    [SECURITY_BINARY, ['-i'], 'add-generic-password -w leaked\n'],
  ] as const)('rejects the unexpected invocation %j', async ([file, args, stdin]) => {
    const port = createFakeSecurityPort(() => ({ main: 'value' }));
    await expect(port(file, args, stdin, NEVER_ABORTED)).rejects.toThrow('unexpected invocation');
  });
});

describe('createFakeSecurityPort writes', () => {
  it('decodes the hex value of an interactive add-generic-password and hands it to onWrite', async () => {
    const written: Array<[string, string]> = [];
    const port = createFakeSecurityPort(() => ({}), (name, value) => void written.push([name, value]));
    const stdin = `add-generic-password -U -s ${KEYCHAIN_SERVICE} -a main -X ${Buffer.from('sk-fake', 'utf8').toString('hex')}\n`;
    expect(await port(SECURITY_BINARY, ['-i'], stdin, NEVER_ABORTED)).toEqual({ exitCode: 0, stdout: '', stderr: '' });
    expect(written).toEqual([['main', 'sk-fake']]);
  });
});

describe('createFakeSecretStore', () => {
  it('reads configured secrets, records the reads and raises the typed error for an absent one', async () => {
    const store = createFakeSecretStore({ a: 'one' });
    expect(await store.read('a', NEVER_ABORTED)).toBe('one');
    await expect(store.read('b', NEVER_ABORTED)).rejects.toBeInstanceOf(SecretUnavailableError);
    expect(store.reads).toEqual(['a', 'b']);
  });

  it('records a write and reads it back', async () => {
    const store = createFakeSecretStore({});
    await store.write('k', 'v', NEVER_ABORTED);
    expect(store.writes).toEqual([{ name: 'k', value: 'v' }]);
    expect(await store.read('k', NEVER_ABORTED)).toBe('v');
  });
});
