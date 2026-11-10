import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionTmpDirError, ensureMomongaDirs, ensureSessionTmpDir, momongaPaths } from '@momonga/foundation';
import type { MomongaPaths } from '@momonga/foundation';

const tempDirs: string[] = [];
const lockedDirs: string[] = [];
const RUNNING_AS_ROOT = process.getuid?.() === 0;

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of lockedDirs.splice(0)) fs.chmodSync(dir, 0o700);
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
    const { dir } = await ensureSessionTmpDir(paths, 'session-1');
    const expected = path.join(paths.tmp.sessions, 'session-1');
    expect(fs.realpathSync(dir)).toBe(fs.realpathSync(expected));
    const stat = fs.lstatSync(expected);
    expect(stat.isDirectory()).toBe(true);
    expect(stat.mode & 0o777).toBe(0o700);
  });

  it('is idempotent and keeps existing contents', async () => {
    const paths = await preparedPaths();
    const { dir: first } = await ensureSessionTmpDir(paths, 'session-1');
    fs.writeFileSync(path.join(first, 'keep'), 'kept');
    const { dir: second } = await ensureSessionTmpDir(paths, 'session-1');
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

const rejectionOf = async (promise: Promise<unknown>): Promise<unknown> => {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected ensureSessionTmpDir to reject');
};

describe('ensureSessionTmpDir error classes', () => {
  it('a session dir replaced by a symlink throws SessionTmpDirError', async () => {
    const paths = await preparedPaths();
    const outside = makeDir('mm-outside-');
    fs.symlinkSync(outside, path.join(paths.tmp.sessions, 'session-1'));
    const error = await rejectionOf(ensureSessionTmpDir(paths, 'session-1'));
    expect(error).toBeInstanceOf(SessionTmpDirError);
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  it('a sessions root replaced by a symlink throws SessionTmpDirError', async () => {
    const paths = await preparedPaths();
    const outside = makeDir('mm-outside-');
    fs.rmSync(paths.tmp.sessions, { recursive: true });
    fs.symlinkSync(outside, paths.tmp.sessions);
    const error = await rejectionOf(ensureSessionTmpDir(paths, 'session-1'));
    expect(error).toBeInstanceOf(SessionTmpDirError);
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  it('a session dir replaced by a file throws SessionTmpDirError', async () => {
    const paths = await preparedPaths();
    fs.writeFileSync(path.join(paths.tmp.sessions, 'session-1'), 'x');
    const error = await rejectionOf(ensureSessionTmpDir(paths, 'session-1'));
    expect(error).toBeInstanceOf(SessionTmpDirError);
  });

  it('a session dir that is not directly in the sessions root throws SessionTmpDirError', async () => {
    const paths = await preparedPaths();
    const directory = path.join(paths.tmp.sessions, 'session-1');
    fs.mkdirSync(directory, { mode: 0o700 });
    const elsewhere = makeDir('mm-elsewhere-');
    const alias = path.join(elsewhere, 'alias');
    fs.symlinkSync(directory, alias);
    const realRealpath = fsp.realpath;
    vi.spyOn(fsp, 'realpath').mockImplementation((async (target: fs.PathLike, options?: unknown) =>
      String(target) === directory ? alias : realRealpath(target, options as never)) as typeof fsp.realpath);
    const error = await rejectionOf(ensureSessionTmpDir(paths, 'session-1'));
    expect(error).toBeInstanceOf(SessionTmpDirError);
    expect((error as Error).message).toBe(`${directory} does not live directly in the sessions root ${paths.tmp.sessions}`);
  });

  it.skipIf(RUNNING_AS_ROOT)('a sessions root with mode 000 throws a plain errno error (EACCES), not SessionTmpDirError', async () => {
    const paths = await preparedPaths();
    fs.chmodSync(paths.tmp.sessions, 0o000);
    lockedDirs.push(paths.tmp.sessions);
    const error = await rejectionOf(ensureSessionTmpDir(paths, 'session-1'));
    expect(error).not.toBeInstanceOf(SessionTmpDirError);
    expect((error as NodeJS.ErrnoException).code).toBe('EACCES');
  });

  it('an invalid session id throws a plain Error, not SessionTmpDirError', async () => {
    const paths = await preparedPaths();
    const error = await rejectionOf(ensureSessionTmpDir(paths, '../escaped'));
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(SessionTmpDirError);
    expect((error as Error).message).toBe('invalid session id: "../escaped"');
  });
});
