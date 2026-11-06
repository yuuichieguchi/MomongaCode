import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { listenUnix, momongaPaths, rotatedLogPath, setSocketBind } from '@momonga/foundation';

const HOME = '/Users/alice';

const expectedLayout = (home: string, cacheBase: string, keychains: string = path.join(home, 'Library', 'Keychains')) => {
  const root = path.join(home, '.momonga');
  const run = path.join(root, 'run');
  const state = path.join(root, 'state');
  return {
    root,
    settingsFile: path.join(root, 'settings.json'),
    run,
    sockets: {
      gateway: path.join(run, 'gateway.sock'),
      runtime: path.join(run, 'runtime.sock'),
      supervisor: path.join(run, 'supervisor.sock'),
    },
    locks: {
      gateway: path.join(run, 'gateway.lock'),
      runtime: path.join(run, 'runtime.lock'),
      supervisor: path.join(run, 'supervisor.lock'),
    },
    callLocks: path.join(run, 'call-locks'),
    markers: {
      root: path.join(run, 'markers'),
      tools: path.join(run, 'markers', 'tools'),
      mcp: path.join(run, 'markers', 'mcp'),
      targets: path.join(run, 'markers', 'targets'),
      daemons: path.join(run, 'markers', 'daemons'),
    },
    state,
    databases: {
      runtime: path.join(state, 'runtime.db'),
      gateway: path.join(state, 'gateway.db'),
    },
    traces: {
      dir: path.join(state, 'traces'),
      gateway: path.join(state, 'traces', 'gateway.db'),
      runtime: path.join(state, 'traces', 'runtime.db'),
    },
    gatewayKey: path.join(state, 'gateway.key'),
    probe: path.join(state, 'probe'),
    planSessions: path.join(state, 'plan-sessions'),
    planHost: path.join(state, 'plan-host.json'),
    planActive: path.join(state, 'plan-active.json'),
    logs: path.join(root, 'logs'),
    logFiles: {
      supervisor: path.join(root, 'logs', 'supervisor.log'),
      gateway: path.join(root, 'logs', 'gateway.log'),
      runtime: path.join(root, 'logs', 'runtime.log'),
    },
    projects: path.join(root, 'projects'),
    skills: path.join(root, 'skills'),
    agents: path.join(root, 'agents'),
    launcher: path.join(home, '.local', 'bin', 'momonga'),
    keychains,
    cacheBase,
    tmp: {
      root: path.join(cacheBase, 'tmp'),
      spawn: path.join(cacheBase, 'tmp', 'spawn'),
      sessions: path.join(cacheBase, 'tmp', 'sessions'),
    },
  };
};

describe('momongaPaths', () => {
  it('lays out darwin paths with the cache base under Library/Caches', () => {
    expect(momongaPaths(HOME, 'darwin', {})).toEqual(expectedLayout(HOME, '/Users/alice/Library/Caches/momonga'));
  });

  it('ignores XDG_CACHE_HOME on darwin', () => {
    expect(momongaPaths(HOME, 'darwin', { XDG_CACHE_HOME: '/xdg' }).cacheBase).toBe('/Users/alice/Library/Caches/momonga');
  });

  it('uses XDG_CACHE_HOME for the cache base on linux', () => {
    expect(momongaPaths('/home/bob', 'linux', { XDG_CACHE_HOME: '/var/cache/bob' })).toEqual(
      expectedLayout('/home/bob', '/var/cache/bob/momonga', '/home/bob/.local/share/keyrings'),
    );
  });

  it('falls back to ~/.cache on linux when XDG_CACHE_HOME is unset', () => {
    expect(momongaPaths('/home/bob', 'linux', {})).toEqual(expectedLayout('/home/bob', '/home/bob/.cache/momonga', '/home/bob/.local/share/keyrings'));
  });

  it('builds a socket path of 104 bytes without refusing it, since the limit is measured when the socket is bound', () => {
    const home = `/${'h'.repeat(74)}`;
    const socket = `${home}/.momonga/run/supervisor.sock`;
    expect(Buffer.byteLength(socket)).toBe(104);
    expect(momongaPaths(home, 'darwin', {}).sockets.supervisor).toBe(socket);
  });

  it('builds a socket path of 104 bytes counted in multibyte characters without refusing it', () => {
    const home = `/${'é'.repeat(37)}`;
    const socket = `${home}/.momonga/run/supervisor.sock`;
    expect(Buffer.byteLength(socket)).toBe(104);
    expect(momongaPaths(home, 'linux', {}).sockets.supervisor).toBe(socket);
  });

  it('refuses a too-long socket path when listenUnix binds it, with the bind probe evidence', async () => {
    const home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'mm-home-')));
    try {
      const run = momongaPaths(home, 'darwin', {}).run;
      fs.mkdirSync(run, { recursive: true, mode: 0o700 });
      fs.chmodSync(run, 0o700);
      const socket = momongaPaths(home, 'darwin', {}).sockets.supervisor;
      const limit = Buffer.byteLength(socket);
      setSocketBind(async (candidate) => {
        if (Buffer.byteLength(candidate) >= limit) throw Object.assign(new Error(`bind ${candidate}: EINVAL`), { code: 'EINVAL' });
      });
      const server = net.createServer();
      const error = await listenUnix(server, socket).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain(socket);
      expect((error as Error).message).toContain('EINVAL');
      expect((error as Error).message).toContain(String(limit));
      expect(server.listening).toBe(false);
    } finally {
      setSocketBind(undefined);
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('places the launcher link outside the momonga root on every platform', () => {
    expect(momongaPaths(HOME, 'darwin', {}).launcher).toBe('/Users/alice/.local/bin/momonga');
    expect(momongaPaths('/home/bob', 'linux', { XDG_CACHE_HOME: '/xdg' }).launcher).toBe('/home/bob/.local/bin/momonga');
  });
});

describe('relative XDG_CACHE_HOME', () => {
  it('ignores a relative XDG_CACHE_HOME on linux and falls back to ~/.cache', () => {
    expect(momongaPaths('/home/bob', 'linux', { XDG_CACHE_HOME: 'relative/cache' }).cacheBase).toBe('/home/bob/.cache/momonga');
  });

  it('ignores an empty XDG_CACHE_HOME on linux', () => {
    expect(momongaPaths('/home/bob', 'linux', { XDG_CACHE_HOME: '' }).cacheBase).toBe('/home/bob/.cache/momonga');
  });
});

describe('rotatedLogPath', () => {
  it('appends the generation to the file name', () => {
    expect(rotatedLogPath('/x/runtime.log', 1)).toBe('/x/runtime.log.1');
    expect(rotatedLogPath('/Users/alice/.momonga/logs/supervisor.log', 4)).toBe('/Users/alice/.momonga/logs/supervisor.log.4');
  });

  it('pins the darwin log files and the supervisor lock', () => {
    const paths = momongaPaths(HOME, 'darwin', {});
    expect(paths.logFiles).toEqual({
      supervisor: '/Users/alice/.momonga/logs/supervisor.log',
      gateway: '/Users/alice/.momonga/logs/gateway.log',
      runtime: '/Users/alice/.momonga/logs/runtime.log',
    });
    expect(paths.locks.supervisor).toBe('/Users/alice/.momonga/run/supervisor.lock');
    expect(paths.markers.daemons).toBe('/Users/alice/.momonga/run/markers/daemons');
  });
});
