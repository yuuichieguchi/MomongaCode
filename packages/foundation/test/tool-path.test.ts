import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { displayToolPath, resolveToolPath } from '@momonga/foundation';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const makeRoot = (): string => {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'mm-tool-path-')));
  tempDirs.push(dir);
  return dir;
};

const makeProject = (): { root: string; project: string } => {
  const root = makeRoot();
  const project = path.join(root, 'project');
  fs.mkdirSync(path.join(project, 'src'), { recursive: true });
  fs.writeFileSync(path.join(project, 'src', 'a.ts'), 'a\n');
  return { root, project };
};

describe('resolveToolPath', () => {
  it('resolves a relative path against the working directory', () => {
    expect(resolveToolPath('/work/project', 'src/a.ts')).toBe('/work/project/src/a.ts');
  });

  it('resolves a path that climbs out of the working directory', () => {
    expect(resolveToolPath('/work/project', '../outside/x.txt')).toBe('/work/outside/x.txt');
  });

  it('resolves "." to the working directory itself', () => {
    expect(resolveToolPath('/work/project', '.')).toBe('/work/project');
  });

  it('keeps an absolute path unchanged', () => {
    expect(resolveToolPath('/work/project', '/etc/hosts')).toBe('/etc/hosts');
  });
});

describe('displayToolPath', () => {
  it('shows a path inside the working directory relative to it', () => {
    const { project } = makeProject();
    expect(displayToolPath(project, path.join(project, 'src', 'a.ts'))).toBe('src/a.ts');
  });

  it('shows the working directory itself as "."', () => {
    const { project } = makeProject();
    expect(displayToolPath(project, project)).toBe('.');
  });

  it('shows a path outside the working directory as absolute', () => {
    const { root, project } = makeProject();
    const outside = path.join(root, 'outside.txt');
    fs.writeFileSync(outside, 'o\n');
    expect(displayToolPath(project, outside)).toBe(outside);
  });

  it('shows the parent of the working directory as absolute rather than ".."', () => {
    const { root, project } = makeProject();
    expect(displayToolPath(project, root)).toBe(root);
  });

  it('shows a sibling that shares the working directory name as a prefix as absolute', () => {
    const { root, project } = makeProject();
    const sibling = path.join(root, 'project-other', 'x.txt');
    fs.mkdirSync(path.dirname(sibling), { recursive: true });
    fs.writeFileSync(sibling, 'x\n');
    expect(displayToolPath(project, sibling)).toBe(sibling);
  });

  it('shows a not-yet-existing path inside the working directory relative to it', () => {
    const { project } = makeProject();
    expect(displayToolPath(project, path.join(project, 'new', 'deep.txt'))).toBe('new/deep.txt');
  });

  it('shows a path relative when the working directory is reached through a symlink', () => {
    const { root, project } = makeProject();
    const alias = path.join(root, 'alias');
    fs.symlinkSync(project, alias);
    expect(displayToolPath(alias, path.join(project, 'src', 'a.ts'))).toBe('src/a.ts');
    expect(displayToolPath(alias, path.join(alias, 'src', 'a.ts'))).toBe('src/a.ts');
    expect(displayToolPath(project, path.join(alias, 'src', 'a.ts'))).toBe('src/a.ts');
  });

  it('shows a path relative when the working directory is under the non-canonical temporary directory', () => {
    const viaTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-tool-path-raw-'));
    tempDirs.push(viaTmp);
    fs.writeFileSync(path.join(viaTmp, 'a.txt'), 'a\n');
    const canonical = fs.realpathSync.native(viaTmp);
    expect(displayToolPath(viaTmp, path.join(canonical, 'a.txt'))).toBe('a.txt');
    expect(displayToolPath(canonical, path.join(viaTmp, 'a.txt'))).toBe('a.txt');
  });

  it('shows a symlink inside the working directory that points outside by its own relative path without following it', () => {
    const { root, project } = makeProject();
    const outside = path.join(root, 'outside.txt');
    fs.writeFileSync(outside, 'o\n');
    const link = path.join(project, 'link.txt');
    fs.symlinkSync(outside, link);
    expect(displayToolPath(project, link)).toBe('link.txt');
  });

  it('shows a path under a symlinked directory inside the working directory by its own relative path', () => {
    const { root, project } = makeProject();
    const elsewhere = path.join(root, 'elsewhere');
    fs.mkdirSync(elsewhere);
    fs.symlinkSync(elsewhere, path.join(project, 'linkdir'));
    expect(displayToolPath(project, path.join(project, 'linkdir', 'k'))).toBe('linkdir/k');
  });

  it('compares lexically when the working directory does not exist', () => {
    expect(displayToolPath('/no-such-wd', '/no-such-wd/a.ts')).toBe('a.ts');
    expect(displayToolPath('/no-such-wd', '/no-such-wd')).toBe('.');
    expect(displayToolPath('/no-such-wd', '/elsewhere/a.ts')).toBe('/elsewhere/a.ts');
    expect(displayToolPath('/no-such-wd', '/no-such-wd-sibling/a.ts')).toBe('/no-such-wd-sibling/a.ts');
  });

  it('never shows a path beginning with ".."', () => {
    const { root, project } = makeProject();
    const nested = path.join(project, 'src');
    for (const target of [root, path.join(root, 'elsewhere.txt'), project, path.join(project, 'top.txt')]) {
      expect(displayToolPath(nested, target).startsWith('..')).toBe(false);
    }
  });
});
