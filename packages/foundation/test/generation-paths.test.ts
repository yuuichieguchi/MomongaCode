import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SocketPathUnsupportedError, ensureMomongaDirs, generationLayout, momongaPaths, refuseUnfitGenerationSocketsBeforeCreation, setSocketBind } from '@momonga/foundation';
import { createTempDir, removeTempDir } from '@momonga/testkit';

const UNIX_ENDPOINTS = { form: 'unix' } as const;

const REALISTIC_HOME = '/Users/alexandra-wilkinson';

describe('generation-scoped sockets and locks', () => {
  it('puts every socket and lock of generation 1 under run/g1', () => {
    expect(generationLayout(REALISTIC_HOME, 1, 'darwin')).toEqual({
      generation: 1,
      dir: '/Users/alexandra-wilkinson/.momonga/run/g1',
      sockets: {
        gateway: '/Users/alexandra-wilkinson/.momonga/run/g1/gateway.sock',
        runtime: '/Users/alexandra-wilkinson/.momonga/run/g1/runtime.sock',
        supervisor: '/Users/alexandra-wilkinson/.momonga/run/g1/supervisor.sock',
      },
      locks: {
        gateway: '/Users/alexandra-wilkinson/.momonga/run/g1/gateway.lock',
        runtime: '/Users/alexandra-wilkinson/.momonga/run/g1/runtime.lock',
        supervisor: '/Users/alexandra-wilkinson/.momonga/run/g1/supervisor.lock',
      },
      settingsApplied: '/Users/alexandra-wilkinson/.momonga/run/g1/settings-applied.json',
      startRecord: '/Users/alexandra-wilkinson/.momonga/run/g1/start.json',
      startingLock: '/Users/alexandra-wilkinson/.momonga/run/g1/starting.lock',
      markers: '/Users/alexandra-wilkinson/.momonga/run/markers/g1',
      stopRecord: '/Users/alexandra-wilkinson/.momonga/run/g1/stop-values.json',
    });
  });

  it('puts a two-digit generation under its own directory', () => {
    const layout = generationLayout('/home/bob', 12, 'linux');
    expect(layout.dir).toBe('/home/bob/.momonga/run/g12');
    expect(layout.sockets.supervisor).toBe('/home/bob/.momonga/run/g12/supervisor.sock');
    expect(layout.locks.runtime).toBe('/home/bob/.momonga/run/g12/runtime.lock');
  });

  it('keeps the longest socket of a realistic darwin home far under the 104-byte limit', () => {
    expect(Buffer.byteLength(generationLayout(REALISTIC_HOME, 1, 'darwin').sockets.supervisor)).toBe(58);
    expect(Buffer.byteLength(generationLayout(REALISTIC_HOME, 99, 'darwin').sockets.supervisor)).toBe(59);
  });

  it('gives two generations distinct named pipes on win32', () => {
    const scope = { form: 'pipe', token: '0123456789abcdef0123456789abcdef' } as const;
    const first = generationLayout('C:\\Users\\alice', 1, 'win32', scope);
    const second = generationLayout('C:\\Users\\alice', 2, 'win32', scope);
    for (const role of ['gateway', 'runtime', 'supervisor'] as const) {
      expect(first.sockets[role]).toMatch(/^\\\\\.\\pipe\\/);
      expect(first.sockets[role]).toContain('g1');
      expect(second.sockets[role]).toContain('g2');
      expect(first.sockets[role]).not.toBe(second.sockets[role]);
    }
    expect(first.locks.supervisor).toBe(path.win32.join('C:\\Users\\alice', '.momonga', 'run', 'g1', 'supervisor.lock'));
  });
});

describe('refuseUnfitGenerationSocketsBeforeCreation', () => {
  const temporaryHome = (): string => createTempDir({ asHome: true });

  it('probes, before run/g<N> exists, a path in run as long as the longest socket path of that generation', async () => {
    const home = temporaryHome();
    const probed: string[] = [];
    try {
      const paths = momongaPaths(home, 'darwin', {});
      await ensureMomongaDirs(paths);
      setSocketBind(async (candidate) => {
        probed.push(candidate);
      });
      await refuseUnfitGenerationSocketsBeforeCreation(paths, 3, UNIX_ENDPOINTS);
      const dir = path.join(home, '.momonga', 'run', 'g3');
      expect(fs.existsSync(dir)).toBe(false);
      expect(probed.map((candidate) => path.dirname(candidate))).toEqual([paths.run]);
      expect(probed.map((candidate) => Buffer.byteLength(candidate))).toEqual([
        Math.max(...['gateway.sock', 'runtime.sock', 'supervisor.sock'].map((name) => Buffer.byteLength(path.join(dir, name)))),
      ]);
    } finally {
      setSocketBind(undefined);
      await removeTempDir(home);
    }
  });

  it('refuses a generation whose socket path the kernel cannot bind with SocketPathUnsupportedError', async () => {
    const home = temporaryHome();
    try {
      const paths = momongaPaths(home, 'darwin', {});
      await ensureMomongaDirs(paths);
      setSocketBind(async () => {
        throw Object.assign(new Error('bind: ENAMETOOLONG'), { code: 'ENAMETOOLONG' });
      });
      const error = await refuseUnfitGenerationSocketsBeforeCreation(paths, 1, UNIX_ENDPOINTS).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(SocketPathUnsupportedError);
      expect((error as Error).message).toContain(path.join(home, '.momonga', 'run', 'g1'));
      expect((error as Error).message).toMatch(/must be shorter than \d+ bytes/);
    } finally {
      setSocketBind(undefined);
      await removeTempDir(home);
    }
  });
});
