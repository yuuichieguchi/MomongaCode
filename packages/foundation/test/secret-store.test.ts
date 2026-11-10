import { describe, expect, it } from 'vitest';
import {
  KEYCHAIN_SERVICE,
  SECURITY_BINARY,
  SecretEmptyError,
  SecretUnavailableError,
  SecretWriteError,
  createKeychainSecretStore,
} from '@momonga/foundation';
import type { SecretProcessResult, SecretStore } from '@momonga/foundation';
import { READY, answering, failing, keychainFilePresent, perCommandPort } from './support/secret-store-fakes.ts';
import type { Call, PerCommandPort } from './support/secret-store-fakes.ts';

const READINESS_CALL: Call = { file: SECURITY_BINARY, args: ['default-keychain'], stdin: '' };

const recordingPort = (result: SecretProcessResult): PerCommandPort => perCommandPort({ readiness: answering(READY), call: answering(result) });

const keychainOver = (fake: PerCommandPort): SecretStore => createKeychainSecretStore(fake.port, SECURITY_BINARY, keychainFilePresent().files);

const NEVER_ABORTED = new AbortController().signal;

describe('createKeychainSecretStore', () => {
  it('reads through the process port with argv that carries no secret value', async () => {
    const fake = recordingPort({ exitCode: 0, stdout: 'sk-ant-fake-value\n', stderr: '' });
    const value = await keychainOver(fake).read('anthropic-main', NEVER_ABORTED);
    expect(value).toBe('sk-ant-fake-value');
    expect(fake.calls).toEqual([
      READINESS_CALL,
      { file: SECURITY_BINARY, args: ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', 'anthropic-main', '-w'], stdin: '' },
    ]);
  });

  it('strips exactly one trailing newline', async () => {
    const fake = recordingPort({ exitCode: 0, stdout: 'value\n\n', stderr: '' });
    expect(await keychainOver(fake).read('k', NEVER_ABORTED)).toBe('value\n');
  });

  it('passes the abort signal to the port', async () => {
    const fake = recordingPort({ exitCode: 0, stdout: 'v\n', stderr: '' });
    const controller = new AbortController();
    await keychainOver(fake).read('k', controller.signal);
    expect(fake.signals).toHaveLength(2);
    expect(fake.signals[0]).toBe(controller.signal);
    expect(fake.signals[1]).toBe(controller.signal);
  });

  it('keeps the exit code and stderr of a failed read in a typed error', async () => {
    const fake = recordingPort({ exitCode: 44, stdout: '', stderr: 'item could not be found\n' });
    const failure = keychainOver(fake).read('absent', NEVER_ABORTED);
    await expect(failure).rejects.toBeInstanceOf(SecretUnavailableError);
    await expect(failure).rejects.toMatchObject({ exitCode: 44, secretName: 'absent' });
    await expect(failure).rejects.toThrow('item could not be found');
    await expect(failure).rejects.toThrow('the gateway reads a missing secret again on the next request');
  });

  it('rejects an empty stored value', async () => {
    const fake = recordingPort({ exitCode: 0, stdout: '\n', stderr: '' });
    await expect(keychainOver(fake).read('empty', NEVER_ABORTED)).rejects.toBeInstanceOf(SecretEmptyError);
  });

  it.for(['', '-s', 'a b', 'a/b', '.hidden', 'x'.repeat(129)])('rejects the unsafe secret name %j without invoking the port', async (name) => {
    const fake = recordingPort({ exitCode: 0, stdout: 'v\n', stderr: '' });
    await expect(keychainOver(fake).read(name, NEVER_ABORTED)).rejects.toBeInstanceOf(RangeError);
    expect(fake.calls).toEqual([]);
  });

  it.for([
    ['the readiness call', 1],
    ['the real call', 2],
  ] as const)('propagates a port failure unchanged (%s)', async ([point, callCount]) => {
    const failure = new Error('spawn failed');
    const fake =
      point === 'the readiness call'
        ? perCommandPort({ readiness: failing(failure), call: answering({ exitCode: 0, stdout: 'v\n', stderr: '' }) })
        : perCommandPort({ readiness: answering(READY), call: failing(failure) });
    await expect(keychainOver(fake).read('k', NEVER_ABORTED)).rejects.toBe(failure);
    expect(fake.calls).toHaveLength(callCount);
  });
});

describe('createKeychainSecretStore write', () => {
  it('feeds an interactive add-generic-password with a hex value through stdin and keeps the value out of argv', async () => {
    const fake = recordingPort({ exitCode: 0, stdout: '', stderr: '' });
    await keychainOver(fake).write('anthropic-main', 'sk-ant-fake-value', NEVER_ABORTED);
    expect(fake.calls).toEqual([
      READINESS_CALL,
      {
        file: SECURITY_BINARY,
        args: ['-i'],
        stdin: `add-generic-password -U -s ${KEYCHAIN_SERVICE} -a anthropic-main -X ${Buffer.from('sk-ant-fake-value').toString('hex')}\n`,
      },
    ]);
    expect(JSON.stringify(fake.calls.map((call) => call.args))).not.toContain('sk-ant');
  });

  it('keeps the exit code and stderr of a failed write in a typed error', async () => {
    const fake = recordingPort({ exitCode: 36, stdout: '', stderr: 'User interaction is not allowed.\n' });
    const failure = keychainOver(fake).write('k', 'v', NEVER_ABORTED);
    await expect(failure).rejects.toBeInstanceOf(SecretWriteError);
    await expect(failure).rejects.toMatchObject({ exitCode: 36, secretName: 'k' });
    await expect(failure).rejects.toThrow('User interaction is not allowed.');
  });

  it('rejects an unsafe name and an empty value without invoking the port', async () => {
    const fake = recordingPort({ exitCode: 0, stdout: '', stderr: '' });
    const store = keychainOver(fake);
    await expect(store.write('a b', 'v', NEVER_ABORTED)).rejects.toBeInstanceOf(RangeError);
    await expect(store.write('k', '', NEVER_ABORTED)).rejects.toBeInstanceOf(RangeError);
    expect(fake.calls).toEqual([]);
  });
});
