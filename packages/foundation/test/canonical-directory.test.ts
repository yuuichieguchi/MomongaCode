import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { canonicalDirectory } from '@momonga/foundation';

const tempDirs: string[] = [];
const lockedDirs: string[] = [];

afterEach(() => {
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
    expect(canonicalDirectory('relative/dir')).toEqual({ ok: false, reason: 'must be an absolute path' });
  });

  it('rejects a missing path with "does not exist"', () => {
    const root = makeDir();
    expect(canonicalDirectory(path.join(root, 'missing', 'deeper'))).toEqual({ ok: false, reason: 'does not exist' });
  });

  it('rejects a file with "is not a directory"', () => {
    const root = makeDir();
    const file = path.join(root, 'file');
    fs.writeFileSync(file, '');
    expect(canonicalDirectory(file)).toEqual({ ok: false, reason: 'is not a directory' });
  });

  it('rejects a symlink to a file with "is not a directory"', () => {
    const root = makeDir();
    const file = path.join(root, 'file');
    fs.writeFileSync(file, '');
    const link = path.join(root, 'link');
    fs.symlinkSync(file, link);
    expect(canonicalDirectory(link)).toEqual({ ok: false, reason: 'is not a directory' });
  });

  it('rejects a symlink loop with "cannot be resolved: ..."', () => {
    const root = makeDir();
    fs.symlinkSync(path.join(root, 'b'), path.join(root, 'a'));
    fs.symlinkSync(path.join(root, 'a'), path.join(root, 'b'));
    const result = canonicalDirectory(path.join(root, 'a'));
    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.reason).toMatch(/^cannot be resolved: .+/);
  });

  it('rejects a path below a file with "cannot be resolved: ..."', () => {
    const root = makeDir();
    fs.writeFileSync(path.join(root, 'file'), '');
    const result = canonicalDirectory(path.join(root, 'file', 'child'));
    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.reason).toMatch(/^cannot be resolved: .+/);
  });

  it.skipIf(RUNNING_AS_ROOT)('rejects an unreadable path with "cannot be read"', () => {
    const root = makeDir();
    const locked = path.join(root, 'locked');
    fs.mkdirSync(locked);
    lock(locked);
    expect(canonicalDirectory(locked)).toEqual({ ok: false, reason: 'cannot be read' });
  });

  it.skipIf(RUNNING_AS_ROOT)('rejects a child under an unreadable parent with "cannot be resolved: ..."', () => {
    const root = makeDir();
    const parent = path.join(root, 'parent');
    fs.mkdirSync(path.join(parent, 'child'), { recursive: true });
    lock(parent);
    const result = canonicalDirectory(path.join(parent, 'child'));
    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.reason).toMatch(/^cannot be resolved: .+/);
  });
});
