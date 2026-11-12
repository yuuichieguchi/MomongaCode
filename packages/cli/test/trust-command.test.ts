import fs from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { trustFolder } from '../src/commands/trust.ts';
import { UsageError } from '../src/usage-error.ts';
import { startRealRuntime } from './real-runtime.ts';
import type { RealRuntime } from './real-runtime.ts';

vi.mock('../src/daemon/ensure-daemon.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/daemon/ensure-daemon.ts')>()),
  ensureCurrentDaemon: async () => ({}),
}));

const opened: RealRuntime[] = [];

afterEach(async () => {
  await Promise.all(opened.splice(0).map((runtime) => runtime.client.close()));
});

const runtimeOf = async (): Promise<RealRuntime & { folder: string }> => {
  const runtime = await startRealRuntime();
  opened.push(runtime);
  return { ...runtime, folder: await fs.promises.realpath(runtime.service.layout.project) };
};

const printed = (lines: readonly string[]): string => lines.join('');

describe('momonga trust', () => {
  it('shows an undecided folder as not decided and names the form that decides it', async () => {
    const runtime = await runtimeOf();
    expect(await trustFolder(runtime.ports, runtime.paths, {})).toBe(0);
    expect(printed(runtime.stdout)).toContain(`${runtime.folder}: not decided`);
    expect(printed(runtime.stdout)).toContain(`momonga trust ${runtime.folder} --set trusted`);
  });

  it('sets the trust of the current folder through the runtime, and shows it afterwards', async () => {
    const runtime = await runtimeOf();
    expect(await trustFolder(runtime.ports, runtime.paths, { set: 'trusted' })).toBe(0);
    expect((await runtime.client.trust(runtime.folder)).decision).toBe('trusted');
    runtime.stdout.length = 0;
    expect(await trustFolder(runtime.ports, runtime.paths, {})).toBe(0);
    expect(printed(runtime.stdout)).toContain(`${runtime.folder}: trusted`);
  });

  it('acts on the folder it is given', async () => {
    const runtime = await runtimeOf();
    const other = await fs.promises.realpath(await fs.promises.mkdtemp(`${runtime.service.layout.home}/other-`));
    expect(await trustFolder(runtime.ports, runtime.paths, { folder: other, set: 'untrusted' })).toBe(0);
    expect((await runtime.client.trust(other)).decision).toBe('untrusted');
    expect((await runtime.client.trust(runtime.folder)).decision).toBeNull();
  });

  it('clears the trust, returning the folder to undecided', async () => {
    const runtime = await runtimeOf();
    await trustFolder(runtime.ports, runtime.paths, { set: 'trusted' });
    expect(await trustFolder(runtime.ports, runtime.paths, { clear: true })).toBe(0);
    expect((await runtime.client.trust(runtime.folder)).decision).toBeNull();
  });

  it('refuses a decision it does not know, and set beside clear, with the usage exit', async () => {
    const runtime = await runtimeOf();
    await expect(trustFolder(runtime.ports, runtime.paths, { set: 'maybe' })).rejects.toBeInstanceOf(UsageError);
    await expect(trustFolder(runtime.ports, runtime.paths, { set: 'trusted', clear: true })).rejects.toBeInstanceOf(UsageError);
    expect((await runtime.client.trust(runtime.folder)).decision).toBeNull();
  });
});
