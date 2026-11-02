import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_POINTER_FILE_BYTES } from '@momonga/foundation';
import { createPolicyFilesystem } from '@momonga/tools';

const requireNonRoot = (): void => {
  if (process.getuid?.() === 0) throw new Error('this test needs a non-root user');
};

const tempDirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) {
    for (const locked of [path.join(dir, 'locked')]) if (fs.existsSync(locked)) fs.chmodSync(locked, 0o700);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const makeDir = (): string => {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'mm-pfs-')));
  tempDirs.push(dir);
  return dir;
};

const executable = (file: string): string => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '#!/bin/sh\n', { mode: 0o755 });
  return file;
};

const PATH_METHODS = ['statSync', 'lstatSync', 'openSync', 'readFileSync', 'readdirSync', 'opendirSync', 'readlinkSync', 'accessSync', 'existsSync'] as const;

const injectErrno = (code: string, under: string): void => {
  for (const method of PATH_METHODS) {
    const original = fs[method] as (...args: unknown[]) => unknown;
    vi.spyOn(fs, method).mockImplementation(((...args: unknown[]) => {
      const target = args[0];
      if (typeof target === 'string' && (target === under || target.startsWith(`${under}/`))) {
        throw Object.assign(new Error(`${code}: injected, ${method} '${target}'`), { code, syscall: method, path: target });
      }
      return original.apply(fs, args);
    }) as never);
  }
};

const thrownBy = (action: () => unknown): unknown => {
  try {
    action();
  } catch (error) {
    return error;
  }
  return undefined;
};

const never = (): boolean => false;

describe('resolveProgram walks the search path of the Bash spawn', () => {
  const resolveProgram = (name: string, cwd: string, searchPath: string | undefined, isWritable: (absolute: string) => boolean = never) =>
    createPolicyFilesystem().resolveProgram(name, cwd, searchPath, isWritable);

  it('returns the Apple path for /usr/bin:/bin', () => {
    expect(resolveProgram('ls', makeDir(), '/usr/bin:/bin')).toEqual({ program: '/bin/ls' });
    expect(resolveProgram('sed', makeDir(), '/usr/bin:/bin')).toEqual({ program: '/usr/bin/sed' });
  });

  it('returns none when the search path is undefined', () => {
    expect(resolveProgram('ls', makeDir(), undefined)).toEqual({ none: true });
  });

  it('returns none for an empty entry before /usr/bin when the cwd holds the program', () => {
    const cwd = makeDir();
    executable(path.join(cwd, 'ls'));
    expect(resolveProgram('ls', cwd, ':/usr/bin:/bin')).toEqual({ none: true });
  });

  it('returns none for a relative entry before /bin', () => {
    const cwd = makeDir();
    executable(path.join(cwd, 'bin', 'ls'));
    expect(resolveProgram('ls', cwd, './bin:/bin')).toEqual({ none: true });
  });

  it.each([
    ['<root>/bin', (root: string) => path.join(root, 'bin')],
    ['an absolute <root>/node_modules/.bin', (root: string) => path.join(root, 'node_modules', '.bin')],
    ['the session tmp dir', (root: string) => path.join(root, 'sessions', 'one')],
  ])('returns none for a writable entry %s before /usr/bin even when it holds no sed yet', (_label, entryOf) => {
    const root = makeDir();
    const entry = entryOf(root);
    fs.mkdirSync(entry, { recursive: true });
    const isWritable = (absolute: string): boolean => absolute === root || absolute.startsWith(`${root}/`);
    expect(resolveProgram('sed', root, `${entry}:/usr/bin`, isWritable)).toEqual({ none: true });
  });

  it('admits an entry outside the writable area that holds no sed, such as /opt/homebrew/bin', () => {
    const outside = makeDir();
    expect(resolveProgram('sed', makeDir(), `${outside}:/usr/bin`, never)).toEqual({ program: '/usr/bin/sed' });
  });

  it('returns a non-Apple path for an admissible entry that holds the program', () => {
    const opt = makeDir();
    const found = executable(path.join(opt, 'bin', 'git'));
    expect(resolveProgram('git', makeDir(), `${path.join(opt, 'bin')}:/usr/bin`, never)).toEqual({ program: found });
  });

  it('resolves a relative entry against the cwd parameter', () => {
    const cwd = makeDir();
    const found = executable(path.join(cwd, 'tools', 'mytool'));
    expect(resolveProgram('mytool', cwd, 'tools:/usr/bin')).toEqual({ program: found });
    expect(resolveProgram('mytool', makeDir(), 'tools:/usr/bin')).toEqual({ none: true });
  });

  it('skips an entry that gives ENOTDIR', () => {
    const dir = makeDir();
    const file = path.join(dir, 'file');
    fs.writeFileSync(file, '');
    expect(resolveProgram('ls', dir, `${file}:/bin`)).toEqual({ program: '/bin/ls' });
  });

  it('skips an EACCES entry before the holder and rethrows EIO', () => {
    const dir = makeDir();
    injectErrno('EACCES', path.join(dir, 'denied'));
    expect(resolveProgram('ls', dir, `${path.join(dir, 'denied')}:/bin`)).toEqual({ program: '/bin/ls' });
    vi.restoreAllMocks();
    injectErrno('EIO', path.join(dir, 'broken'));
    const error = thrownBy(() => resolveProgram('ls', dir, `${path.join(dir, 'broken')}:/bin`)) as NodeJS.ErrnoException;
    expect(error?.code).toBe('EIO');
  });

  it('stops at the holder: an EACCES entry after it changes nothing', () => {
    const dir = makeDir();
    injectErrno('EACCES', path.join(dir, 'denied'));
    expect(resolveProgram('ls', dir, `/bin:${path.join(dir, 'denied')}`)).toEqual({ program: '/bin/ls' });
  });

  it('skips a non-executable file in an admissible entry and finds the Apple one', () => {
    const outside = makeDir();
    fs.writeFileSync(path.join(outside, 'sed'), 'x', { mode: 0o644 });
    expect(resolveProgram('sed', makeDir(), `${outside}:/usr/bin`)).toEqual({ program: '/usr/bin/sed' });
  });

  it('keeps the Apple directories exact: /usr/sbin after a writable entry is not Apple', () => {
    const root = makeDir();
    fs.mkdirSync(path.join(root, 'bin'));
    const isWritable = (absolute: string): boolean => absolute.startsWith(root);
    expect(resolveProgram('chown', root, `${path.join(root, 'bin')}:/usr/sbin`, isWritable)).toEqual({ program: '/usr/sbin/chown' });
  });

  it.each([
    ['<root>/bin:/usr/bin/', 'sed', (root: string) => `${root}/bin:/usr/bin/`, (root: string) => root],
    ['.:/bin/', 'ls', () => '.:/bin/', (root: string) => root],
    ['<root>/bin:/usr/local/../bin', 'sed', (root: string) => `${root}/bin:/usr/local/../bin`, (root: string) => root],
    ['. with cwd /usr/bin', 'sed', () => '.', () => '/usr/bin'],
    ['empty with cwd /usr/bin', 'sed', () => '', () => '/usr/bin'],
    ['control <root>/bin:/usr/bin', 'sed', (root: string) => `${root}/bin:/usr/bin`, (root: string) => root],
  ])('gives none for %s', (_label, name, searchPathOf, cwdOf) => {
    const root = makeDir();
    fs.mkdirSync(path.join(root, 'bin'));
    const isWritable = (absolute: string): boolean => absolute.startsWith(root);
    expect(resolveProgram(name, cwdOf(root), searchPathOf(root), isWritable)).toEqual({ none: true });
  });
});

