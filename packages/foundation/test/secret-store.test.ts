import { describe, expect, it } from 'vitest';
import {
  KEYCHAIN_SERVICE,
  SECURITY_BINARY,
  SecretEmptyError,
  SecretUnavailableError,
  createKeychainSecretStore,
} from '@momonga/foundation';
import type { SecretProcessPort, SecretProcessResult } from '@momonga/foundation';

type Call = { file: string; args: readonly string[]; stdin: string };

const recordingPort = (result: SecretProcessResult): { port: SecretProcessPort; calls: Call[] } => {
  const calls: Call[] = [];
  const port: SecretProcessPort = async (file, args, stdin) => {
    calls.push({ file, args, stdin });
    return result;
  };
  return { port, calls };
};

const NEVER_ABORTED = new AbortController().signal;

describe('createKeychainSecretStore', () => {
  it('reads through the process port with argv that carries no secret value', async () => {
    const { port, calls } = recordingPort({ exitCode: 0, stdout: 'sk-ant-fake-value\n', stderr: '' });
    const value = await createKeychainSecretStore(port).read('anthropic-main', NEVER_ABORTED);
    expect(value).toBe('sk-ant-fake-value');
    expect(calls).toEqual([
      { file: SECURITY_BINARY, args: ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', 'anthropic-main', '-w'], stdin: '' },
    ]);
  });

  it('strips exactly one trailing newline', async () => {
    const { port } = recordingPort({ exitCode: 0, stdout: 'value\n\n', stderr: '' });
    expect(await createKeychainSecretStore(port).read('k', NEVER_ABORTED)).toBe('value\n');
  });

  it('passes the abort signal to the port', async () => {
    const seen: AbortSignal[] = [];
    const store = createKeychainSecretStore(async (_file, _args, _stdin, signal) => {
      seen.push(signal);
      return { exitCode: 0, stdout: 'v\n', stderr: '' };
    });
    const controller = new AbortController();
    await store.read('k', controller.signal);
    expect(seen).toEqual([controller.signal]);
  });

  it('keeps the exit code and stderr of a failed read in a typed error', async () => {
    const { port } = recordingPort({ exitCode: 44, stdout: '', stderr: 'item could not be found\n' });
    const failure = createKeychainSecretStore(port).read('absent', NEVER_ABORTED);
    await expect(failure).rejects.toBeInstanceOf(SecretUnavailableError);
    await expect(failure).rejects.toMatchObject({ exitCode: 44, secretName: 'absent' });
    await expect(failure).rejects.toThrow('item could not be found');
    await expect(failure).rejects.toThrow('then restart the gateway, which reads secrets once at startup');
  });

  it('rejects an empty stored value', async () => {
    const { port } = recordingPort({ exitCode: 0, stdout: '\n', stderr: '' });
    await expect(createKeychainSecretStore(port).read('empty', NEVER_ABORTED)).rejects.toBeInstanceOf(SecretEmptyError);
  });

  it.for(['', '-s', 'a b', 'a/b', '.hidden', 'x'.repeat(129)])('rejects the unsafe secret name %j without invoking the port', async (name) => {
    const { port, calls } = recordingPort({ exitCode: 0, stdout: 'v\n', stderr: '' });
    await expect(createKeychainSecretStore(port).read(name, NEVER_ABORTED)).rejects.toBeInstanceOf(RangeError);
    expect(calls).toEqual([]);
  });

  it('propagates a port failure unchanged', async () => {
    const failure = new Error('spawn failed');
    const store = createKeychainSecretStore(async () => {
      throw failure;
    });
    await expect(store.read('k', NEVER_ABORTED)).rejects.toBe(failure);
  });
});
