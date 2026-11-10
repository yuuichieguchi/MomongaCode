import fs from 'node:fs';
import type net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { FIRST_GENERATION, assertSocketPathLength, ensureMomongaDirs, generationLayout, ensureSessionTmpDir, isPipePath, listenUnix, momongaLayout, momongaPaths, pipePathFor } from '@momonga/foundation';
import { realProcessTestSignal } from '@momonga/testkit';
import type { CommandRunner } from '@momonga/foundation';

describe('win32 layout', () => {
  const home = 'C:\\Users\\Alice';
  const env = { LOCALAPPDATA: 'C:\\Users\\Alice\\AppData\\Local', APPDATA: 'C:\\Users\\Alice\\AppData\\Roaming' };
  const paths = momongaLayout(home, 'win32', env);
  const first = generationLayout(home, FIRST_GENERATION, 'win32');

  it('uses windows separators and per-user locations', () => {
    expect(paths.root).toBe('C:\\Users\\Alice\\.momonga');
    expect(first.locks.runtime).toBe('C:\\Users\\Alice\\.momonga\\run\\g1\\runtime.lock');
    expect(paths.cacheBase).toBe('C:\\Users\\Alice\\AppData\\Local\\momonga');
    expect(paths.keychains).toBe('C:\\Users\\Alice\\AppData\\Roaming\\Microsoft\\Credentials');
  });

  it('falls back to the profile when the environment gives no absolute location', () => {
    const fallback = momongaLayout(home, 'win32', { LOCALAPPDATA: 'relative', APPDATA: '' });
    expect(fallback.cacheBase).toBe('C:\\Users\\Alice\\AppData\\Local\\momonga');
    expect(fallback.keychains).toBe('C:\\Users\\Alice\\AppData\\Roaming\\Microsoft\\Credentials');
  });

  it('names the endpoints as named pipes scoped by the home directory, ignoring case', () => {
    expect(first.sockets.runtime).toMatch(/^\\\\\.\\pipe\\momonga-[0-9a-f]{16}-g1-runtime$/);
    expect(new Set(Object.values(first.sockets)).size).toBe(3);
    expect(generationLayout('c:\\users\\alice', FIRST_GENERATION, 'win32').sockets.runtime).toBe(first.sockets.runtime);
    expect(generationLayout('C:\\Users\\Bob', FIRST_GENERATION, 'win32').sockets.runtime).not.toBe(first.sockets.runtime);
  });

  it('accepts the pipe names through momongaPaths', () => {
    expect(() => momongaPaths(home, 'win32', env)).not.toThrow();
  });
});

describe('linux layout', () => {
  it('keeps secrets under XDG_DATA_HOME when it is absolute', () => {
    expect(momongaLayout('/home/bob', 'linux', { XDG_DATA_HOME: '/data' }).keychains).toBe('/data/keyrings');
    expect(momongaLayout('/home/bob', 'linux', { XDG_DATA_HOME: 'data' }).keychains).toBe('/home/bob/.local/share/keyrings');
  });
});

describe('pipe path limits', () => {
  it('limits pipe paths to 256 characters whatever the platform', () => {
    expect(isPipePath(pipePathFor('C:\\h', 'x'))).toBe(true);
    expect(() => assertSocketPathLength(`\\\\.\\pipe\\${'p'.repeat(247)}`)).not.toThrow();
    expect(() => assertSocketPathLength(`\\\\.\\pipe\\${'p'.repeat(248)}`)).toThrow(/256/);
  });
});

describe('listening on a named pipe', () => {
  const fakeServer = (outcome: 'listening' | NodeJS.ErrnoException): { server: net.Server; listened: string[] } => {
    const listened: string[] = [];
    const emitter = new EventEmitter();
    const server = Object.assign(emitter, {
      listen: (target: string, callback: () => void) => {
        listened.push(target);
        if (outcome === 'listening') callback();
        else emitter.emit('error', outcome);
        return emitter;
      },
    }) as unknown as net.Server;
    return { server, listened };
  };

  it('binds the pipe without touching the filesystem', async () => {
    const pipe = pipePathFor('C:\\Users\\Alice', 'gateway');
    const { server, listened } = fakeServer('listening');
    await listenUnix(server, pipe, undefined, realProcessTestSignal());
    expect(listened).toEqual([pipe]);
  });

  it('reports a second server on the same pipe as already in use', async () => {
    const pipe = pipePathFor('C:\\Users\\Alice', 'gateway');
    const { server } = fakeServer(Object.assign(new Error('EADDRINUSE'), { code: 'EADDRINUSE' }));
    await expect(listenUnix(server, pipe, undefined, realProcessTestSignal())).rejects.toThrow(`${pipe} is already in use by a live server`);
  });

  it('propagates other bind failures unchanged', async () => {
    const pipe = pipePathFor('C:\\Users\\Alice', 'gateway');
    const { server } = fakeServer(Object.assign(new Error('EACCES'), { code: 'EACCES' }));
    await expect(listenUnix(server, pipe, undefined, realProcessTestSignal())).rejects.toThrow('EACCES');
  });
});