describe('unreadable entries are typed (V13)', () => {
  it('gives Unresolved for a mode 000 .git file and a mode 000 commondir', () => {
    requireNonRoot();
    const dir = makeDir();
    for (const name of ['.git', 'commondir']) {
      const file = path.join(dir, name);
      fs.writeFileSync(file, 'x', { mode: 0o000 });
      expect(createPolicyFilesystem().readEntry(file)).toEqual({ unresolvable: { kind: 'errno', code: 'EACCES' } });
    }
  });

  it('gives Unresolved from readNoFollow when readlink fails with EACCES', () => {
    const dir = makeDir();
    const link = path.join(dir, 'l');
    fs.symlinkSync('x', link);
    const original = fs.readlinkSync;
    vi.spyOn(fs, 'readlinkSync').mockImplementation(((target: fs.PathLike, ...rest: unknown[]) => {
      if (target === link) throw Object.assign(new Error('EACCES: injected'), { code: 'EACCES' });
      return (original as (...args: unknown[]) => unknown)(target, ...rest);
    }) as typeof fs.readlinkSync);
    expect(createPolicyFilesystem().readNoFollow(link)).toEqual({ unresolvable: { kind: 'errno', code: 'EACCES' } });
  });
});

describe('readEntry', () => {
  const filesystem = () => createPolicyFilesystem();

  it('returns absent for ENOENT and ENOTDIR', () => {
    const dir = makeDir();
    fs.writeFileSync(path.join(dir, 'file'), '');
    expect(filesystem().readEntry(path.join(dir, 'missing'))).toEqual({ kind: 'absent' });
    expect(filesystem().readEntry(path.join(dir, 'file', '.git'))).toEqual({ kind: 'absent' });
  });

  it('returns the canonical path of a directory, following a symlink', () => {
    const dir = makeDir();
    fs.mkdirSync(path.join(dir, 'real'));
    fs.symlinkSync(path.join(dir, 'real'), path.join(dir, 'link'));
    expect(filesystem().readEntry(path.join(dir, 'link'))).toEqual({ kind: 'directory', canonical: path.join(dir, 'real') });
  });

  it('reads a regular file up to MAX_POINTER_FILE_BYTES and reports a larger one as oversize', () => {
    const dir = makeDir();
    const atLimit = 'g'.repeat(MAX_POINTER_FILE_BYTES);
    fs.writeFileSync(path.join(dir, 'at-limit'), atLimit);
    fs.writeFileSync(path.join(dir, 'over'), `${atLimit}g`);
    expect(filesystem().readEntry(path.join(dir, 'at-limit'))).toEqual({ kind: 'file', text: atLimit });
    expect(filesystem().readEntry(path.join(dir, 'over'))).toEqual({ kind: 'oversize' });
  });

  it('maps EACCES below a mode 000 directory to Unresolved', () => {
    requireNonRoot();
    const dir = makeDir();
    const locked = path.join(dir, 'locked');
    fs.mkdirSync(locked);
    fs.chmodSync(locked, 0o000);
    expect(filesystem().readEntry(path.join(locked, '.git'))).toEqual({ unresolvable: { kind: 'errno', code: 'EACCES' } });
  });

  it('maps ELOOP to Unresolved', () => {
    const dir = makeDir();
    fs.symlinkSync(path.join(dir, 'loop'), path.join(dir, 'loop'));
    expect(filesystem().readEntry(path.join(dir, 'loop'))).toEqual({ unresolvable: { kind: 'errno', code: 'ELOOP' } });
  });

  it('rethrows EIO unchanged', () => {
    const dir = makeDir();
    const target = path.join(dir, '.git');
    injectErrno('EIO', target);
    const error = thrownBy(() => filesystem().readEntry(target)) as NodeJS.ErrnoException;
    expect(error?.code).toBe('EIO');
    expect(error?.path).toBe(target);
  });
});

