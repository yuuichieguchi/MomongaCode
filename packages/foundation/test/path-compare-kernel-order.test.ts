import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { canonicalPath } from '@momonga/foundation';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const makeDir = (): string => {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'mm-canon-order-')));
  tempDirs.push(dir);
  return dir;
};

const kernelCreate = (input: string): string => {
  fs.writeFileSync(input, 'x');
  return fs.realpathSync.native(input);
};

const expectKernelAgreement = (input: string, kernelTarget: string): void => {
  const predicted = canonicalPath(input);
  const created = kernelCreate(input);
  expect(created).toBe(kernelTarget);
  expect(fs.readFileSync(kernelTarget, 'utf8')).toBe('x');
  expect(predicted).toBe(created);
};

const withDeepSymlink = () => {
  const d = makeDir();
  fs.mkdirSync(path.join(d, 'other', 'deep'), { recursive: true });
  fs.symlinkSync(path.join('other', 'deep'), path.join(d, 's'));
  return d;
};

describe('canonicalPath resolves dotdot after a symlink in kernel order', () => {
  it('follows a dangling link whose relative target is s/../f', () => {
    const d = withDeepSymlink();
    fs.symlinkSync('s/../f', path.join(d, 'link'));
    expectKernelAgreement(path.join(d, 'link'), path.join(d, 'other', 'f'));
    expect(fs.existsSync(path.join(d, 'f'))).toBe(false);
  });

  it('follows a dangling link whose absolute target contains s/..', () => {
    const d = withDeepSymlink();
    fs.symlinkSync(`${d}/s/../f`, path.join(d, 'link'));
    expectKernelAgreement(path.join(d, 'link'), path.join(d, 'other', 'f'));
    expect(fs.existsSync(path.join(d, 'f'))).toBe(false);
  });

  it('follows a chain of dangling links ending in s/../c', () => {
    const d = withDeepSymlink();
    fs.symlinkSync('b', path.join(d, 'a'));
    fs.symlinkSync('s/../c', path.join(d, 'b'));
    expectKernelAgreement(path.join(d, 'a'), path.join(d, 'other', 'c'));
    expect(fs.existsSync(path.join(d, 'c'))).toBe(false);
  });

  it('handles dot components mixed into the link target', () => {
    const d = withDeepSymlink();
    fs.symlinkSync('./s/./../f', path.join(d, 'link'));
    expectKernelAgreement(path.join(d, 'link'), path.join(d, 'other', 'f'));
    expect(fs.existsSync(path.join(d, 'f'))).toBe(false);
  });

  it('handles a link target that passes through dotdot twice from a nested directory', () => {
    const d = makeDir();
    fs.mkdirSync(path.join(d, 'x', 'y', 'z'), { recursive: true });
    fs.mkdirSync(path.join(d, 'n'));
    fs.symlinkSync(path.join(d, 'x', 'y', 'z'), path.join(d, 'n', 's'));
    fs.symlinkSync('s/../../f', path.join(d, 'n', 'link'));
    expectKernelAgreement(path.join(d, 'n', 'link'), path.join(d, 'x', 'f'));
    expect(fs.existsSync(path.join(d, 'f'))).toBe(false);
  });

  it('handles a link reached through a symlinked parent whose target goes up through s twice', () => {
    const d = makeDir();
    fs.mkdirSync(path.join(d, 'real', 'sub'), { recursive: true });
    fs.mkdirSync(path.join(d, 'x', 'y', 'z'), { recursive: true });
    fs.symlinkSync(path.join(d, 'real', 'sub'), path.join(d, 'alias'));
    fs.symlinkSync(path.join(d, 'x', 'y', 'z'), path.join(d, 'real', 'sub', 's'));
    fs.symlinkSync('s/../../f', path.join(d, 'real', 'sub', 'link'));
    expectKernelAgreement(path.join(d, 'alias', 'link'), path.join(d, 'x', 'f'));
    expect(fs.existsSync(path.join(d, 'real', 'f'))).toBe(false);
  });

  it('handles a link target that ends in dotdot', () => {
    const d = withDeepSymlink();
    fs.symlinkSync('s/..', path.join(d, 'up'));
    const input = path.join(d, 'up') + '/newfile';
    expectKernelAgreement(input, path.join(d, 'other', 'newfile'));
  });

  it('handles dotdot after a symlink in the input missing tail', () => {
    const d = withDeepSymlink();
    const input = `${d}/s/../newfile`;
    expectKernelAgreement(input, path.join(d, 'other', 'newfile'));
    expect(fs.existsSync(path.join(d, 'newfile'))).toBe(false);
  });

  it('handles dotdot after a symlink inside a dangling link target that names a missing file in a symlinked dir', () => {
    const d = withDeepSymlink();
    fs.mkdirSync(path.join(d, 'other', 'deep', 'inner'));
    fs.symlinkSync(path.join(d, 'other', 'deep', 'inner'), path.join(d, 't'));
    fs.symlinkSync('t/../../g', path.join(d, 'link'));
    expectKernelAgreement(path.join(d, 'link'), path.join(d, 'other', 'g'));
  });
});