describe('windows private directories', () => {
  const report = (overrides: Record<string, unknown> = {}): string =>
    JSON.stringify({ owner: 'S-1-5-21-1', me: 'S-1-5-21-1', system: 'S-1-5-18', administrators: 'S-1-5-32-544', foreign: [], ...overrides });

  const win32Layout = (root: string) => {
    const paths = momongaLayout(root, 'win32', { LOCALAPPDATA: `${root}\\AppData\\Local` });
    return paths;
  };

  it('checks the ACL of the state root and the cache root once each and leaves a private tree alone', async () => {
    const scripts: string[] = [];
    const run: CommandRunner = async (_file, args) => {
      scripts.push(Buffer.from(args[args.length - 1] as string, 'base64').toString('utf16le'));
      return { exitCode: 0, stdout: report(), stderr: '' };
    };
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'momonga-win-'));
    try {
      const layout = momongaLayout(base, 'darwin', {});
      await ensureMomongaDirs(layout, { platform: 'win32', run, env: { SystemRoot: 'C:\\Windows' } });
      expect(scripts).toHaveLength(2);
      expect(scripts.every((script) => script.includes('GetAccessRules'))).toBe(true);
      expect(scripts.some((script) => script.includes('Set-Acl'))).toBe(false);
      expect(scripts[0]).toContain(layout.root);
      expect(scripts[1]).toContain(layout.cacheBase);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
    expect(win32Layout('C:\\Users\\Alice').root).toBe('C:\\Users\\Alice\\.momonga');
  });

  it('restricts a tree that grants access to other principals and verifies the result', async () => {
    const scripts: string[] = [];
    const reports = [report({ foreign: ['S-1-1-0'] }), report(), report({ foreign: ['S-1-1-0'] }), report()];
    const run: CommandRunner = async (_file, args) => {
      scripts.push(Buffer.from(args[args.length - 1] as string, 'base64').toString('utf16le'));
      return { exitCode: 0, stdout: reports.shift() as string, stderr: '' };
    };
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'momonga-win-'));
    try {
      await ensureMomongaDirs(momongaLayout(base, 'darwin', {}), { platform: 'win32', run, env: { SystemRoot: 'C:\\Windows' } });
      expect(scripts.filter((script) => script.includes('Set-Acl'))).toHaveLength(2);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it('fails when the restricted tree still grants access to another principal', async () => {
    const run: CommandRunner = async () => ({ exitCode: 0, stdout: report({ foreign: ['S-1-1-0'] }), stderr: '' });
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'momonga-win-'));
    try {
      await expect(ensureMomongaDirs(momongaLayout(base, 'darwin', {}), { platform: 'win32', run, env: { SystemRoot: 'C:\\Windows' } })).rejects.toThrow('S-1-1-0');
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it('refuses a tree owned by someone else', async () => {
    const run: CommandRunner = async () => ({ exitCode: 0, stdout: report({ owner: 'S-1-5-21-2' }), stderr: '' });
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'momonga-win-'));
    try {
      await expect(ensureMomongaDirs(momongaLayout(base, 'darwin', {}), { platform: 'win32', run, env: { SystemRoot: 'C:\\Windows' } })).rejects.toThrow('owned by S-1-5-21-2');
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
});

describe('windows session temporary directories', () => {
  const withSessions = async (body: (layout: ReturnType<typeof momongaLayout>, base: string) => Promise<void>): Promise<void> => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'momonga-win-'));
    try {
      const layout = momongaLayout(base, 'darwin', {});
      fs.mkdirSync(layout.tmp.sessions, { recursive: true });
      await body(layout, base);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  };

  it('creates the session directory directly under the sessions root', async () => {
    await withSessions(async (layout) => {
      const { dir: directory } = await ensureSessionTmpDir(layout, 'abc', { platform: 'win32' });
      expect(directory).toBe(path.join(layout.tmp.sessions, 'abc'));
      expect(fs.statSync(directory).isDirectory()).toBe(true);
      expect((await ensureSessionTmpDir(layout, 'abc', { platform: 'win32' })).dir).toBe(directory);
    });
  });

  it('refuses a session directory that is a link', async () => {
    await withSessions(async (layout, base) => {
      fs.symlinkSync(base, path.join(layout.tmp.sessions, 'linked'));
      await expect(ensureSessionTmpDir(layout, 'linked', { platform: 'win32' })).rejects.toThrow('link or not a directory');
    });
  });

  it('refuses a sessions root that is a link', async () => {
    await withSessions(async (layout, base) => {
      fs.rmSync(layout.tmp.sessions, { recursive: true });
      fs.symlinkSync(base, layout.tmp.sessions);
      await expect(ensureSessionTmpDir(layout, 'abc', { platform: 'win32' })).rejects.toThrow('missing, a link');
    });
  });

  it('rejects session ids that carry separators of either style', async () => {
    await withSessions(async (layout) => {
      await expect(ensureSessionTmpDir(layout, '..\\x', { platform: 'win32' })).rejects.toThrow('invalid session id');
    });
  });
});
