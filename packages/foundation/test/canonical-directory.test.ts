import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { canonicalDirectory } from '@momonga/foundation';

const tempDirs: string[] = [];
const lockedDirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of lockedDirs.splice(0)) fs.chmodSync(dir, 0o700);
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const makeDir = (): string => {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'mm-cdir-')));
  tempDirs.push(dir);
  return dir;
};

const caseInsensitiveTempVolume = (): boolean => {
  const probe = path.join(makeDir(), 'CaseProbe');
  fs.mkdirSync(probe);
  try {
    return fs.statSync(probe).ino === fs.statSync(path.join(path.dirname(probe), 'caseprobe')).ino;
  } catch {
    return false;
  }
};

const CASE_INSENSITIVE = caseInsensitiveTempVolume();
const RUNNING_AS_ROOT = process.getuid?.() === 0;

const lock = (dir: string): void => {
  fs.chmodSync(dir, 0o000);
  lockedDirs.push(dir);
};

describe('canonicalDirectory', () => {
  it.runIf(CASE_INSENSITIVE)('returns the native true-case path for a case variant', () => {
    const root = makeDir();
    const project = path.join(root, 'Work', 'Project');
    fs.mkdirSync(project, { recursive: true });
    expect(canonicalDirectory(path.join(root, 'WORK', 'project'))).toEqual({ ok: true, path: project });
  });

  it('returns the canonical path of a symlinked directory', () => {
    const root = makeDir();
    const real = path.join(root, 'real');
    fs.mkdirSync(real);
    const link = path.join(root, 'link');
    fs.symlinkSync(real, link, 'dir');
    expect(canonicalDirectory(link)).toEqual({ ok: true, path: real });
  });

  it('returns an existing canonical directory unchanged', () => {
    const root = makeDir();
    expect(canonicalDirectory(root)).toEqual({ ok: true, path: root });
  });

  it('rejects a relative path with "must be an absolute path"', () => {
    expect(canonicalDirectory('relative/dir')).toEqual({ ok: false, code: 'not_absolute', reason: 'must be an absolute path' });
  });

  it('rejects a missing path with "does not exist"', () => {
    const root = makeDir();
    expect(canonicalDirectory(path.join(root, 'missing', 'deeper'))).toEqual({ ok: false, code: 'missing', reason: 'does not exist' });
  });

  it('rejects a file with "is not a directory"', () => {
    const root = makeDir();
    const file = path.join(root, 'file');
    fs.writeFileSync(file, '');
    expect(canonicalDirectory(file)).toEqual({ ok: false, code: 'not_directory', reason: 'is not a directory' });
  });

  it('rejects a symlink to a file with "is not a directory"', () => {
    const root = makeDir();
    const file = path.join(root, 'file');
    fs.writeFileSync(file, '');
    const link = path.join(root, 'link');
    fs.symlinkSync(file, link);
    expect(canonicalDirectory(link)).toEqual({ ok: false, code: 'not_directory', reason: 'is not a directory' });
  });

  it('rejects a symlink loop with "cannot be resolved: ..."', () => {
    const root = makeDir();
    fs.symlinkSync(path.join(root, 'b'), path.join(root, 'a'));
    fs.symlinkSync(path.join(root, 'a'), path.join(root, 'b'));
    const result = canonicalDirectory(path.join(root, 'a'));
    expect(result).toEqual({ ok: false, code: 'unresolvable', reason: expect.stringMatching(/^cannot be resolved: .+/) });
  });

  it('rejects a path below a file with "cannot be resolved: ..."', () => {
    const root = makeDir();
    fs.writeFileSync(path.join(root, 'file'), '');
    const result = canonicalDirectory(path.join(root, 'file', 'child'));
    expect(result).toEqual({ ok: false, code: 'unresolvable', reason: expect.stringMatching(/^cannot be resolved: .+/) });
  });

  it.skipIf(RUNNING_AS_ROOT)('rejects an unreadable path with "cannot be read"', () => {
    const root = makeDir();
    const locked = path.join(root, 'locked');
    fs.mkdirSync(locked);
    lock(locked);
    expect(canonicalDirectory(locked)).toEqual({ ok: false, code: 'unreadable', reason: 'cannot be read' });
  });

  it.skipIf(RUNNING_AS_ROOT)('rejects a child under an unreadable parent with "cannot be resolved: ..."', () => {
    const root = makeDir();
    const parent = path.join(root, 'parent');
    fs.mkdirSync(path.join(parent, 'child'), { recursive: true });
    lock(parent);
    const result = canonicalDirectory(path.join(parent, 'child'));
    expect(result).toEqual({ ok: false, code: 'unresolvable', reason: expect.stringMatching(/^cannot be resolved: .+/) });
  });
});

const errnoError = (code: string): NodeJS.ErrnoException => Object.assign(new Error(`${code}: injected`), { code });