describe('readNoFollow', () => {
  const filesystem = () => createPolicyFilesystem();

  it('reports missing, symlink, directory and other entries without following a link', () => {
    const dir = makeDir();
    fs.mkdirSync(path.join(dir, 'd'));
    fs.writeFileSync(path.join(dir, 'f'), '');
    fs.symlinkSync('../elsewhere', path.join(dir, 'l'));
    expect(filesystem().readNoFollow(path.join(dir, 'missing'))).toEqual({ kind: 'missing' });
    expect(filesystem().readNoFollow(path.join(dir, 'l'))).toEqual({ kind: 'symlink', target: '../elsewhere' });
    expect(filesystem().readNoFollow(path.join(dir, 'd'))).toEqual({ kind: 'directory' });
    expect(filesystem().readNoFollow(path.join(dir, 'f'))).toEqual({ kind: 'other' });
  });

  it('maps ENOTDIR to Unresolved and rethrows EIO', () => {
    const dir = makeDir();
    fs.writeFileSync(path.join(dir, 'f'), '');
    expect(filesystem().readNoFollow(path.join(dir, 'f', 'x'))).toEqual({ unresolvable: { kind: 'errno', code: 'ENOTDIR' } });
    injectErrno('EIO', path.join(dir, 'broken'));
    expect((thrownBy(() => filesystem().readNoFollow(path.join(dir, 'broken'))) as NodeJS.ErrnoException)?.code).toBe('EIO');
  });
});

