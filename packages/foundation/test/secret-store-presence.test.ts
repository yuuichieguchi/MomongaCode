import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createPlatformSecretStore } from '@momonga/foundation';
import type { SecretProcessPort } from '@momonga/foundation';

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
    return { exitCode: 0, stdout: 'fake-secret', stderr: '' };
  };
  return { run, calls };
};

const SIGNAL = new AbortController().signal;
const DBUS = 'unix:path=/run/user/1000/bus';

const readWith = async (run: SecretProcessPort, env: Record<string, string | undefined>): Promise<string> =>
  createPlatformSecretStore(run, env).read('anthropic', SIGNAL);

describe('secret store chosen by tool and service presence (B13)', () => {
  it('uses the Keychain through the security program found on PATH', async () => {
    const bin = binDirWith('security');
    const { run, calls } = recordingRun();
    expect(await readWith(run, { PATH: bin })).toBe('fake-secret');
    expect(calls).toEqual([{ file: path.join(bin, 'security'), args: ['find-generic-password', '-s', 'momonga', '-a', 'anthropic', '-w'] }]);
  });

  it('uses the Secret Service through secret-tool found on PATH when a D-Bus session is present', async () => {
    const bin = binDirWith('secret-tool');
    const { run, calls } = recordingRun();
    expect(await readWith(run, { PATH: bin, DBUS_SESSION_BUS_ADDRESS: DBUS })).toBe('fake-secret');
    expect(calls).toEqual([{ file: path.join(bin, 'secret-tool'), args: ['lookup', 'service', 'momonga', 'account', 'anthropic'] }]);
  });

  it('does not use secret-tool without a D-Bus session and says the session is missing', async () => {
    const bin = binDirWith('secret-tool');
    const { run, calls } = recordingRun();
    const error = await readWith(run, { PATH: bin }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('secret-tool');
    expect((error as Error).message).toContain('D-Bus');
    expect(calls).toEqual([]);
  });

  it('names every store it tried when none is present', async () => {
    const bin = binDirWith();
    const { run, calls } = recordingRun();
    const error = await readWith(run, { PATH: bin }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain('security');
    expect(message).toContain('secret-tool');
    expect(message).toContain('Credential Manager');
    expect(message).toContain('cmdkey');
    expect(calls).toEqual([]);
  });

  it('does not depend on the platform name: the same PATH gives the same store', async () => {
    const bin = binDirWith('secret-tool');
    const first = recordingRun();
    const second = recordingRun();
    await readWith(first.run, { PATH: bin, DBUS_SESSION_BUS_ADDRESS: DBUS });
    await readWith(second.run, { PATH: bin, DBUS_SESSION_BUS_ADDRESS: DBUS });
    expect(first.calls).toEqual(second.calls);
    expect(first.calls[0]?.file).toBe(path.join(bin, 'secret-tool'));
  });
  const POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
  const decodedScript = (args: readonly string[]): string => Buffer.from(args[4] ?? '', 'base64').toString('utf16le');

  it('uses the Credential Manager through PowerShell when cmdkey is found on PATH', async () => {
    const bin = binDirWith('cmdkey');
    const { run, calls } = recordingRun();
    expect(await readWith(run, { PATH: bin, SystemRoot: 'C:\\Windows' })).toBe('fake-secret');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.file).toBe(POWERSHELL);
    expect(calls[0]?.args.slice(0, 4)).toEqual(['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand']);
    expect(decodedScript(calls[0]?.args ?? [])).toContain("'momonga/anthropic'");
    expect(decodedScript(calls[0]?.args ?? [])).toContain('CredReadW');
  });

  it('writes to the Credential Manager through PowerShell with the value on stdin when cmdkey is found on PATH', async () => {
    const bin = binDirWith('cmdkey');
    const calls: { file: string; args: readonly string[]; stdin: string }[] = [];
    const run: SecretProcessPort = async (file, args, stdin) => {
      calls.push({ file, args, stdin });
      return { exitCode: 0, stdout: '', stderr: '' };
    };
    await createPlatformSecretStore(run, { PATH: bin, SystemRoot: 'C:\\Windows' }).write('anthropic', 'value-to-store', SIGNAL);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.file).toBe(POWERSHELL);
    expect(decodedScript(calls[0]?.args ?? [])).toContain('CredWrite');
    expect(decodedScript(calls[0]?.args ?? [])).toContain("'momonga/anthropic'");
    expect(decodedScript(calls[0]?.args ?? [])).not.toContain('value-to-store');
    expect(calls[0]?.stdin).toBe('value-to-store');
  });

  it('prefers the Keychain when security, secret-tool with D-Bus, and cmdkey are all present', async () => {
    const bin = binDirWith('security', 'secret-tool', 'cmdkey');
    const { run, calls } = recordingRun();
    await readWith(run, { PATH: bin, DBUS_SESSION_BUS_ADDRESS: DBUS, SystemRoot: 'C:\\Windows' });
    expect(calls.map((call) => call.file)).toEqual([path.join(bin, 'security')]);
  });

  it('prefers the Secret Service over the Credential Manager when secret-tool has a D-Bus session', async () => {
    const bin = binDirWith('secret-tool', 'cmdkey');
    const { run, calls } = recordingRun();
    await readWith(run, { PATH: bin, DBUS_SESSION_BUS_ADDRESS: DBUS, SystemRoot: 'C:\\Windows' });
    expect(calls.map((call) => call.file)).toEqual([path.join(bin, 'secret-tool')]);
  });

  it('falls to the Credential Manager when secret-tool has no D-Bus session and cmdkey is present', async () => {
    const bin = binDirWith('secret-tool', 'cmdkey');
    const { run, calls } = recordingRun();
    await readWith(run, { PATH: bin, SystemRoot: 'C:\\Windows' });
    expect(calls.map((call) => call.file)).toEqual([POWERSHELL]);
  });
});