describe('canonicalDirectory failure codes', () => {
  it('returns code not_absolute for a relative path', () => {
    expect(canonicalDirectory('relative/dir')).toEqual({ ok: false, code: 'not_absolute', reason: 'must be an absolute path' });
  });

  it('returns code missing for a missing path', () => {
    const root = makeDir();
    expect(canonicalDirectory(path.join(root, 'missing'))).toEqual({ ok: false, code: 'missing', reason: 'does not exist' });
  });

  it('returns code not_directory for a file and for a symlink to a file', () => {
    const root = makeDir();
    const file = path.join(root, 'file');
    fs.writeFileSync(file, '');
    const link = path.join(root, 'link');
    fs.symlinkSync(file, link);
    expect(canonicalDirectory(file)).toEqual({ ok: false, code: 'not_directory', reason: 'is not a directory' });
    expect(canonicalDirectory(link)).toEqual({ ok: false, code: 'not_directory', reason: 'is not a directory' });
  });

  it('returns code unresolvable for a symlink loop and for a file in the middle of the path', () => {
    const root = makeDir();
    fs.symlinkSync(path.join(root, 'b'), path.join(root, 'a'));
    fs.symlinkSync(path.join(root, 'a'), path.join(root, 'b'));
    fs.writeFileSync(path.join(root, 'file'), '');
    const unresolvable = { ok: false, code: 'unresolvable', reason: expect.stringMatching(/^cannot be resolved: .+/) };
    expect(canonicalDirectory(path.join(root, 'a'))).toEqual(unresolvable);
    expect(canonicalDirectory(path.join(root, 'file', 'child'))).toEqual(unresolvable);
  });

  it.skipIf(RUNNING_AS_ROOT)('returns code unreadable for a directory with mode 000 and for an injected EACCES', () => {
    const root = makeDir();
    const locked = path.join(root, 'locked');
    fs.mkdirSync(locked);
    lock(locked);
    expect(canonicalDirectory(locked)).toEqual({ ok: false, code: 'unreadable', reason: 'cannot be read' });

    const statTarget = path.join(root, 'stat-eacces');
    fs.mkdirSync(statTarget);
    const realStat = fs.statSync;
    vi.spyOn(fs, 'statSync').mockImplementation(((target: fs.PathLike, options?: fs.StatSyncOptions) => {
      if (String(target) === statTarget) throw errnoError('EACCES');
      return realStat(target, options);
    }) as typeof fs.statSync);
    expect(canonicalDirectory(statTarget)).toEqual({ ok: false, code: 'unreadable', reason: 'cannot be read' });
  });

  it('never throws on a non-transient errno: injected EPERM in stat and ENOTSUP in access become unreadable', () => {
    const root = makeDir();
    const statTarget = path.join(root, 'stat-eperm');
    fs.mkdirSync(statTarget);
    const accessTarget = path.join(root, 'access-enotsup');
    fs.mkdirSync(accessTarget);
    const realStat = fs.statSync;
    const realAccess = fs.accessSync;
    vi.spyOn(fs, 'statSync').mockImplementation(((target: fs.PathLike, options?: fs.StatSyncOptions) => {
      if (String(target) === statTarget) throw errnoError('EPERM');
      return realStat(target, options);
    }) as typeof fs.statSync);
    vi.spyOn(fs, 'accessSync').mockImplementation((target: fs.PathLike, mode?: number) => {
      if (String(target) === accessTarget) throw errnoError('ENOTSUP');
      realAccess(target, mode);
    });
    let results: unknown[] = [];
    expect(() => {
      results = [canonicalDirectory(statTarget), canonicalDirectory(accessTarget)];
    }).not.toThrow();
    expect(results).toEqual([
      { ok: false, code: 'unreadable', reason: 'cannot be read' },
      { ok: false, code: 'unreadable', reason: 'cannot be read' },
    ]);
  });

  it('throws the same error for a transient errno: an injected EMFILE in stat and an injected EIO in access', () => {
    const root = makeDir();
    const statTarget = path.join(root, 'stat-emfile');
    fs.mkdirSync(statTarget);
    const accessTarget = path.join(root, 'access-eio');
    fs.mkdirSync(accessTarget);
    const emfile = errnoError('EMFILE');
    const eio = errnoError('EIO');
    const realStat = fs.statSync;
    const realAccess = fs.accessSync;
    vi.spyOn(fs, 'statSync').mockImplementation(((target: fs.PathLike, options?: fs.StatSyncOptions) => {
      if (String(target) === statTarget) throw emfile;
      return realStat(target, options);
    }) as typeof fs.statSync);
    vi.spyOn(fs, 'accessSync').mockImplementation((target: fs.PathLike, mode?: number) => {
      if (String(target) === accessTarget) throw eio;
      realAccess(target, mode);
    });
    const thrownBy = (action: () => unknown): unknown => {
      try {
        action();
      } catch (error) {
        return error;
      }
      return undefined;
    };
    expect(thrownBy(() => canonicalDirectory(statTarget))).toBe(emfile);
    expect(thrownBy(() => canonicalDirectory(accessTarget))).toBe(eio);
  });

  it.each(['EMFILE', 'EIO'])('throws the same error for a transient %s from realpathSync.native during canonicalPath', (code) => {
    const root = makeDir();
    const target = path.join(root, 'dir');
    fs.mkdirSync(target);
    const injected = errnoError(code);
    const realNative = fs.realpathSync.native;
    vi.spyOn(fs.realpathSync, 'native').mockImplementation(((candidate: fs.PathLike, options?: unknown) => {
      if (String(candidate) === target) throw injected;
      return realNative(candidate, options as never);
    }) as typeof fs.realpathSync.native);
    let thrown: unknown;
    try {
      canonicalDirectory(target);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBe(injected);
  });

  it('returns code unresolvable for ENAMETOOLONG', () => {
    const root = makeDir();
    const result = canonicalDirectory(path.join(root, 'n'.repeat(300)));
    expect(result).toEqual({ ok: false, code: 'unresolvable', reason: expect.stringMatching(/^cannot be resolved: .+/) });
  });

  it('reason strings are unchanged', () => {
    const root = makeDir();
    const file = path.join(root, 'file');
    fs.writeFileSync(file, '');
    const reasons = [canonicalDirectory('relative'), canonicalDirectory(path.join(root, 'missing')), canonicalDirectory(file)].map((result) =>
      result.ok ? undefined : result.reason,
    );
    expect(reasons).toEqual(['must be an absolute path', 'does not exist', 'is not a directory']);
  });
});
