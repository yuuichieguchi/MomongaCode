import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SOCKET_PATH_LIMIT, assertSocketPathLength, momongaPaths, rotatedLogPath } from '@momonga/foundation';

const HOME = '/Users/alice';

const expectedLayout = (home: string, cacheBase: string) => {
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
      fm: path.join(run, 'fm.sock'),
      supervisor: path.join(run, 'supervisor.sock'),
    },
    locks: {
      gateway: path.join(run, 'gateway.lock'),
      runtime: path.join(run, 'runtime.lock'),
      supervisor: path.join(run, 'supervisor.lock'),
    },
    markers: {
      root: path.join(run, 'markers'),
      tools: path.join(run, 'markers', 'tools'),
      mcp: path.join(run, 'markers', 'mcp'),
      fm: path.join(run, 'markers', 'fm'),
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
    logs: path.join(root, 'logs'),
    logFiles: {
      supervisor: path.join(root, 'logs', 'supervisor.log'),
      gateway: path.join(root, 'logs', 'gateway.log'),
      runtime: path.join(root, 'logs', 'runtime.log'),
    },
    projects: path.join(root, 'projects'),
    skills: path.join(root, 'skills'),
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
      expectedLayout('/home/bob', '/var/cache/bob/momonga'),
    );
  });

  it('falls back to ~/.cache on linux when XDG_CACHE_HOME is unset', () => {
    expect(momongaPaths('/home/bob', 'linux', {})).toEqual(expectedLayout('/home/bob', '/home/bob/.cache/momonga'));
  });

  it('accepts a home whose longest socket path is 103 bytes', () => {
    const home = `/${'h'.repeat(73)}`;
    const paths = momongaPaths(home, 'darwin', {});
    expect(Buffer.byteLength(paths.sockets.supervisor)).toBe(103);
  });

  it('throws naming the socket path and its length when a socket path reaches 104 bytes', () => {
    const home = `/${'h'.repeat(74)}`;
    const socket = `${home}/.momonga/run/supervisor.sock`;
    expect(Buffer.byteLength(socket)).toBe(104);
    expect(() => momongaPaths(home, 'darwin', {})).toThrow(socket);
    expect(() => momongaPaths(home, 'darwin', {})).toThrow(/104/);
  });

  it('counts bytes rather than characters for the socket limit', () => {
    const home = `/${'é'.repeat(37)}`;
    expect(Buffer.byteLength(`${home}/.momonga/run/supervisor.sock`)).toBe(104);
    expect(() => momongaPaths(home, 'darwin', {})).toThrow(/104/);
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

describe('socket path limit', () => {
  it('is 104 bytes', () => {
    expect(SOCKET_PATH_LIMIT).toBe(104);
  });

  it('accepts a 103-byte path', () => {
    expect(() => assertSocketPathLength(`/${'s'.repeat(102)}`)).not.toThrow();
  });

  it('rejects a 104-byte path naming the path and its length', () => {
    const socket = `/${'s'.repeat(103)}`;
    expect(() => assertSocketPathLength(socket)).toThrow(socket);
    expect(() => assertSocketPathLength(socket)).toThrow(/104/);
  });

  it('counts bytes rather than characters', () => {
    const socket = `/${'\u00e9'.repeat(52)}`;
    expect(Buffer.byteLength(socket)).toBe(105);
    expect(() => assertSocketPathLength(socket)).toThrow(/105/);
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