describe('canonicalPath behaviour that must be preserved', () => {
  it('throws on a symlink loop', () => {
    const d = makeDir();
    fs.symlinkSync('b', path.join(d, 'a'));
    fs.symlinkSync('a', path.join(d, 'b'));
    expect(() => canonicalPath(path.join(d, 'a'))).toThrow();
  });

  it('returns an existing file unchanged', () => {
    const d = makeDir();
    fs.writeFileSync(path.join(d, 'f'), 'x');
    expect(canonicalPath(path.join(d, 'f'))).toBe(path.join(d, 'f'));
  });

  it('agrees with the kernel for a missing file under an existing real dir', () => {
    const d = makeDir();
    fs.mkdirSync(path.join(d, 'r'));
    expectKernelAgreement(path.join(d, 'r', 'new'), path.join(d, 'r', 'new'));
  });

  it('agrees with the kernel for a dangling relative link reached through a symlinked parent', () => {
    const d = makeDir();
    fs.mkdirSync(path.join(d, 'real', 'sub'), { recursive: true });
    fs.mkdirSync(path.join(d, 'real', 'target'));
    fs.symlinkSync(path.join(d, 'real', 'sub'), path.join(d, 'alias'));
    fs.symlinkSync(path.join('..', 'target', 'f'), path.join(d, 'real', 'sub', 'link'));
    expectKernelAgreement(path.join(d, 'alias', 'link'), path.join(d, 'real', 'target', 'f'));
  });
});

const expectKernelRefuses = (input: string): void => {
  expect(() => fs.writeFileSync(input, 'x')).toThrow();
  expect(() => canonicalPath(input)).toThrow();
};

describe('canonicalPath honours a trailing slash like the kernel', () => {
  it('throws for a regular file followed by a slash', () => {
    const d = makeDir();
    fs.writeFileSync(path.join(d, 'f'), 'x');
    expect(() => fs.openSync(`${d}/f/`, 'r')).toThrow(expect.objectContaining({ code: 'ENOTDIR' }));
    expectKernelRefuses(`${d}/f/`);
  });

  it('throws for a missing entry followed by a slash', () => {
    const d = makeDir();
    expectKernelRefuses(`${d}/missing/`);
    expect(fs.existsSync(path.join(d, 'missing'))).toBe(false);
  });

  it('returns the directory for an existing directory followed by a slash', () => {
    const d = makeDir();
    fs.mkdirSync(path.join(d, 'dir'));
    expect(canonicalPath(`${d}/dir/`)).toBe(path.join(d, 'dir'));
  });

  it('throws for a symlink whose target ends in a slash and names a file', () => {
    const d = makeDir();
    fs.writeFileSync(path.join(d, 'f'), 'x');
    fs.symlinkSync('f/', path.join(d, 'l'));
    expect(() => fs.openSync(path.join(d, 'l'), 'r')).toThrow();
    expect(() => canonicalPath(path.join(d, 'l'))).toThrow();
  });
});

describe('canonicalPath with an empty symlink target', () => {
  it('throws for the link itself', () => {
    const d = makeDir();
    fs.symlinkSync('', path.join(d, 'e'));
    expectKernelRefuses(path.join(d, 'e'));
  });

  it('throws for a path below the link', () => {
    const d = makeDir();
    fs.symlinkSync('', path.join(d, 'e'));
    expectKernelRefuses(path.join(d, 'e', 'z'));
  });
});
