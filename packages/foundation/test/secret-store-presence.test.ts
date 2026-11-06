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
});
