import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { UNRESOLVABLE_ERRNO_CODES, resolveCanonicalPath, walkPath } from '@momonga/foundation';
import { EMPTY_SYMLINK_SUPPORTED } from '@momonga/testkit';
import { syncPaths } from '../src/index.ts';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const makeDir = (): string => {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'mm-pres-')));
  tempDirs.push(dir);
  return dir;
};

const errnoError = (code: string): NodeJS.ErrnoException => Object.assign(new Error(`${code}: injected`), { code });

const thrownBy = async (action: () => unknown): Promise<unknown> => {
  try {
    await action();
  } catch (error) {
    return error;
  }
  throw new Error('expected a throw');
};

describe('UNRESOLVABLE_ERRNO_CODES', () => {
  it('holds exactly EACCES, ELOOP, ENAMETOOLONG, ENOTDIR and ENOENT', () => {
    expect([...UNRESOLVABLE_ERRNO_CODES].sort()).toEqual(['EACCES', 'ELOOP', 'ENAMETOOLONG', 'ENOENT', 'ENOTDIR']);
  });
});

describe('resolveCanonicalPath', () => {
  it('returns the canonical path of an existing file', () => {
    const dir = makeDir();
    const file = path.join(dir, 'file.txt');
    fs.writeFileSync(file, 'x');
    fs.symlinkSync(dir, path.join(dir, 'self-dir'));
    expect(syncPaths.resolveCanonicalPath(path.join(dir, 'self-dir', 'file.txt'))).toEqual({ ok: true, path: file });
  });

  it('reports a self-referential symlink as errno ELOOP', () => {
    const dir = makeDir();
    const loop = path.join(dir, 'loop');
    fs.symlinkSync(loop, loop);
    expect(syncPaths.resolveCanonicalPath(path.join(loop, 'x'))).toEqual({ ok: false, reason: { kind: 'errno', code: 'ELOOP' } });
  });

  it('reports a path below a regular file as errno ENOTDIR', () => {
    const dir = makeDir();
    const file = path.join(dir, 'file');
    fs.writeFileSync(file, 'x');
    expect(syncPaths.resolveCanonicalPath(path.join(file, 'child'))).toEqual({ ok: false, reason: { kind: 'errno', code: 'ENOTDIR' } });
  });

  it("reports '..' below a missing component as errno ENOENT", () => {
    const dir = makeDir();
    expect(syncPaths.resolveCanonicalPath(`${dir}/missing/../x`)).toEqual({ ok: false, reason: { kind: 'errno', code: 'ENOENT' } });
  });

  it.each(['EACCES', 'ENAMETOOLONG'])('maps an injected %s to an errno reason', async (code) => {
    const canonicalise = async (): Promise<string> => {
      throw errnoError(code);
    };
    expect(await resolveCanonicalPath('/anything/below', canonicalise)).toEqual({ ok: false, reason: { kind: 'errno', code } });
  });

  it.each(['EMFILE', 'EIO', 'EXDEV'])('rethrows an injected %s unchanged', async (code) => {
    const injected = errnoError(code);
    const canonicalise = async (): Promise<string> => {
      throw injected;
    };
    await expect(resolveCanonicalPath('/anything/below', canonicalise)).rejects.toBe(injected);
  });

  it('rethrows the code-less error for a relative input', async () => {
    const error = await thrownBy(() => syncPaths.resolveCanonicalPath('relative/path'));
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('path must be absolute: relative/path');
    expect((error as NodeJS.ErrnoException).code).toBeUndefined();
  });
});

describe('canonicalPath coded failures', () => {
  it('keeps the loop message and carries ELOOP', async () => {
    const dir = makeDir();
    const loop = path.join(dir, 'loop');
    fs.symlinkSync(loop, loop);
    const input = path.join(loop, 'x');
    const error = await thrownBy(() => syncPaths.canonicalPath(input)) as NodeJS.ErrnoException;
    expect(error.message).toBe(`too many symbolic links resolving ${input}`);
    expect(error.code).toBe('ELOOP');
  });

  it.runIf(EMPTY_SYMLINK_SUPPORTED)('keeps the empty link message and carries ENOENT', async () => {
    const dir = makeDir();
    const empty = path.join(dir, 'empty');
    fs.symlinkSync('', empty);
    const error = await thrownBy(() => syncPaths.canonicalPath(path.join(empty, 'x'))) as NodeJS.ErrnoException;
    expect(error.message).toBe(`empty symbolic link target: ${empty}`);
    expect(error.code).toBe('ENOENT');
  });

  it('keeps the not-a-directory message and carries ENOTDIR', async () => {
    const dir = makeDir();
    const file = path.join(dir, 'file');
    fs.writeFileSync(file, 'x');
    const error = await thrownBy(() => syncPaths.canonicalPath(path.join(file, 'child'))) as NodeJS.ErrnoException;
    expect(error.message).toBe(`not a directory: ${file}`);
    expect(error.code).toBe('ENOTDIR');
  });

  it("keeps the '..' below a missing component message and carries ENOENT", async () => {
    const dir = makeDir();
    const input = `${dir}/missing/../x`;
    const error = await thrownBy(() => syncPaths.canonicalPath(input)) as NodeJS.ErrnoException;
    expect(error.message).toBe(`cannot resolve '..' below a missing component: ${input}`);
    expect(error.code).toBe('ENOENT');
  });

  it('keeps the slash after a missing component message and carries ENOENT', async () => {
    const dir = makeDir();
    const input = `${dir}/missing/x/`;
    const error = await thrownBy(() => syncPaths.canonicalPath(input)) as NodeJS.ErrnoException;
    expect(error.message).toBe(`missing component followed by a slash: ${input}`);
    expect(error.code).toBe('ENOENT');
  });
});

describe('raw step errors propagate unchanged', () => {
  it('lets the exact error object thrown by a walkPath step reach the caller', async () => {
    const thrown = Object.assign(new Error('EACCES: permission denied, lstat'), { code: 'EACCES', syscall: 'lstat', path: '/w/locked/x' });
    const error = await thrownBy(async () =>
      await walkPath(
        '/w/locked/x',
        (absolute) => {
          if (absolute === '/w/locked/x') throw thrown;
          return { kind: 'directory' };
        },
        () => undefined,
      ),
    ) as NodeJS.ErrnoException;
    expect(error).toBe(thrown);
    expect(error.message).toBe('EACCES: permission denied, lstat');
    expect(error.code).toBe('EACCES');
    expect(error.syscall).toBe('lstat');
    expect(error.path).toBe('/w/locked/x');
  });

  it('lets the raw lstat ENAMETOOLONG of the canonicalPath node step escape uncoded', async () => {
    const dir = makeDir();
    const candidate = path.join(dir, 'a'.repeat(300));
    const error = await thrownBy(() => syncPaths.canonicalPath(candidate)) as NodeJS.ErrnoException;
    expect(error.code).toBe('ENAMETOOLONG');
    expect(error.syscall).toBe('lstat');
    expect(error.path).toBe(candidate);
  });
});