describe('expandGlob', () => {
  const filesystem = () => createPolicyFilesystem();

  it('expands like the shell: a leading * does not match dotfiles', () => {
    const dir = makeDir();
    for (const name of ['a.md', 'b.md', '.hidden.md', 'c.txt']) fs.writeFileSync(path.join(dir, name), '');
    const result = filesystem().expandGlob('*.md', dir, 1000);
    expect('matches' in result ? [...result.matches].map((match) => path.resolve(dir, match)).sort() : result).toEqual([path.join(dir, 'a.md'), path.join(dir, 'b.md')]);
  });

  it('returns no match for a pattern directory that does not exist', () => {
    expect(filesystem().expandGlob('missing/*.md', makeDir(), 1000)).toEqual({ matches: [] });
  });

  it('overflows when more than limit paths match, and not at the limit', () => {
    const dir = makeDir();
    for (let index = 0; index < 4; index += 1) fs.writeFileSync(path.join(dir, `f${index}.md`), '');
    expect(filesystem().expandGlob('*.md', dir, 3)).toEqual({ overflow: true });
    expect(filesystem().expandGlob('*.md', dir, 4)).toEqual({ matches: ['f0.md', 'f1.md', 'f2.md', 'f3.md'] });
  });

  it('sees a directory the shell cannot open as the shell does: no match', () => {
    requireNonRoot();
    const dir = makeDir();
    const locked = path.join(dir, 'locked');
    fs.mkdirSync(locked);
    fs.chmodSync(locked, 0o000);
    expect(filesystem().expandGlob('locked/*', dir, 1000)).toEqual({ matches: [] });
  });

  it('keeps a backslash-escaped bracket literal and expands a POSIX class', () => {
    const dir = makeDir();
    for (const name of ['[a]b', 'ab', 'lnk']) fs.writeFileSync(path.join(dir, name), '');
    expect(filesystem().expandGlob('\\[a\\]*', dir, 1000)).toEqual({ matches: ['[a]b'] });
    expect(filesystem().expandGlob('l[[:alpha:]]k', dir, 1000)).toEqual({ matches: ['lnk'] });
  });

  it('treats a range that is out of order as a word without matches instead of failing', () => {
    const dir = makeDir();
    fs.writeFileSync(path.join(dir, 'a'), '');
    expect(filesystem().expandGlob('[z-a]*', dir, 1000)).toEqual({ matches: [] });
  });

  it('matches what the shell matches for a leading dot, whichever bash version runs', () => {
    const dir = makeDir();
    fs.mkdirSync(path.join(dir, 'sub'));
    fs.writeFileSync(path.join(dir, '.hidden'), '');
    const result = filesystem().expandGlob('.*', dir, 1000);
    const shell = spawnSync('/bin/bash', ['-c', 'shopt -s nullglob; printf "%s\\n" .*'], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    expect('matches' in result ? result.matches : result).toEqual(shell.stdout.split('\n').filter((entry) => entry !== ''));
  });

  it('cannot determine the matches when no bash is found for the platform', () => {
    const withoutBash = createPolicyFilesystem('win32', { isExecutable: never, env: {} });
    expect(withoutBash.expandGlob('*', makeDir(), 1000)).toEqual({ unresolvable: { kind: 'dynamic' } });
  });
});

describe('readHead and isSearchable answer as git does', () => {
  it.each([
    ['a symbolic ref', 'ref: refs/heads/main\n', 'text'],
    ['a long file read only to its first 255 bytes', `ref: refs/heads/main\n${'#'.repeat(70_000)}`, 'text'],
  ])('reads %s', (_label, content, kind) => {
    const dir = makeDir();
    fs.writeFileSync(path.join(dir, 'HEAD'), content);
    const head = createPolicyFilesystem().readHead(path.join(dir, 'HEAD'));
    expect(head.kind).toBe(kind);
    expect(head.kind === 'text' ? head.text.length : 0).toBe(Math.min(255, content.length));
  });

  it('reads a symlink as its target, and a directory or a missing file as invalid', () => {
    const dir = makeDir();
    fs.symlinkSync('refs/heads/main', path.join(dir, 'HEAD'));
    fs.mkdirSync(path.join(dir, 'dir'));
    expect(createPolicyFilesystem().readHead(path.join(dir, 'HEAD'))).toEqual({ kind: 'symlink', target: 'refs/heads/main' });
    expect(createPolicyFilesystem().readHead(path.join(dir, 'dir'))).toEqual({ kind: 'invalid' });
    expect(createPolicyFilesystem().readHead(path.join(dir, 'missing'))).toEqual({ kind: 'invalid' });
  });

  it('is searchable for any entry with the execute bit, as access(X_OK) says, and not for one without', () => {
    const dir = makeDir();
    fs.writeFileSync(path.join(dir, 'exec'), '', { mode: 0o755 });
    fs.writeFileSync(path.join(dir, 'plain'), '', { mode: 0o644 });
    fs.mkdirSync(path.join(dir, 'directory'));
    const filesystem = createPolicyFilesystem();
    expect(filesystem.isSearchable(path.join(dir, 'exec'))).toBe(true);
    expect(filesystem.isSearchable(path.join(dir, 'directory'))).toBe(true);
    expect(filesystem.isSearchable(path.join(dir, 'plain'))).toBe(false);
    expect(filesystem.isSearchable(path.join(dir, 'missing'))).toBe(false);
  });
});

describe('canonicalise', () => {
  it('behaves as resolveCanonicalPath for a missing tail', () => {
    const dir = makeDir();
    expect(createPolicyFilesystem().canonicalise(path.join(dir, 'a', 'b'))).toEqual({ ok: true, path: path.join(dir, 'a', 'b') });
  });
});
