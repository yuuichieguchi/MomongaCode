import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { displayToolPath, resolveToolPath } from '@momonga/foundation';
import { testPaths } from '@momonga/testkit';

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
  it('shows a path inside the working directory relative to it', async () => {
    const { project } = makeProject();
    expect(await displayToolPath(project, path.join(project, 'src', 'a.ts'), testPaths())).toBe('src/a.ts');
  });

  it('shows the working directory itself as "."', async () => {
    const { project } = makeProject();
    expect(await displayToolPath(project, project, testPaths())).toBe('.');
  });

  it('shows a path outside the working directory as absolute', async () => {
    const { root, project } = makeProject();
    const outside = path.join(root, 'outside.txt');
    fs.writeFileSync(outside, 'o\n');
    expect(await displayToolPath(project, outside, testPaths())).toBe(outside);
  });

  it('shows the parent of the working directory as absolute rather than ".."', async () => {
    const { root, project } = makeProject();
    expect(await displayToolPath(project, root, testPaths())).toBe(root);
  });

  it('shows a sibling that shares the working directory name as a prefix as absolute', async () => {
    const { root, project } = makeProject();
    const sibling = path.join(root, 'project-other', 'x.txt');
    fs.mkdirSync(path.dirname(sibling), { recursive: true });
    fs.writeFileSync(sibling, 'x\n');
    expect(await displayToolPath(project, sibling, testPaths())).toBe(sibling);
  });

  it('shows a not-yet-existing path inside the working directory relative to it', async () => {
    const { project } = makeProject();
    expect(await displayToolPath(project, path.join(project, 'new', 'deep.txt'), testPaths())).toBe('new/deep.txt');
  });

  it('shows a path relative when the working directory is reached through a symlink', async () => {
    const { root, project } = makeProject();
    const alias = path.join(root, 'alias');
    fs.symlinkSync(project, alias);
    expect(await displayToolPath(alias, path.join(project, 'src', 'a.ts'), testPaths())).toBe('src/a.ts');
    expect(await displayToolPath(alias, path.join(alias, 'src', 'a.ts'), testPaths())).toBe('src/a.ts');
    expect(await displayToolPath(project, path.join(alias, 'src', 'a.ts'), testPaths())).toBe('src/a.ts');
  });

  it('shows a path relative when the working directory is under the non-canonical temporary directory', async () => {
    const viaTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-tool-path-raw-'));
    tempDirs.push(viaTmp);
    fs.writeFileSync(path.join(viaTmp, 'a.txt'), 'a\n');
    const canonical = fs.realpathSync.native(viaTmp);
    expect(await displayToolPath(viaTmp, path.join(canonical, 'a.txt'), testPaths())).toBe('a.txt');
    expect(await displayToolPath(canonical, path.join(viaTmp, 'a.txt'), testPaths())).toBe('a.txt');
  });

  it('shows a symlink inside the working directory that points outside by its own relative path without following it', async () => {
    const { root, project } = makeProject();
    const outside = path.join(root, 'outside.txt');
    fs.writeFileSync(outside, 'o\n');
    const link = path.join(project, 'link.txt');
    fs.symlinkSync(outside, link);
    expect(await displayToolPath(project, link, testPaths())).toBe('link.txt');
  });

  it('shows a path under a symlinked directory inside the working directory by its own relative path', async () => {
    const { root, project } = makeProject();
    const elsewhere = path.join(root, 'elsewhere');
    fs.mkdirSync(elsewhere);
    fs.symlinkSync(elsewhere, path.join(project, 'linkdir'));
    expect(await displayToolPath(project, path.join(project, 'linkdir', 'k'), testPaths())).toBe('linkdir/k');
  });

  it('compares lexically when the working directory does not exist', async () => {
    expect(await displayToolPath('/no-such-wd', '/no-such-wd/a.ts', testPaths())).toBe('a.ts');
    expect(await displayToolPath('/no-such-wd', '/no-such-wd', testPaths())).toBe('.');
    expect(await displayToolPath('/no-such-wd', '/elsewhere/a.ts', testPaths())).toBe('/elsewhere/a.ts');
    expect(await displayToolPath('/no-such-wd', '/no-such-wd-sibling/a.ts', testPaths())).toBe('/no-such-wd-sibling/a.ts');
  });

  it('never shows a path beginning with ".."', async () => {
    const { root, project } = makeProject();
    const nested = path.join(project, 'src');
    for (const target of [root, path.join(root, 'elsewhere.txt'), project, path.join(project, 'top.txt')]) {
      expect((await displayToolPath(nested, target, testPaths())).startsWith('..')).toBe(false);
    }
  });
});
