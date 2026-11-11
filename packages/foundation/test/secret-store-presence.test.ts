import type { SecretHost } from '@momonga/foundation/secret-store';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createPlatformSecretStore } from '@momonga/foundation';
import type { SecretProcessPort } from '@momonga/foundation';
import type { SecretStoreFiles } from '@momonga/foundation/secret-store';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const binDirWith = (...programs: string[]): string => {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'mm-secret-bin-')));
  tempDirs.push(dir);
  for (const program of programs) fs.writeFileSync(path.join(dir, program), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  return dir;
};

const recordingRun = () => {
  const calls: { file: string; args: readonly string[] }[] = [];
  const run: SecretProcessPort = async (file, args) => {
    calls.push({ file, args });
    if (args.length === 1 && args[0] === 'default-keychain') return { exitCode: 0, stdout: `    "${KEYCHAIN_PATH}"\n`, stderr: '' };
    return { exitCode: 0, stdout: 'fake-secret', stderr: '' };
  };
  return { run, calls };
};

const KEYCHAIN_PATH = '/Users/x/Library/Keychains/login.keychain-db';

const keychainFilePresent: SecretStoreFiles = {
  stat: async (file) => {
    if (file !== KEYCHAIN_PATH) throw Object.assign(new Error(`ENOENT: no such file or directory, stat '${file}'`), { code: 'ENOENT' });
    return { isFile: () => true };
  },
};

const SIGNAL = new AbortController().signal;
const DBUS = 'unix:path=/run/user/1000/bus';

const hostOf = (platform: NodeJS.Platform): SecretHost => ({ platform, uid: platform === 'win32' ? undefined : process.getuid?.(), realPathOf: (file: string) => fs.realpathSync(file) });

const readWith = async (run: SecretProcessPort, env: Record<string, string | undefined>, platform: NodeJS.Platform): Promise<string> =>
  createPlatformSecretStore(run, env, hostOf(platform), keychainFilePresent).read('anthropic', SIGNAL);

describe('secret store chosen by the platform, its program found on PATH (B13)', () => {
  it('uses the Keychain through the security program found on PATH', async () => {
    const bin = binDirWith('security');
    const { run, calls } = recordingRun();
    expect(await readWith(run, { PATH: bin }, 'darwin')).toBe('fake-secret');
    expect(calls).toEqual([
      { file: path.join(bin, 'security'), args: ['default-keychain'] },
      { file: path.join(bin, 'security'), args: ['find-generic-password', '-s', 'momonga', '-a', 'anthropic', '-w'] },
    ]);
  });

  it('uses the Secret Service through secret-tool found on PATH when a D-Bus session is present', async () => {
    const bin = binDirWith('secret-tool');
    const { run, calls } = recordingRun();
    expect(await readWith(run, { PATH: bin, DBUS_SESSION_BUS_ADDRESS: DBUS }, 'linux')).toBe('fake-secret');
    expect(calls).toEqual([{ file: path.join(bin, 'secret-tool'), args: ['lookup', 'service', 'momonga', 'account', 'anthropic'] }]);
  });

  it('does not use secret-tool without a D-Bus session and says the session is missing', async () => {
    const bin = binDirWith('secret-tool');
    const { run, calls } = recordingRun();
    const error = await readWith(run, { PATH: bin }, 'linux').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('secret-tool');
    expect((error as Error).message).toContain('D-Bus');
    expect(calls).toEqual([]);
  });

  it('names the program of the platform when it is not on PATH', async () => {
    const bin = binDirWith('secret-tool');
    const { run, calls } = recordingRun();
    const error = await readWith(run, { PATH: bin, DBUS_SESSION_BUS_ADDRESS: DBUS }, 'darwin').catch((caught: unknown) => caught);
    expect((error as Error).message).toContain('security (Keychain) is not on PATH');
    expect(calls).toEqual([]);
  });

  const POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
  const decodedScript = (args: readonly string[]): string => Buffer.from(args[4] ?? '', 'base64').toString('utf16le');

  it('uses the Credential Manager through PowerShell on Windows', async () => {
    const bin = binDirWith('cmdkey');
    const { run, calls } = recordingRun();
    expect(await readWith(run, { PATH: bin, SystemRoot: 'C:\\Windows' }, 'win32')).toBe('fake-secret');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.file).toBe(POWERSHELL);
    expect(calls[0]?.args.slice(0, 4)).toEqual(['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand']);
    expect(decodedScript(calls[0]?.args ?? [])).toContain("'momonga/anthropic'");
    expect(decodedScript(calls[0]?.args ?? [])).toContain('CredReadW');
  });

  it('writes to the Credential Manager through PowerShell with the value on stdin on Windows', async () => {
    const bin = binDirWith('cmdkey');
    const calls: { file: string; args: readonly string[]; stdin: string }[] = [];
    const run: SecretProcessPort = async (file, args, stdin) => {
      calls.push({ file, args, stdin });
      return { exitCode: 0, stdout: '', stderr: '' };
    };
    await createPlatformSecretStore(run, { PATH: bin, SystemRoot: 'C:\\Windows' }, hostOf('win32')).write('anthropic', 'value-to-store', SIGNAL);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.file).toBe(POWERSHELL);
    expect(decodedScript(calls[0]?.args ?? [])).toContain('CredWrite');
    expect(decodedScript(calls[0]?.args ?? [])).toContain("'momonga/anthropic'");
    expect(decodedScript(calls[0]?.args ?? [])).not.toContain('value-to-store');
    expect(calls[0]?.stdin).toBe('value-to-store');
  });

  it.each([
    ['darwin', 'security'],
    ['linux', 'secret-tool'],
  ] as const)('uses only the program of the platform when every program is present (%s)', async (platform, program) => {
    const bin = binDirWith('security', 'secret-tool', 'cmdkey');
    const { run, calls } = recordingRun();
    await readWith(run, { PATH: bin, DBUS_SESSION_BUS_ADDRESS: DBUS, SystemRoot: 'C:\\Windows' }, platform);
    expect(new Set(calls.map((call) => call.file))).toEqual(new Set([path.join(bin, program)]));
  });

  it('uses the Credential Manager on Windows when every program is present', async () => {
    const bin = binDirWith('security', 'secret-tool', 'cmdkey');
    const { run, calls } = recordingRun();
    await readWith(run, { PATH: bin, DBUS_SESSION_BUS_ADDRESS: DBUS, SystemRoot: 'C:\\Windows' }, 'win32');
    expect(calls.map((call) => call.file)).toEqual([POWERSHELL]);
  });
});
