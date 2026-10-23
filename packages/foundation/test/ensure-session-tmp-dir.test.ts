import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ensureMomongaDirs, ensureSessionTmpDir, momongaPaths } from '@momonga/foundation';
import type { MomongaPaths } from '@momonga/foundation';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const makeDir = (prefix: string): string => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  tempDirs.push(dir);
  return dir;
};

const preparedPaths = async (): Promise<MomongaPaths> => {
  const paths = momongaPaths(makeDir('mm-home-'), 'darwin', {});
  await ensureMomongaDirs(paths);
  return paths;
};

describe('ensureSessionTmpDir', () => {
  it('creates the session dir under tmp.sessions with mode 0700 and returns it', async () => {
    const paths = await preparedPaths();
    const dir = await ensureSessionTmpDir(paths, 'session-1');
    const expected = path.join(paths.tmp.sessions, 'session-1');
    expect(fs.realpathSync(dir)).toBe(fs.realpathSync(expected));
    const stat = fs.lstatSync(expected);
    expect(stat.isDirectory()).toBe(true);
    expect(stat.mode & 0o777).toBe(0o700);
  });

  it('is idempotent and keeps existing contents', async () => {
    const paths = await preparedPaths();
    const first = await ensureSessionTmpDir(paths, 'session-1');
    fs.writeFileSync(path.join(first, 'keep'), 'kept');
    const second = await ensureSessionTmpDir(paths, 'session-1');
    expect(second).toBe(first);
    expect(fs.readFileSync(path.join(second, 'keep'), 'utf8')).toBe('kept');
  });

  it('refuses a symlink at the session dir path and leaves its target untouched', async () => {
    const paths = await preparedPaths();
    const outside = makeDir('mm-outside-');
    fs.chmodSync(outside, 0o755);
    fs.symlinkSync(outside, path.join(paths.tmp.sessions, 'session-1'));
    await expect(ensureSessionTmpDir(paths, 'session-1')).rejects.toThrow();
    expect(fs.statSync(outside).mode & 0o777).toBe(0o755);
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  it('refuses a session id that escapes the sessions root', async () => {
    const paths = await preparedPaths();
    await expect(ensureSessionTmpDir(paths, '../escaped')).rejects.toThrow();
    expect(fs.existsSync(path.join(paths.tmp.root, 'escaped'))).toBe(false);
  });

  it('refuses a session id that names a nested path', async () => {
    const paths = await preparedPaths();
    await expect(ensureSessionTmpDir(paths, 'a/b')).rejects.toThrow();
    expect(fs.existsSync(path.join(paths.tmp.sessions, 'a'))).toBe(false);
  });

  it('refuses the sessions root itself', async () => {
    const paths = await preparedPaths();
    await expect(ensureSessionTmpDir(paths, '.')).rejects.toThrow();
    await expect(ensureSessionTmpDir(paths, '')).rejects.toThrow();
  });

  it('refuses a session dir whose canonical path leaves the canonical sessions root through a symlinked parent', async () => {
    const paths = await preparedPaths();
    const outside = makeDir('mm-outside-');
    fs.symlinkSync(outside, path.join(paths.tmp.sessions, 'link'));
    await expect(ensureSessionTmpDir(paths, 'link/session-1')).rejects.toThrow();
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  it('refuses a sessions root that is a symlink to another dir', async () => {
    const paths = await preparedPaths();
    const outside = makeDir('mm-outside-');
    fs.rmSync(paths.tmp.sessions, { recursive: true });
    fs.symlinkSync(outside, paths.tmp.sessions);
    await expect(ensureSessionTmpDir(paths, 'session-1')).rejects.toThrow();
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  it('tightens an existing session dir from 0755 to 0700', async () => {
    const paths = await preparedPaths();
    const dir = path.join(paths.tmp.sessions, 'session-1');
    fs.mkdirSync(dir, { mode: 0o755 });
    fs.chmodSync(dir, 0o755);
    await ensureSessionTmpDir(paths, 'session-1');
    expect(fs.lstatSync(dir).mode & 0o777).toBe(0o700);
  });
});
