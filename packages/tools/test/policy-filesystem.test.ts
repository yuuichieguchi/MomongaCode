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

  it('returns the system path of the first directory that holds the program for /usr/bin:/bin', () => {
    for (const name of ['ls', 'sed']) {
      const holder = ['/usr/bin', '/bin'].find((directory) => fs.existsSync(path.join(directory, name))) as string;
      expect(resolveProgram(name, makeDir(), '/usr/bin:/bin')).toEqual({ program: path.join(holder, name) });
    }
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
    const sbinProgram = fs.readdirSync('/usr/sbin').find((name) => fs.statSync(path.join('/usr/sbin', name), { throwIfNoEntry: false })?.isFile() === true) as string;
    expect(resolveProgram(sbinProgram, root, `${path.join(root, 'bin')}:/usr/sbin`, isWritable)).toEqual({ program: path.join('/usr/sbin', sbinProgram) });
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
  const noAbort = new AbortController().signal;
  const filesystem = () => {
    const host = createPolicyFilesystem();
    return { expandGlob: (pattern: string, cwd: string, limit: number, deadline: { remainingMs: () => number }) => host.expandGlob(pattern, cwd, limit, deadline, noAbort) };
  };
  const open = { remainingMs: () => 60_000 };

  it('expands like the shell: a leading * does not match dotfiles', async () => {
    const dir = makeDir();
    for (const name of ['a.md', 'b.md', '.hidden.md', 'c.txt']) fs.writeFileSync(path.join(dir, name), '');
    const result = await filesystem().expandGlob('*.md', dir, 1000, open);
    expect('matches' in result ? [...result.matches].map((match) => path.resolve(dir, match)).sort() : result).toEqual([path.join(dir, 'a.md'), path.join(dir, 'b.md')]);
  });

  it('returns no match for a pattern directory that does not exist', async () => {
    expect(await filesystem().expandGlob('missing/*.md', makeDir(), 1000, open)).toEqual({ matches: [] });
  });

  it('returns no match when the working directory itself does not exist', async () => {
    expect(await filesystem().expandGlob('*', path.join(makeDir(), 'gone'), 1000, open)).toEqual({ matches: [] });
  });

  it('overflows when more than limit paths match, and not at the limit', async () => {
    const dir = makeDir();
    for (let index = 0; index < 4; index += 1) fs.writeFileSync(path.join(dir, `f${index}.md`), '');
    expect(await filesystem().expandGlob('*.md', dir, 3, open)).toEqual({ overflow: true });
    expect(await filesystem().expandGlob('*.md', dir, 4, open)).toEqual({ matches: ['f0.md', 'f1.md', 'f2.md', 'f3.md'] });
  });

  it('sees a directory the shell cannot open as the shell does: no match', async () => {
    requireNonRoot();
    const dir = makeDir();
    const locked = path.join(dir, 'locked');
    fs.mkdirSync(locked);
    fs.chmodSync(locked, 0o000);
    expect(await filesystem().expandGlob('locked/*', dir, 1000, open)).toEqual({ matches: [] });
  });

  it('keeps a backslash-escaped bracket literal and expands a POSIX class', async () => {
    const dir = makeDir();
    for (const name of ['[a]b', 'ab', 'lnk']) fs.writeFileSync(path.join(dir, name), '');
    expect(await filesystem().expandGlob('\\[a\\]*', dir, 1000, open)).toEqual({ matches: ['[a]b'] });
    expect(await filesystem().expandGlob('l[[:alpha:]]k', dir, 1000, open)).toEqual({ matches: ['lnk'] });
  });

  it('treats a range that is out of order as a word without matches instead of failing', async () => {
    const dir = makeDir();
    fs.writeFileSync(path.join(dir, 'a'), '');
    expect(await filesystem().expandGlob('[z-a]*', dir, 1000, open)).toEqual({ matches: [] });
  });

  it('matches what the shell matches for a leading dot, whichever bash version runs', async () => {
    const dir = makeDir();
    fs.mkdirSync(path.join(dir, 'sub'));
    fs.writeFileSync(path.join(dir, '.hidden'), '');
    const result = await filesystem().expandGlob('.*', dir, 1000, open);
    const shell = spawnSync('/bin/bash', ['-c', 'shopt -s nullglob; printf "%s\\n" .*'], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    expect('matches' in result ? result.matches : result).toEqual(shell.stdout.split('\n').filter((entry) => entry !== ''));
  });

  it('cannot determine the matches when no bash is found for the platform', async () => {
    const withoutBash = createPolicyFilesystem('win32', { isExecutable: never, env: {} });
    expect(await withoutBash.expandGlob('*', makeDir(), 1000, open, noAbort)).toEqual({ unresolvable: { kind: 'dynamic' } });
  });

  it('yields to the event loop while the shell expands, so a heartbeat timer can fire', async () => {
    const dir = makeDir();
    fs.writeFileSync(path.join(dir, 'a'), '');
    const order: string[] = [];
    const pending = filesystem()
      .expandGlob('*', dir, 1000, open)
      .then(() => order.push('expanded'));
    setImmediate(() => order.push('event loop turn'));
    await pending;
    expect(order).toEqual(['event loop turn', 'expanded']);
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

describe('readHead and isSearchable pass over what git passes over and rethrow the rest (item 8)', () => {
  it.each(['EACCES', 'ELOOP', 'ENAMETOOLONG'])('reads %s on HEAD as invalid, as real git passes over such a layout', (code) => {
    const dir = makeDir();
    const head = path.join(dir, 'HEAD');
    injectErrno(code, head);
    expect(createPolicyFilesystem().readHead(head)).toEqual({ kind: 'invalid' });
  });

  it.each(['EIO', 'EMFILE', 'ENFILE'])('rethrows %s from HEAD unchanged', (code) => {
    const dir = makeDir();
    const head = path.join(dir, 'HEAD');
    injectErrno(code, head);
    expect((thrownBy(() => createPolicyFilesystem().readHead(head)) as NodeJS.ErrnoException)?.code).toBe(code);
  });

  it.each(['EIO', 'EMFILE', 'ENFILE'])('rethrows %s from objects unchanged', (code) => {
    const dir = makeDir();
    const objects = path.join(dir, 'objects');
    injectErrno(code, objects);
    expect((thrownBy(() => createPolicyFilesystem().isSearchable(objects)) as NodeJS.ErrnoException)?.code).toBe(code);
  });

  it('is not searchable for objects below a directory that cannot be searched, as real git passes over such a layout', () => {
    requireNonRoot();
    const dir = makeDir();
    const locked = path.join(dir, 'locked');
    fs.mkdirSync(locked);
    fs.chmodSync(locked, 0o000);
    expect(createPolicyFilesystem().isSearchable(path.join(locked, 'objects'))).toBe(false);
  });

  it.each(['ELOOP', 'ENAMETOOLONG'])('is not searchable for objects that give %s', (code) => {
    const dir = makeDir();
    const objects = path.join(dir, 'objects');
    injectErrno(code, objects);
    expect(createPolicyFilesystem().isSearchable(objects)).toBe(false);
  });

  it('control: ENOENT and ENOTDIR on HEAD mean no repository', () => {
    const dir = makeDir();
    fs.writeFileSync(path.join(dir, 'file'), '');
    expect(createPolicyFilesystem().readHead(path.join(dir, 'missing'))).toEqual({ kind: 'invalid' });
    expect(createPolicyFilesystem().readHead(path.join(dir, 'file', 'HEAD'))).toEqual({ kind: 'invalid' });
  });
});

describe('pointer files and link targets keep the bytes (review item 10)', () => {
  const invalid = Buffer.from([0x67, 0x69, 0x74, 0x64, 0x69, 0x72, 0x3a, 0x20, 0x2e, 0x2e, 0x2f, 0x65, 0x76, 0x69, 0x6c, 0xff]);

  it('reads a pointer file whose bytes are not UTF-8 as dynamic, and one that is UTF-8 as text', () => {
    const dir = makeDir();
    fs.writeFileSync(path.join(dir, 'bad'), invalid);
    fs.writeFileSync(path.join(dir, 'good'), 'gitdir: ../é\n');
    const filesystem = createPolicyFilesystem();
    expect(filesystem.readEntry(path.join(dir, 'bad'))).toEqual({ unresolvable: { kind: 'dynamic' } });
    expect(filesystem.readEntry(path.join(dir, 'good'))).toEqual({ kind: 'file', text: 'gitdir: ../é\n' });
  });

  it('reads a link target whose bytes are not UTF-8 as dynamic', () => {
    const dir = makeDir();
    const link = path.join(dir, 'link');
    fs.symlinkSync('plain', link);
    const original = fs.readlinkSync as (...args: unknown[]) => unknown;
    vi.spyOn(fs, 'readlinkSync').mockImplementation(((target: unknown, options: unknown) =>
      target === link && options === 'buffer' ? Buffer.from([0x6c, 0xff]) : original(target, options)) as never);
    expect(createPolicyFilesystem().readNoFollow(link)).toEqual({ unresolvable: { kind: 'dynamic' } });
  });

  it('control: a UTF-8 link target is read as before', () => {
    const dir = makeDir();
    fs.symlinkSync('é/target', path.join(dir, 'link'));
    expect(createPolicyFilesystem().readNoFollow(path.join(dir, 'link'))).toEqual({ kind: 'symlink', target: 'é/target' });
  });
});

describe('canonicalise', () => {
  it('behaves as resolveCanonicalPath for a missing tail', () => {
    const dir = makeDir();
    expect(createPolicyFilesystem().canonicalise(path.join(dir, 'a', 'b'))).toEqual({ ok: true, path: path.join(dir, 'a', 'b') });
  });
});
