import { afterEach, describe, expect, it, vi } from 'vitest';
import { withTempDir } from '@momonga/testkit';
import type * as TerminalWriter from '../src/terminal-writer.ts';
import type * as KeeperAsset from '../../foundation/src/platform/windows-keeper-asset.ts';
import type * as GroupPort from '../../foundation/src/platform/group-port.ts';
import { ensureBundledWindowsKeeper } from '../../foundation/src/platform/windows-keeper-asset.ts';
import { hostKeeperHost } from '../../foundation/src/platform/windows-keeper-host.ts';
import { runMain } from '../src/run-main.ts';
import { terminalSink } from '../src/terminal-writer.ts';

const { KEEPER_FILE, MANIFEST_ASSET } = vi.hoisted(() => ({ KEEPER_FILE: 'C:\\cache\\momonga-keeper.exe', MANIFEST_ASSET: 'momonga-keeper-manifest' }));

vi.mock('node:sea', () => ({
  isSea: () => true,
  getAssetKeys: () => [MANIFEST_ASSET],
  getRawAsset: () => new TextEncoder().encode(JSON.stringify({ target: 'win-x64', binary: { asset: 'momonga-keeper.exe', sha256: 'a'.repeat(64), size: 1, name: 'momonga-keeper.exe' } })).buffer,
}));

vi.mock('../../foundation/src/platform/windows-keeper-asset.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof KeeperAsset>();
  return { ...actual, WINDOWS_KEEPER_MANIFEST_ASSET: MANIFEST_ASSET, ensureBundledWindowsKeeper: vi.fn(async () => KEEPER_FILE), checkedWindowsKeeper: (file: string) => () => file };
});

vi.mock('../../foundation/src/platform/group-port.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof GroupPort>();
  const port = { ...actual.hostProcessGroupPort(), keeper: { open: async () => Promise.reject(new Error('no command group is launched in this test')) } };
  return { ...actual, hostProcessGroupPort: () => port };
});

vi.mock('../src/terminal-writer.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof TerminalWriter>();
  return { ...actual, terminalSink: vi.fn(actual.terminalSink) };
});

const initialExitCode = process.exitCode;
const initialArgv = process.argv;
const initialInterruptListeners = process.listeners('SIGINT');

afterEach(() => {
  process.exitCode = initialExitCode;
  process.argv = initialArgv;
  for (const listener of process.listeners('SIGINT')) if (!initialInterruptListeners.includes(listener)) process.off('SIGINT', listener);
  vi.restoreAllMocks();
});

describe('runMain', () => {
  it('reports a failure through the terminal sink, escaped, and exits 1', async () => {
    const written: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array): boolean => {
      written.push(String(chunk));
      return true;
    });

    await runMain('1.2.3', {
      get self(): never {
        throw new Error('boom \u001b[31mred');
      },
    });

    expect(vi.mocked(terminalSink)).toHaveBeenCalledTimes(1);
    expect(written).toHaveLength(1);
    expect(written[0]).toMatch(/^momonga: .*boom .*red\n$/);
    expect(written[0]).not.toContain('\u001b');
    expect(process.exitCode).toBe(1);
  });

  it('a command that launches no command group does not extract the keeper; the first launches share one extraction, and a failed one is tried again (win32)', async (context) => {
    const extract = vi.mocked(ensureBundledWindowsKeeper);
    extract.mockClear();
    vi.spyOn(process.stdout, 'write').mockImplementation((): boolean => true);
    vi.spyOn(process.stderr, 'write').mockImplementation((): boolean => true);
    process.argv = [process.execPath, 'momonga', 'daemon', 'status'];

    await runMain('1.2.3', { home: withTempDir(context, { asHome: true }) });

    expect(extract).not.toHaveBeenCalled();

    extract.mockRejectedValueOnce(new Error('the executables area is full'));
    await expect(hostKeeperHost().executable()).rejects.toThrow('the executables area is full');
    expect(await Promise.all([hostKeeperHost().executable(), hostKeeperHost().executable()])).toEqual([KEEPER_FILE, KEEPER_FILE]);
    expect(await hostKeeperHost().executable()).toBe(KEEPER_FILE);
    expect(extract).toHaveBeenCalledTimes(2);
  });
});
