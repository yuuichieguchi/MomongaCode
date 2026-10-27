import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { UNRESOLVABLE_ERRNO_CODES, canonicalPath, resolveCanonicalPath } from '@momonga/foundation';

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

const thrownBy = (action: () => unknown): unknown => {
  try {
    action();
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
    expect(resolveCanonicalPath(path.join(dir, 'self-dir', 'file.txt'))).toEqual({ ok: true, path: file });
  });

  it('reports a self-referential symlink as errno ELOOP', () => {
    const dir = makeDir();
    const loop = path.join(dir, 'loop');
    fs.symlinkSync(loop, loop);
    expect(resolveCanonicalPath(path.join(loop, 'x'))).toEqual({ ok: false, reason: { kind: 'errno', code: 'ELOOP' } });
  });

  it('reports a path below a regular file as errno ENOTDIR', () => {
    const dir = makeDir();
    const file = path.join(dir, 'file');
    fs.writeFileSync(file, 'x');
    expect(resolveCanonicalPath(path.join(file, 'child'))).toEqual({ ok: false, reason: { kind: 'errno', code: 'ENOTDIR' } });
  });

  it("reports '..' below a missing component as errno ENOENT", () => {
    const dir = makeDir();
    expect(resolveCanonicalPath(`${dir}/missing/../x`)).toEqual({ ok: false, reason: { kind: 'errno', code: 'ENOENT' } });
  });

  it.each(['EACCES', 'ENAMETOOLONG'])('maps an injected %s to an errno reason', (code) => {
    const canonicalise = (): string => {
      throw errnoError(code);
    };
    expect(resolveCanonicalPath('/anything/below', canonicalise)).toEqual({ ok: false, reason: { kind: 'errno', code } });
  });

  it.each(['EMFILE', 'EIO', 'EXDEV'])('rethrows an injected %s unchanged', (code) => {
    const injected = errnoError(code);
    const canonicalise = (): string => {
      throw injected;
    };
    expect(thrownBy(() => resolveCanonicalPath('/anything/below', canonicalise))).toBe(injected);
  });

  it('rethrows the code-less error for a relative input', () => {
    const error = thrownBy(() => resolveCanonicalPath('relative/path'));
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('path must be absolute: relative/path');
    expect((error as NodeJS.ErrnoException).code).toBeUndefined();
  });
});

describe('canonicalPath coded failures', () => {
  it('keeps the loop message and carries ELOOP', () => {
    const dir = makeDir();
    const loop = path.join(dir, 'loop');
    fs.symlinkSync(loop, loop);
    const input = path.join(loop, 'x');
    const error = thrownBy(() => canonicalPath(input)) as NodeJS.ErrnoException;
    expect(error.message).toBe(`too many symbolic links resolving ${input}`);
    expect(error.code).toBe('ELOOP');
  });

  it('keeps the empty link message and carries ENOENT', () => {
    const dir = makeDir();
    const empty = path.join(dir, 'empty');
    fs.symlinkSync('', empty);
    const error = thrownBy(() => canonicalPath(path.join(empty, 'x'))) as NodeJS.ErrnoException;
    expect(error.message).toBe(`empty symbolic link target: ${empty}`);
    expect(error.code).toBe('ENOENT');
  });

  it('keeps the not-a-directory message and carries ENOTDIR', () => {
    const dir = makeDir();
    const file = path.join(dir, 'file');
    fs.writeFileSync(file, 'x');
    const error = thrownBy(() => canonicalPath(path.join(file, 'child'))) as NodeJS.ErrnoException;
    expect(error.message).toBe(`not a directory: ${file}`);
    expect(error.code).toBe('ENOTDIR');
  });

  it("keeps the '..' below a missing component message and carries ENOENT", () => {
    const dir = makeDir();
    const input = `${dir}/missing/../x`;
    const error = thrownBy(() => canonicalPath(input)) as NodeJS.ErrnoException;
    expect(error.message).toBe(`cannot resolve '..' below a missing component: ${input}`);
    expect(error.code).toBe('ENOENT');
  });

  it('keeps the slash after a missing component message and carries ENOENT', () => {
    const dir = makeDir();
    const input = `${dir}/missing/x/`;
    const error = thrownBy(() => canonicalPath(input)) as NodeJS.ErrnoException;
    expect(error.message).toBe(`missing component followed by a slash: ${input}`);
    expect(error.code).toBe('ENOENT');
  });
});
