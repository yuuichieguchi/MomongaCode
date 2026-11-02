import { describe, expect, it } from 'vitest';
import {
  SECRET_TOOL_BINARY,
  SecretEmptyError,
  SecretUnavailableError,
  UnsupportedPlatformError,
  createPlatformSecretStore,
  credentialReadScript,
  credentialWriteScript,
  minimalChildEnv,
} from '@momonga/foundation';
import type { SecretProcessPort, SecretProcessResult } from '@momonga/foundation';

type Call = { file: string; args: readonly string[]; stdin: string };

const port = (result: SecretProcessResult): { run: SecretProcessPort; calls: Call[] } => {
  const calls: Call[] = [];
  return {
    calls,
    run: async (file, args, stdin) => {
      calls.push({ file, args, stdin });
      return result;
    },
  };
};

const SIGNAL = new AbortController().signal;

describe('linux secret store (secret-tool lookup)', () => {
  it('looks the secret up by service and account', async () => {
    const { run, calls } = port({ exitCode: 0, stdout: 'fake-secret', stderr: '' });
    expect(await createPlatformSecretStore('linux', run).read('anthropic', SIGNAL)).toBe('fake-secret');
    expect(calls).toEqual([{ file: SECRET_TOOL_BINARY, args: ['lookup', 'service', 'momonga', 'account', 'anthropic'], stdin: '' }]);
  });

  it('names the Secret Service and the store command when the lookup fails', async () => {
    const { run } = port({ exitCode: 1, stdout: '', stderr: '' });
    const error = await createPlatformSecretStore('linux', run).read('anthropic', SIGNAL).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SecretUnavailableError);
    expect((error as Error).message).toContain('Secret Service');
    expect((error as Error).message).toContain('secret-tool store --label=momonga service momonga account anthropic');
  });

  it('rejects an empty secret and an invalid name', async () => {
    const empty = createPlatformSecretStore('linux', port({ exitCode: 0, stdout: '\n', stderr: '' }).run);
    await expect(empty.read('k', SIGNAL)).rejects.toBeInstanceOf(SecretEmptyError);
    await expect(empty.read('bad name', SIGNAL)).rejects.toBeInstanceOf(RangeError);
  });
});

describe('linux secret store write (secret-tool store)', () => {
  it('passes the value on stdin only', async () => {
    const { run, calls } = port({ exitCode: 0, stdout: '', stderr: '' });
    await createPlatformSecretStore('linux', run).write('anthropic', 'fake-secret', SIGNAL);
    expect(calls).toEqual([
      { file: SECRET_TOOL_BINARY, args: ['store', '--label=momonga', 'service', 'momonga', 'account', 'anthropic'], stdin: 'fake-secret' },
    ]);
  });
});

describe('windows secret store write (Credential Manager through CredWrite)', () => {
  it('reads the value from the stdin of the script, never from the encoded command', async () => {
    const { run, calls } = port({ exitCode: 0, stdout: '', stderr: '' });
    await createPlatformSecretStore('win32', run, { SystemRoot: 'C:\\Windows' }).write('anthropic', 'fake-secret', SIGNAL);
    const script = Buffer.from(calls[0]?.args.at(-1) as string, 'base64').toString('utf16le');
    expect(script).toBe(credentialWriteScript('momonga/anthropic', 'momonga'));
    expect(script).toContain('[Console]::In.ReadToEnd()');
    expect(script).not.toContain('fake-secret');
    expect(calls[0]?.stdin).toBe('fake-secret');
  });
});

describe('windows secret store (Credential Manager through CredRead)', () => {
  const env = { SystemRoot: 'C:\\Windows' };

  it('runs powershell with an encoded script that reads the generic credential momonga/<name>', async () => {
    const { run, calls } = port({ exitCode: 0, stdout: 'fake-secret', stderr: '' });
    expect(await createPlatformSecretStore('win32', run, env).read('anthropic', SIGNAL)).toBe('fake-secret');
    expect(calls[0]?.file).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    const script = Buffer.from(calls[0]?.args.at(-1) as string, 'base64').toString('utf16le');
    expect(script).toBe(credentialReadScript('momonga/anthropic'));
    expect(script).toContain('CredReadW');
    expect(script).toContain("Read('momonga/anthropic'");
  });

  it('keeps the secret out of argv and reports a missing credential with the cmdkey command', async () => {
    const { run } = port({ exitCode: 2, stdout: '', stderr: 'CredRead failed with Win32 error 1168' });
    const error = await createPlatformSecretStore('win32', run, env).read('anthropic', SIGNAL).catch((e: unknown) => e);
    expect((error as Error).message).toContain('Credential Manager');
    expect((error as Error).message).toContain('cmdkey /generic:momonga/anthropic');
    expect((error as Error).message).toContain('1168');
  });
});

describe('platform selection', () => {
  it('rejects platforms without a secret store', () => {
    expect(() => createPlatformSecretStore('freebsd', port({ exitCode: 0, stdout: '', stderr: '' }).run)).toThrow(UnsupportedPlatformError);
  });
});

describe('minimalChildEnv per platform', () => {
  const source = {
    PATH: '/custom',
    HOME: '/home/u',
    XDG_RUNTIME_DIR: '/run/user/1000',
    DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
    SystemRoot: 'C:\\Windows',
    APPDATA: 'C:\\Users\\u\\AppData\\Roaming',
    SECRET_TOKEN: 'x',
  };

  it('keeps the session bus variables on linux only', () => {
    expect(minimalChildEnv(source, 'linux')).toEqual({ PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: '/home/u', XDG_RUNTIME_DIR: '/run/user/1000', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus' });
    expect(minimalChildEnv(source, 'darwin')).toEqual({ PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: '/home/u' });
  });

  it('builds a system PATH and keeps the profile variables on win32', () => {
    expect(minimalChildEnv(source, 'win32')).toEqual({
      PATH: 'C:\\Windows\\System32;C:\\Windows',
      HOME: '/home/u',
      SystemRoot: 'C:\\Windows',
      APPDATA: 'C:\\Users\\u\\AppData\\Roaming',
    });
    expect(() => minimalChildEnv({ HOME: 'x' }, 'win32')).toThrow('SystemRoot');
  });
});
